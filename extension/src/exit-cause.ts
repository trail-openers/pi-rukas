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
 * process level: a signal listener (the signal, which) and a stdin `end`
 * listener (stdin EOF) are armed at `armExitCause`, which the extension calls
 * on `session_start`. Whatever fires first is remembered; the `session_shutdown`
 * hook reads it and prints it next to the reason. A quit that none of these
 * explains is reported as `unknown` — which is still an answer, naming the
 * gap, instead of another bare `quit`.
 *
 * The tracking is deliberately process-scoped and never reset on purpose
 * (like session-shutdown.ts): a signal or a dead stdin cannot arrive after the
 * session is already shutting down, so a stale value can never mislead a new
 * session — and a reload gets a fresh process anyway.
 */

/** The origin the extension can actually observe, or `unknown`. */
export type ExitOrigin =
  | "stdin-eof" // stdin reached EOF: the caller closed its input
  | `signal:${string}` // a signal killed the process (SIGHUP, SIGINT, SIGTERM, …)
  | "unknown"; // nothing explained it — Pi's own exit, or an unobservable quit

let origin: ExitOrigin | undefined;

/** The remembered origin, or `unknown` while the session lives (before any exit). */
export function exitOrigin(): string {
  return origin ?? "unknown";
}

/** The first origin that fires wins; later ones are ignored. */
function record(o: ExitOrigin): void {
  if (origin === undefined) origin = o;
}

let armed = false;

/**
 * Arm the process-level origin trackers. Idempotent — the extension calls it
 * once on `session_start`; a second call must not double-arm the listeners.
 */
export function armExitCause(): void {
  if (armed) return;
  armed = true;
  process.stdin.on("end", () => record("stdin-eof"));
  process.on("SIGINT", () => record("signal:SIGINT"));
  process.on("SIGTERM", () => record("signal:SIGTERM"));
  process.on("SIGHUP", () => record("signal:SIGHUP"));
}

/** Test-only: the offline suite shares one module instance across cases. */
export function resetExitCauseForTesting(): void {
  origin = undefined;
}

/** Test-only: record an origin directly (the real one needs a signal or a closed stdin). */
export function recordExitCauseForTesting(o: ExitOrigin): void {
  record(o);
}
