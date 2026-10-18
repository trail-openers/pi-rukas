/**
 * spawn-watchdog — the per-spawn kill plumbing that lives around
 * `createCapSession`, extracted from `spawnSpecialistInner`.
 * Split out of spawn.ts (AGENTS.md §12 file-size limit; #1470).
 *
 * spawn.ts sat at exactly 500 of the 500-line hard limit, so the next piece of
 * wiring at the cap-session call site had no room and was being implemented as
 * a comment hoist instead of a real change. This module is the honest
 * headroom: the kill-flag declarations, the observed-exit listeners, the
 * 12-field `createCapSession` options object, the wall-clock backstop and the
 * AbortSignal arm all moved here as EXECUTABLE STATEMENTS, not as commentary.
 *
 * Two seams, deliberately kept apart because the ordering between them is
 * load-bearing:
 *
 *   1. `declareKillFlags` — the six mutable kill flags, returned as
 *      getter/setter closures. The spawn body reads them AFTER
 *      `await once(child, "exit")` (the stderr attribution lines, `killCause`,
 *      `killBudgetMs`, `lastActivity`), so a snapshot at construction would
 *      silently lose every kill. `createCapSession` reads them by closure, so
 *      they must exist before step 2 runs.
 *   2. `armCapSession` — attaches the `exit` / `close` listeners and builds the
 *      cap session (spawn-caps.ts). Callers must run this BEFORE
 *      `createInterface`, because the stdout line handler references `caps` on
 *      the first stdout line: a `const caps` initialised after the attach would
 *      be in the TDZ for any early line (ReferenceError).
 *
 * What deliberately stays in spawn.ts, and why:
 *   - the inactivity poll (`createInactivityPoll`, spawn-inflight.ts). Its
 *     `onKill` is what WRITES the kill flags; keeping the writer next to the
 *     readers in the report tail is the shape `test-cancel.ts` probes offline.
 *   - the in-flight tool-call state and the silence-shape counters
 *     (`lastActivityKind` / `stdoutLines`): `test-kill-attribution.ts` pins
 *     those tokens to spawn.ts source text — the shape of the silence is
 *     attributed where the lines actually arrive.
 */

import type { ChildProcess } from "node:child_process";
import type { SteerSource } from "./dispatch-steer.ts";
import type { RunningState } from "./progress.ts";
import type { RoleName } from "./roles.ts";
import { type CapSession, createCapSession } from "./spawn-caps.ts";
import { killProcessTree } from "./spawn-kill.ts";
import { capKillGraceMs } from "./spawn-support.ts";

/**
 * The mutable kill flags of one spawn, exposed as accessor closures over the
 * caller's own `let` bindings so every read sees the current value.
 *
 * Each pair (`flags.timedOut()` / `flags.setTimedOut(true)`) is the exact
 * counterpart of a `let` in `spawnSpecialistInner`; both the cap session's
 * grace-window guards and the post-exit report tail go through the getter.
 */
export interface KillFlags {
  /** The wall-clock backstop fired (SPAWN_BACKSTOP_MS). */
  timedOut(): boolean;
  setTimedOut(v: boolean): void;
  /** #296 — the model-silence arm of the inactivity poll fired. */
  inactivityKilled(): boolean;
  setInactivityKilled(v: boolean): void;
  /** #951 — the in-flight-tool silence kill: a toolCall's result never
   * arrived, and the silence outlasted the tool-inactivity bound. */
  toolInactivityKilled(): boolean;
  setToolInactivityKilled(v: boolean): void;
  /** #951 — the budget that actually fired (set by the inactivity poll's
   * onKill callback; the active bound, since exactly one is armed per poll). */
  killedBudgetMs(): number;
  setKilledBudgetMs(v: number): void;
  /** Pi's user-cancel (Esc) signal propagated to the child. */
  aborted(): boolean;
  setAborted(v: boolean): void;
  /** #543 H1 — the child's exit has been OBSERVED (see `armCapSession`). */
  childExited(): boolean;
  setChildExited(v: boolean): void;
}

/**
 * Declare the six kill flags every spawn reports with. Fresh per call — the
 * state is per-spawn and must not outlive the child.
 */
