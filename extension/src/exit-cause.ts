/**
 * exit-cause — where a `session_shutdown` actually came from.
 *
 * Pi's `session_shutdown` event carries only a coarse `reason` (`quit`,
 * `reload`, …). That does not say WHAT closed the session: an operator typing
 * `/quit` in the TUI, an RPC `quit` command, a closed stdin, a signal (which
 * one), or Pi exiting on its own. The one line the driver prints on shutdown
 * (`[pi-rukas] session_shutdown (reason: quit): …`) showed only `quit`, so an
 * operator reading a headless log could not tell a self-quit from a signal
 * from a dead pipe (tehas #61 / #97: a session quit mid-cycle with no trigger
 * in the log, and nothing to say where the quit came from).
 *
 * The origin is not in Pi's event payload, so this module tracks it at the
 * process level: a signal listener per `TRACKED_SIGNALS` (the signal, which)
 * and a stdin `end` listener (stdin EOF) are armed at `armExitCause`, which the
 * extension calls when it is registered. Whatever fires first is remembered;
 * the `session_shutdown` hook reads it and prints it next to the reason. A
 * quit that none of these explains is reported as `unknown` — which is still an
 * answer, naming the gap, instead of another bare `quit`.
 *
 * Three things the listeners alone cannot do, all from ordering or disposition:
 *
 * - **Arming is at registration, not `session_start`.** In `pi --mode rpc`
 *   the driver never emits `session_start` before the first shutdown, so a
 *   `session_start`-only arm would leave the trackers disarmed for the whole
 *   life of a headless session — the exact session shape whose quit the
 *   operator cannot explain.
 * - **stdin EOF is read, not just listened for.** Pi's own stdin `end`
 *   listener (rpc-mode.js) is registered before the extension's — Pi reads
 *   stdin to receive commands — and it calls `shutdown()`, which awaits
 *   `runtimeHost.dispose()` (the `session_shutdown` emit) from inside that
 *   first listener. So the extension's own `end` listener may still be queued
 *   when the hook fires, and `origin` is then undefined. `exitOrigin` therefore
 *   also consults `process.stdin.readableEnded`, the flag Node sets on the
 *   stream itself: it is already true when Pi's listener runs, so the origin is
 *   correct whichever listener reaches the read first. (Listener order alone is
 *   not a safe assumption either — bun delivers the remaining `end` listeners
 *   even after an earlier one calls `process.exit()`.)
 * - **Listening must not change what a signal DOES.** Installing a listener
 *   replaces the signal's default disposition, and SIGINT / SIGTERM / SIGHUP
 *   are fatal by default. A tracker that only recorded the origin would make
 *   `kill <pi>` no longer kill Pi — the very operator action whose effect it
 *   exists to report. So each handler records the origin and, when this
 *   module's listener is the ONLY one for that signal, removes itself and
 *   re-raises, so the kernel's fatal disposition runs. Once anyone else in the
 *   process handles the signal the tracker stays out of the way entirely.
 *   (The disposition Node hands a `process.on` handler is the one the process
 *   had when it started, so an inherited-ignore still stays ignore — the
 *   re-raise is what a process that had nothing to do with the signal would
 *   have got, which is the claim being preserved.)
 *
 * **The stdin case is bounded to a pipe or socket.** A closed stdin is only a
 * cause when there was a caller who could close it: `pi --mode rpc` is fed by a
 * parent on a pipe, and that parent going away is the event worth naming. When
 * fd 0 is `/dev/null` or a closed file descriptor — which is what `stdio:
 * "ignore"` and a shell's `< /dev/null` produce — "stdin reached EOF" is the
 * shape the session was BORN in, not something that happened to it, and
 * attributing a shutdown to it would blame a dead pipe for a quit a signal or a
 * self-exit actually caused. `callerClosableStdin()` therefore checks `fstat`
 * on fd 0 once, at arm time, and requires a FIFO or a socket; both the read and
 * the listener honour it. Anything the check cannot answer (an fstat failure,
 * an absent `process.stdin`) is treated as NOT caller-closable — the origin
 * degrades to `unknown`, which names the gap instead of inventing a cause.
 *
 * The tracking is deliberately process-scoped and never reset on purpose
 * (like session-shutdown.ts): a signal or a dead stdin cannot arrive after the
 * session is already shutting down, so a stale value can never mislead a new
 * session — and a reload gets a fresh process anyway.
 */

