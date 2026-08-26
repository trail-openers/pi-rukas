/**
 * spawn-caps — the #543 F1/F6 dispatch-cap machinery for a single spawn.
 * Split out of spawn.ts (AGENTS.md §12 file-size limit).
 *
 * Both caps steer the child through the driver's steer seam (F2) and kill
 * through the SAME kill machinery the inactivity watchdog uses: SIGTERM +
 * 5s SIGKILL, with the structured cause set BEFORE the kill, so
 * DispatchResult.killCause, lastActivity and the stderr attribution line
 * follow #296's structured-kill contract. killCause priority
 * (resolveKillCause): loop > inactivity > token-budget > timeout > abort —
 * the most specific wins (the #296 invariant; #296's three values are
 * untouched). A budget-killed child that ALSO tripped the wall-clock
 * backstop is a token-budget kill, not a timeout: the attribution drives
 * retry semantics AND which env override the operator should read, and the
 * budget is the more specific diagnosis of what actually cost the money.
 *
 * `capsOn` is false for ops-role children (deterministic git/gh — capping
 * them manufactures partial-state incidents) and when
 * PI_ENSEMBLE_DISPATCH_CAPS=0 (master switch, F7e inertness: no timers, no
 * new killCauses, no steers).
 */

import type { ChildProcess } from "node:child_process";
import type { SteerSource } from "./dispatch-steer.ts";
import { type LoopDetector, createLoopDetector, loopDetectorEnabled } from "./loop-detector.ts";
import type { PiContentBlock } from "./pi-event-shapes.ts";
import type { LoopObserver } from "./progress.ts";
import { TokenBudgetTracker } from "./spawn-support.ts";
import { turnNudgeEnabled, turnNudgeText, turnNudgeThreshold } from "./turn-nudge.ts";
import type { DispatchResult } from "./types.ts";

/** The shared kill: SIGTERM + 5s SIGKILL escalation. */
function killChild(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}

/**
 * #543 — killCause priority: loop > inactivity > token-budget > timeout >
 * abort (the most specific wins — the #296 invariant; #296's three values are
 * untouched).
 *
 * NOTE — ordering of token-budget vs timeout is a deliberate DEVIATION from
 * the literal spec sentence ("loop > inactivity > timeout > abort"): a
 * budget-killed child that ALSO tripped the wall-clock backstop must be
 * attributed to token-budget (its retry semantics and env override differ —
 * PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>, not PI_ENSEMBLE_SPAWN_TIMEOUT_MS), and the
 * budget is the more specific diagnosis of what actually cost the money.
 */
export function resolveKillCause(facts: {
  loopKilled: boolean;
  inactivityKilled: boolean;
  timedOut: boolean;
  tokenBudgetKilled: boolean;
  aborted: boolean;
}): DispatchResult["killCause"] {
  if (facts.loopKilled) return "loop";
  if (facts.inactivityKilled) return "inactivity";
  // C1 — token-budget is checked BEFORE timeout: a child killed by its
  // token budget that also outlived the wall-clock backstop is a
  // token-budget kill (see the module doc + the doc comment above).
  if (facts.tokenBudgetKilled) return "token-budget";
  if (facts.timedOut) return "timeout";
  if (facts.aborted) return "abort";
  return undefined;
}

/**
 * #543 — the post-exit cap-kill attribution. Called after the child's `exit`:
 * populates `killCause` + the structured trigger evidence
 * (`loopEvidence` / `tokenBudget`) from the cap session, so the stderr
 * attribution line and the DispatchResult follow #296's structured-kill
 * contract. `appendStderr` receives the human-readable kill lines; the
 * evidence counters are snapshotted at kill time inside the session.
 */
export function capKillAttribution(
  caps: CapSession,
  spec: { role: string },
  totalTokens: number,
  appendStderr: (s: string) => void,
  result: DispatchResult,
): void {
  if (caps.loopKilled()) {
    const ev = caps.loopEvidence();
    appendStderr(
      `\n[pi-ensemble] killed: loop detected (${ev?.tool ?? "unknown"} repeated ${ev?.count ?? 0} times after normalization; override: PI_ENSEMBLE_DISPATCH_CAPS / PI_ENSEMBLE_CAP_KILL_GRACE_MS)`,
    );
  }
  if (caps.tokenBudgetTracker?.killed) {
    appendStderr(
      `\n[pi-ensemble] killed: token budget exceeded (${totalTokens} tokens used; override: PI_ENSEMBLE_TOKEN_BUDGET_${spec.role.toUpperCase()})`,
    );
  }
  const killCause = caps.killCause();
  if (killCause) {
    result.killCause = killCause;
    if (killCause === "loop") {
      const ev = caps.loopEvidence();
      if (ev) result.loopEvidence = ev;
    }
    if (killCause === "token-budget") {
      // The tracker's budget + the used count are the PAIR the kill fired
      // on: the budget the tracker was armed with, the token total its
      // check() read when it triggered. Attribution records exactly that
      // pair — not a re-read of the role env (a mid-spawn env mutation
      // could desync it from what actually killed the child).
      const tracker = caps.tokenBudgetTracker;
      if (tracker) {
        result.tokenBudget = { budget: tracker.budgetTokens, used: totalTokens };
      }
    }
  }
}

