/**
 * work-driver-step-notice — #799 (F2): the per-step operator notice.
 *
 * A single dispatch can run for hours while doing real work — the issue
 * #799 incident measured a lens-fix dispatch that produced three commits in
 * its run with no signal in the event log the whole time. The fix is
 * observability, not a bound: when a step's wall-clock elapsed time crosses a
 * threshold materially above the healthy band, the operator's
 * `PI_ENSEMBLE_NOTIFY_CMD` hook (work-notify.ts) is invoked **once** with a
 * "running-slow" notice naming the step and its elapsed time. It never
 * kills, never parks, never changes the cycle outcome — the hook fails open
 * in every direction (missing binary, non-zero exit, hang) and the notice
 * is an observer of the run, not a gate on it.
 *
 * Design points, all load-bearing:
 *
 *   - **Per STEP, not per child.** The #799 correction section established
 *     that the incident's silent span was a fan-out whose children were each
 *     individually healthy (19–73 min). A notice keyed on single-child
 *     elapsed would not have fired on the real incident and would have
 *     alarmed on every healthy develop fan-out. The unit of notice is the
 *     step's wall-clock span.
 *   - **Fire once.** One crossing earns one notice. The armed timer is
 *     cleared at step end, and the fired flag is process-local — a
 *     re-entered step (crash-resume) is a fresh run and may notice again.
 *   - **Threshold above the healthy band.** Healthy develop fan-out children
 *     run 19–73 min; the 36–42 min median cycle is the normal shape. The
 *     default of 90 min sits above every measured healthy dispatch in the
 *     project, so a normal cycle never notifies.
 *     `PI_ENSEMBLE_STEP_NOTICE_MS` overrides it (0 disables).
 *   - **Injectable clock.** The check compares against `now()` each arming,
 *     not `Date.now()`, so a test drives the elapsed time deterministically
 *     with no wall-clock hazard (the offline suite never sleeps on a 90-min
 *     threshold).
 *   - **Non-blocking.** The timer sits beside the dispatch's await; it never
 *     delays the step, never throws, and a notify failure is swallowed by
 *     the existing hook contract.
 */

import { trace } from "./trace.ts";
import { type Notification, notify, notifyCommand } from "./work-notify.ts";
import type { WorkState } from "./workflow-state.ts";

/** The operator's notice threshold in ms, defaulting to 90 min (see file
 * header for why it sits above the healthy band). `PI_ENSEMBLE_STEP_NOTICE_MS`
 * overrides; `=0` disables the notice entirely (a non-finite threshold). */
export function stepNoticeThresholdMs(): number {
  const v = process.env.PI_ENSEMBLE_STEP_NOTICE_MS;
  if (v === "0") return Number.POSITIVE_INFINITY;
  // Strip underscores so "1_000_000" parses as 1000000, not 1 (parseInt
  // stops at the first underscore).
  const n = Number.parseInt((v ?? "").replace(/_/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 90 * 60 * 1000;
}

export interface StepNoticeParams {
  state: WorkState;
  /** The step being run (named in the notice so the operator sees WHICH step). */
  step: string;
  /** Wall-clock moment the step began. */
  startedAt: number;
  /** Injectable clock — `Date.now` in production, a controllable value in
   * the offline suite. */
  now?: () => number;
  /** Injectable timer so a test can arm/tick without waiting on real time.
   * Returns the matching cancel. Defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Injectable notify (defaults to work-notify's `notify`). The hook's
   * fails-open contract is the whole safety story; this seam lets a test
   * assert on the exact Notification that would have been sent. */
  notifyFn?: (n: Notification, spawnFn?: unknown) => Promise<{ sent: boolean; reason?: string }>;
}

/** Format the elapsed span the way an operator reads it: `1h 02m` / `45m`. */
function fmtSpan(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${m}m`;
}

/**
 * Arm the per-step notice for a step that may run past the threshold.
 *
 * Returns a cancel function the caller MUST invoke when the step ends
 * (success, failure, or park): it clears the pending timer and sets the
 * fired flag, so a step that finishes before the threshold never notifies.
 *
 * Never throws, never blocks. Returns a no-op cancel when the notice is
 * disabled or the hook is unset (byte-identical to pre-#799).
 */
export function armStepNotice(p: StepNoticeParams): () => void {
  const threshold = stepNoticeThresholdMs();
  if (!Number.isFinite(threshold)) return () => {};
  if (!notifyCommand()) return () => {};
  const now = p.now ?? Date.now;
  const notifyFn = p.notifyFn ?? notify;
  const schedule =
    p.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
  let fired = false;
  let cancel: () => void = () => {};
  const doFire = async () => {
    if (fired) return;
    fired = true;
    const ms = now() - p.startedAt;
    if (ms < threshold) return;
    const n: Notification = {
      kind: "running-slow",
      issues: [p.state.issue],
      reason: `${p.step} still running at ${fmtSpan(ms)}`,
      action: `check #${p.state.issue} with /work-status, or dispatch_peek the running job`,
    };
    const r = await notifyFn(n);
    if (!r.sent) trace(`work-driver: step-notice did not deliver — ${r.reason}`);
  };
  const tick = () => {
    if (fired) return;
    const done = now() - p.startedAt;
    if (done < threshold) {
      // Not yet — re-arm for the remaining window. Cancellation (step end)
      // makes the next tick a no-op.
      cancel = schedule(tick, threshold - done);
      return;
    }
    void doFire();
  };
  cancel = schedule(tick, Math.max(0, threshold - (now() - p.startedAt)));
  return () => {
    fired = true;
    cancel();
  };
}