import { fstatSync } from "node:fs";
// The vocabulary is owned by the schema layer, not by the tracker that happens
// to produce it: the validator reads the same tuple to reject an origin no
// tracker could have written (workflow-state-events-exit-origin.ts).
import { type ExitOrigin, TRACKED_SIGNALS } from "./workflow-state-events-exit-origin.ts";

// Re-exported so callers that name the type (session-shutdown.ts,
// workflow-state-events.ts, work-driver-shutdown.ts) import it from the module
// that documents the mechanism, while the definition stays single-sourced.
export type { ExitOrigin } from "./workflow-state-events-exit-origin.ts";

let origin: ExitOrigin | undefined;

/**
 * Whether fd 0 is something a caller can close, decided ONCE at arm time.
 * `false` until then — a read before arming must not report `stdin-eof` from
 * a stream nobody was watching.
 */
let stdinIsCallerClosable = false;

/**
 * Is stdin a pipe or socket — i.e. is there a caller on the other end that
 * could close it? `fstatSync` throws on a closed fd 0, and `process.stdin` can
 * be absent under an unusual stdio; both mean "cannot answer", which is `false`
 * (see the header): an unanswerable question must not produce a confident cause.
 */
function callerClosableStdin(): boolean {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

/**
 * The remembered origin, or `unknown` while the session lives (before any exit).
 *
 * The stdin-EOF case is read from the stream rather than waited for: Pi's own
 * `end` listener can reach the shutdown hook before this module's listener has
 * fired, so `origin` may still be undefined at the moment it is read.
 * `readableEnded` is Node's own record that the stream finished, and it needs
 * no listener of ours to have run — which is also the only thing that makes
 * this case testable without depending on listener ordering. Gated on the same
 * pipe-or-socket answer as the listener, so a born-EOF stdin is not a cause on
 * either path.
 */
export function exitOrigin(): ExitOrigin {
  if (origin !== undefined) return origin;
  return stdinIsCallerClosable && process.stdin?.readableEnded === true ? "stdin-eof" : "unknown";
}

/** The first origin that fires wins; later ones are ignored. */
function record(o: ExitOrigin): void {
  if (origin === undefined) origin = o;
}

/**
 * Re-raise `sig` with the default fatal disposition after recording it.
 *
 * Installing a listener is what stops the signal killing the process, so the
 * tracker has to hand the disposition back — but only when it is the sole
 * listener. With another handler installed the process has decided to survive
 * that signal and this module must not kill it; with none, removing ours and
 * re-raising reproduces exactly what would have happened had the tracker never
 * armed. `process.kill(pid, sig)` is how you make the kernel deliver it again
 * (throwing would be caught by an error handler; `process.exit` would lose the
 * signal's exit status).
 */
function restoreDefaultDisposition(sig: NodeJS.Signals): void {
  if (process.listenerCount(sig) === 1) {
    process.removeListener(sig, handlerFor(sig));
    process.kill(process.pid, sig);
  }
}

let armed = false;

/** The single handler per signal, kept so re-raise can remove exactly ours. */
const signalHandlers = new Map<string, () => void>();

function handlerFor(sig: string): () => void {
  const existing = signalHandlers.get(sig);
  if (existing) return existing;
  const handler = () => {
    record(`signal:${sig}` as ExitOrigin);
    restoreDefaultDisposition(sig as NodeJS.Signals);
  };
  signalHandlers.set(sig, handler);
  return handler;
}

/**
 * Arm the process-level origin trackers. Idempotent — the extension calls it
 * once at registration; a second call must not double-arm the listeners.
 */
export function armExitCause(): void {
  if (armed) return;
  armed = true;
  // Computed once: fd 0's type does not change over the life of the process,
  // and an fstat per shutdown read would only add a failure mode.
  stdinIsCallerClosable = callerClosableStdin();
  if (stdinIsCallerClosable) {
    process.stdin.on("end", () => record("stdin-eof"));
  }
  for (const sig of TRACKED_SIGNALS) {
    process.on(sig, handlerFor(sig));
  }
}

/** Test-only: the offline suite shares one module instance across cases. */
export function resetExitCauseForTesting(): void {
  origin = undefined;
}

/** Test-only: record an origin directly (the real one needs a signal or a closed stdin). */
export function recordExitCauseForTesting(o: ExitOrigin): void {
  record(o);
}