export interface CapSession {
  /** The F1 observer passed to `ingestEvent` (undefined when the loop
   * detector is disabled / ops-role / master switch off). */
  loopObserver?: LoopObserver;
  /** The F6 tracker; call `check`/`onMessageEnd` on every assistant turn end. */
  tokenBudgetTracker?: TokenBudgetTracker;
  /** True when the F1 loop kill fired. */
  loopKilled(): boolean;
  /**
   * Structured trigger evidence (snapshot taken at kill time; the live
   * detector keeps counting past the kill). Absent until the kill fires.
   */
  loopEvidence(): { tool: string; count: number } | undefined;
  /** #543 (spawn#6) test seam — the fingerprint the armed kill is tracking. */
  loopArmedFingerprint(): string | undefined;
  /** #546 AC4 — the soft turn-count nudge (undefined when off, when there is
   * no `onSteer` seam, or when no `turns` counter was provided). No-op safe.
   * Called from `spawn.ts` on every assistant turn end. Fires at most once
   * per dispatch, at the first turn ≥ `turnNudgeAt()`. Steer-only: it never
   * contributes to `killCause`. */
  turnNudge?: (turn: number) => void;
  /** The single structured kill cause, by priority (loop first). */
  killCause(): DispatchResult["killCause"];
  /** Tear down the grace-window timers (call in the finally block). */
  cleanup(): void;
}

export interface CapSessionOpts {
  role: string;
  child: ChildProcess;
  /** Steering seam (F2); undefined for callers without a job (lens /
   * adversarial children bypass the registry — budget default-OFF makes the
   * absence a no-op for them). */
  onSteer?: (message: string, source: SteerSource) => void;
  totalTokens: () => number;
  timedOut: () => boolean;
  inactivityKilled: () => boolean;
  aborted: () => boolean;
  capKillGraceMs: number;
  /**
   * #546 AC4 — the soft turn-count nudge's turn counter. `spawn.ts` passes
   * `() => runningState.turns`; absent (or `turnNudgeAt() === 0`) makes the
   * nudge inert. Defined on the interface so callers and tests construct the
   * same opts shape; the implementation treats absence as off.
   */
  turns?: () => number;
  /**
   * #543 H1 — grace-window kill race: set the moment the child's exit is
   * OBSERVED (before `once(child, "exit")` resolves, so the poll cannot slip
   * in between). A self-exiting child must not be marked cap-killed: the
   * kill would be a no-op on a dead process, but `loopKilled` / the tracker's
   * `killed` would still flip and mark a normally-completed child as a cap
   * failure. Both grace polls consult this before killing.
   */
  childExited: () => boolean;
}