export function declareKillFlags(): KillFlags {
  let timedOut = false;
  let inactivityKilled = false;
  let toolInactivityKilled = false;
  let killedBudgetMs = 0;
  let aborted = false;
  let childExited = false;
  return {
    timedOut: () => timedOut,
    setTimedOut: (v) => {
      timedOut = v;
    },
    inactivityKilled: () => inactivityKilled,
    setInactivityKilled: (v) => {
      inactivityKilled = v;
    },
    toolInactivityKilled: () => toolInactivityKilled,
    setToolInactivityKilled: (v) => {
      toolInactivityKilled = v;
    },
    killedBudgetMs: () => killedBudgetMs,
    setKilledBudgetMs: (v) => {
      killedBudgetMs = v;
    },
    aborted: () => aborted,
    setAborted: (v) => {
      aborted = v;
    },
    childExited: () => childExited,
    setChildExited: (v) => {
      childExited = v;
    },
  };
}

/**
 * Attach the observed-exit listeners and build the cap session.
 *
 * #543 H1 — grace-window kill race: `exit` / `close` set `childExited`
 * immediately, before the caller's `once(child, "exit")` await can resolve.
 * The guard relies on the `exit` event's ordering (it fires before the process
 * is reaped); `close` is belt-and-braces — it fires only after `exit`, once
 * stdio is fully drained. Both listeners are attached HERE, before
 * `createCapSession` runs, so a grace poll can never observe a dead child with
 * the flag still false.
 *
 * #543 F1/F6 — the cap session (spawn-caps.ts) owns the per-spawn
 * detector/tracker state, the grace-window timers and the killCause priority
 * (loop > inactivity = tool-inactivity > token-budget > timeout > abort — the
 * most specific wins). `capKillGraceMs()` is read exactly ONCE here and handed
 * to the session, which passes it to both caps — a per-poll re-read would let
 * a mid-spawn env mutation desync the token-budget grace window.
 */
export function armCapSession(
  child: ChildProcess,
  flags: KillFlags,
  session: {
    role: RoleName;
    /** Steering seam (F2); undefined for callers without a job. */
    onSteer?: (message: string, source: SteerSource) => void;
    runningState: RunningState;
  },
): CapSession {
  child.on("exit", () => {
    flags.setChildExited(true);
  });
  child.on("close", () => {
    flags.setChildExited(true);
  });
  return createCapSession({
    role: session.role,
    child,
    onSteer: session.onSteer,
    totalTokens: () => session.runningState.totalTokens,
    timedOut: flags.timedOut,
    inactivityKilled: flags.inactivityKilled,
    toolInactivityKilled: flags.toolInactivityKilled,
    aborted: flags.aborted,
    capKillGraceMs: capKillGraceMs(),
    childExited: flags.childExited,
    turns: () => session.runningState.turns,
  });
}

/** The stderr attribution lines of the watchdog kills, after the child exited. */
export function appendKillLines(
  flags: KillFlags,
  timeoutMs: number,
  appendStderr: (s: string) => void,
): void {
  if (flags.timedOut()) {
    appendStderr(`\n[pi-rukas] killed after ${timeoutMs}ms timeout`);
  }
  if (flags.inactivityKilled()) {
    appendStderr(`\n[pi-rukas] killed after ${flags.killedBudgetMs()}ms inactivity`);
  }
  if (flags.toolInactivityKilled()) {
    appendStderr(
      `\n[pi-rukas] killed after ${flags.killedBudgetMs()}ms with a tool call in flight (tool-inactivity)`,
    );
  }
  if (flags.aborted()) {
    appendStderr("\n[pi-rukas] cancelled by user (Esc)");
  }
}

/**
 * The wall-clock backstop: always armed, always capped. A stalled child without
 * a timeout hangs the parent indefinitely (observed in the wild: overnight
 * stuck session). The backstop only catches runaway loops; the inactivity
 * watchdog in spawn.ts is what detects true hangs, and it does so without a
 * view on how fast the child's model happens to be.
 *
 * Sets the `timedOut` flag BEFORE the kill so the report tail can attribute the
 * death, then group-kills: SIGTERM, then SIGKILL if the tree ignores SIGTERM
 * (#1024).
 */
export function armWallClockBackstop(child: ChildProcess, flags: KillFlags, timeoutMs: number) {
  return setTimeout(() => {
    flags.setTimedOut(true);
    // Group kill: SIGTERM, then SIGKILL if the tree ignores SIGTERM (#1024).
    killProcessTree(child);
  }, timeoutMs);
}

/**
 * Propagate Pi's user-cancel (Esc) signal: kill the child so the tool
 * execute promise resolves and Pi un-stuck immediately.
 *
 * Returns the detach half of the caller's `finally` block. An already-aborted
 * signal kills immediately, matching the pre-extraction inline arm.
 */
export function armAbortSignal(
  child: ChildProcess,
  flags: KillFlags,
  signal: AbortSignal | undefined,
): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => {
    flags.setAborted(true);
    killProcessTree(child);
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return () => signal.removeEventListener("abort", onAbort);
}