/** Build the per-spawn cap session. Cheap: all state is per-spawn local. */
export function createCapSession(opts: CapSessionOpts): CapSession {
  const capsOn = process.env.PI_ENSEMBLE_DISPATCH_CAPS !== "0" && opts.role !== "ops";
  const graceMs = opts.capKillGraceMs;
  let loopDetector: LoopDetector | undefined;
  let loopKilled = false;
  let loopKillArmed = false;
  let loopKillArmedAt = 0;
  // #543 (spawn#6) — a DISTINCT fingerprint arriving after trigger resets the
  // grace clock, aligning with the budget tracker's onMessageEnd reset: the
  // spec's deferral is "while no new message_end has arrived since trigger",
  // and a different call is new work — the loop may have ended, and the kill
  // would discard in-progress work on it (the #296 false-positive shape).
  let armedFingerprint: string | undefined;
  // #543 (spawn#7) — the streak evidence is snapshotted at kill time: the
  // detector's `current()` keeps counting past the kill (a turn may still be
  // landing), so reading it later would report a count the cap never saw.
  let loopEvidenceAtKill: { tool: string; count: number } | undefined;
  const loops = () => {
    if (loopKilled || opts.childExited()) return; // H1 — the child is already gone
    loopKilled = true;
    const ev = loopDetector?.current();
    if (ev) loopEvidenceAtKill = { tool: ev.tool, count: ev.count };
    killChild(opts.child);
  };
  if (capsOn && loopDetectorEnabled()) {
    loopDetector = createLoopDetector();
  }
  const loopGracePoll =
    capsOn && graceMs > 0 && loopDetector
      ? setInterval(() => {
          if (
            loopKillArmed &&
            !loopKilled &&
            !opts.childExited() &&
            Date.now() - loopKillArmedAt >= graceMs
          ) {
            loops();
          }
        }, 500)
      : undefined;
  loopGracePoll?.unref();

  const tracker =
    capsOn && opts.onSteer
      ? new TokenBudgetTracker(
          opts.role,
          opts.onSteer,
          // H1 — same race as the loop kill: the tracker kills on its own
          // schedule, so gate the kill on the child's observed exit too.
          () => {
            if (!opts.childExited()) killChild(opts.child);
          },
          opts.totalTokens,
          graceMs,
        )
      : undefined;
  const tokenBudgetTracker = tracker;

  // #546 AC4 — the soft turn-count nudge (opt-in, `turnNudgeAt() > 0`).
  // Steer-only: it never kills, so it is exempt from the #543 capsOn gating
  // (ops-role children get it too — a long ops run is where a status line is
  // cheapest to write) and from the loop detector's independent toggle.
  // `onSteer` is undefined for callers without a job (lens / adversarial
  // children bypass the registry), which keeps the nudge a no-op there.
  let turnNudged = false;
  const turnNudge =
    opts.onSteer && opts.turns
      ? (turn: number): void => {
          if (turnNudged) return;
          // Read the env var directly (not via turnNudgeAt) so the closure
          // sees the CURRENT value at call time. turnNudgeAt() reads
          // process.env.PI_ENSEMBLE_TURN_NUDGE at module scope, which Bun's
          // TS transpiler can hoist into a stale snapshot captured at
          // construction time — a per-call read here is the same pattern
          // loopDetectorEnabled() already uses.
          const threshold = turnNudgeThreshold();
          if (threshold === 0 || turn < threshold) return;
          turnNudged = true;
          try {
            opts.onSteer?.(turnNudgeText(turn), "driver-turn-nudge");
          } catch {
            /* child already gone — the nudge is soft; nothing else to do */
          }
        }
      : undefined;

  const budgetGracePoll =
    capsOn && graceMs > 0 && tokenBudgetTracker
      ? setInterval(() => tokenBudgetTracker.poll(), 500)
      : undefined;
  budgetGracePoll?.unref();

  return {
    loopObserver: loopDetector
      ? (blocks: PiContentBlock[], turn: number): void => {
          // #543 (spawn#6) — a new (possibly distinct) message_end while the
          // kill is armed but not yet fired defers the grace window: it is
          // new work the in-flight kill would discard. A distinct fingerprint
          // may even have ended the loop (the streak reset upstream).
          if (loopKillArmed && !loopKilled) loopKillArmedAt = Date.now();
          const ev = loopDetector.observe(blocks, turn);
          if (!ev) return;
          if (ev.kind === "steer") {
            // F1 — one steer per dispatch; the kill fires regardless of
            // whether the child heeded it. steer is courtesy, kill is the
            // cap — with grace=0 both land in the same tick by design.
            try {
              opts.onSteer?.(ev.text, "driver-loop-detector");
            } catch {
              /* child already gone — the kill below still fires */
            }
          } else if (graceMs > 0) {
            // Grace window: a long tool call still running at trigger time may
            // settle; the kill fires once the window elapses (the poll above).
            loopKillArmed = true;
            loopKillArmedAt = Date.now();
            armedFingerprint = ev.fingerprint;
          } else {
            loops();
          }
        }
      : undefined,
    tokenBudgetTracker,
    loopKilled: () => loopKilled,
    loopEvidence: () => loopEvidenceAtKill,
    loopArmedFingerprint: () => (loopKillArmed ? armedFingerprint : undefined),
    turnNudge,
    killCause: () =>
      resolveKillCause({
        loopKilled,
        inactivityKilled: opts.inactivityKilled(),
        timedOut: opts.timedOut(),
        tokenBudgetKilled: tokenBudgetTracker?.killed ?? false,
        aborted: opts.aborted(),
      }),
    cleanup: () => {
      if (loopGracePoll) clearInterval(loopGracePoll);
      if (budgetGracePoll) clearInterval(budgetGracePoll);
    },
  };
}
