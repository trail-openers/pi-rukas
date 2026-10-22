/**
 * work-driver-deadline — the caller-set whole-cycle deadline (#1238).
 *
 * The driver bounds steps (spawn backstop, inactivity, verify, handoff, the
 * 90-min review loop) but had no bound for the cycle as a whole, and no way
 * for the caller to give it one. An unattended caller has to bound the cycle
 * itself — orchard does it with a 6-hour `docker stop`, which lands MID-STEP:
 * aborted jobs, state left at `status: running`, no handoff, no comment
 * (example-owner/orchard#47/#61, #119).
 *
 * This is the driver-side half: the caller sets `PI_ENSEMBLE_CYCLE_DEADLINE`
 * (an absolute epoch ms) or `PI_ENSEMBLE_CYCLE_BUDGET_MS` (resolved to an
 * epoch once, then persisted in `pipelineState.cycleDeadlineMs`).
 *
 * Semantics: the deadline is where step work ends; only the handoff runs
 * after it. The caller sets it to its hard kill minus its handoff allowance
 * and passes that allowance as `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` (#1593, the
 * example-owner/orchard#355 contract), so the handoff has the allowance to itself.
 *
 * - Step work ends at `deadline − handoff grace`; what is left before that
 *   is the step's useful time. At each step boundary the driver parks with
 *   cap `deadline` (and routes to handoff) once no useful time is left.
 * - Partial fit (#1567 item 6, #1447/#1547): develop and lens-fix need at
 *   least 15 min of useful time, a lens round 10 min. With less, the step is
 *   not started and the cycle parks with cap `deadline:no-fit`, naming the
 *   step, the time left and the time it needed. With enough, the step is
 *   clamped to the time left rather than refused for not fitting its own
 *   (much longer) bound.
 * - A step already running does not run on: every child the cycle spawns is
 *   bounded by `deadline − now − grace`, and the handoff's child by the
 *   allowance after the deadline (cycle-deadline-clock.ts). Before #1593 such
 *   a step ran to its own backstop, into the caller's kill.
 * - A step that ends past the deadline does not get to name the cycle's
 *   terminal reason: the handoff boundary records `deadline` after its
 *   verdict (work-driver-terminal-reason.ts).
 * - The handoff step itself is never parked.
 * - No env var set → no deadline: the default behaviour is unchanged.
 */

import { notifyAgent } from "./agent-message.ts";
import { noteCycleDeadline, runWithCycleClock } from "./cycle-deadline-clock.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";
import { terminalReasonAtHandoff } from "./work-driver-terminal-reason.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

const MINUTE_MS = 60_000;

/**
 * #1742 — one lens round's floor, stated ONCE. `MIN_USEFUL_MS["lens-review"]`
 * and `lensRoundReserveMs()` (work-driver-lens-fix-budget.ts) both read it, so
 * the round's start gate and the reserve the fixer withholds cannot drift.
 */
export const LENS_REVIEW_MIN_USEFUL_MS = 10 * MINUTE_MS;

/**
 * #1567 item 6 — the least useful time (before `deadline − handoff grace`) a
 * step needs to be worth starting. A step not listed needs only some.
 */
export const MIN_USEFUL_MS: Partial<Record<WorkStep, number>> = {
  develop: 15 * MINUTE_MS,
  "lens-fix": 15 * MINUTE_MS,
  "lens-review": LENS_REVIEW_MIN_USEFUL_MS,
};

/** Below this an epoch is in seconds, not ms (1e12 ms is September 2001). */
const EPOCH_MS_FLOOR = 1e12;

/**
 * Read the caller's deadline. `PI_ENSEMBLE_CYCLE_DEADLINE` is an absolute
 * epoch ms. `PI_ENSEMBLE_CYCLE_BUDGET_MS` is a duration resolved to an epoch
 * ONCE; the persisted `pipelineState.cycleDeadlineMs` is used only while the
 * budget is still set, so a resume keeps the budget's clock but a cleared
 * env var clears the deadline (no env var → no deadline, as standalone).
 *
 * Returns the absolute deadline, or undefined. A malformed value — including
 * an epoch in seconds — is treated as unset (traced, never a cycle failure):
 * the deadline is an operator affordance, not a correctness gate.
 */
export function readCycleDeadline(state: WorkState, now: number): number | undefined {
  const abs = process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  if (abs !== undefined && abs !== "") {
    const v = Number(abs);
    if (Number.isFinite(v) && v >= EPOCH_MS_FLOOR) return v;
    trace(
      Number.isFinite(v) && v > 0
        ? `work-driver: PI_ENSEMBLE_CYCLE_DEADLINE=${abs} looks like epoch SECONDS — it must be epoch ms; ignored`
        : `work-driver: PI_ENSEMBLE_CYCLE_DEADLINE=${abs} is not a finite positive epoch ms — ignored`,
    );
    return undefined;
  }
  const budget = process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  if (budget === undefined || budget === "") return undefined;
  const v = Number(budget);
  if (!Number.isFinite(v) || v <= 0) {
    trace(
      `work-driver: PI_ENSEMBLE_CYCLE_BUDGET_MS=${budget} is not a finite positive duration — ignored`,
    );
    return undefined;
  }
  // The persisted absolute wins while the budget is set: re-resolving it at
  // every boundary (or on resume) would restart the clock and never park.
  const persisted = state.pipelineState.cycleDeadlineMs;
  if (typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0) {
    return persisted;
  }
  return now + v;
}

/**
 * #1542 — the time left, signed in words: a negative "remained" read as time
 * still in hand, when the deadline had passed an hour earlier.
 */
function remainingText(remaining: number, grace: number): string {
  return remaining >= 0
    ? `${remaining}ms remained, within the ${grace}ms handoff grace`
    : `the deadline had already passed ${-remaining}ms earlier (overdue)`;
}

/**
 * #1542 — which step was refused, and after which one. A develop entered from
 * the adversarial gate is that round's fix pass, not the develop step (which
 * finished long before), and the step that actually ran last is the one the
 * operator should look at.
 */
function refusedStepText(state: WorkState, step: WorkStep): string {
  const log = state.eventLog;
  const fix = step === "develop" ? log[log.length - 1] : undefined;
  const what =
    fix?.kind === "adversarial-fix-requested"
      ? `the adversarial round ${fix.round} fix pass ("develop") not started`
      : `step "${step}" not started`;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "step-started" && e.step !== "handoff") {
      return `${what}; the last step that ran was "${e.step}"`;
    }
  }
  return what;
}

/**
 * The pre-step boundary check (#1238). Parks with cap `deadline` (routing to
 * handoff) once `now + handoff grace >= deadline`, and with `deadline:no-fit`
 * when some useful time is left but less than the step's `MIN_USEFUL_MS`. A
 * step's own worst-case bound is not reserved: a step that fits is clamped to
 * the time left (cycle-deadline-clock.ts). Returns `{ parked, state, deadline }`; `state` carries the
 * resolved deadline (persisted so a budget resolves exactly once), or drops
 * a stale persisted one when no deadline applies any more.
 *
 * Never parks `handoff` (the comment is the whole point) or `merged` (its
 * in-process `gh` evidence is fast; parking a green PR would defeat it).
 */
export async function deadlineCheck(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
  now: number,
): Promise<{ parked: boolean; state: WorkState; deadline?: number }> {
  void ctx; // the caller persists the returned state; the check itself never writes
  const deadline = readCycleDeadline(state, now);
  // #1593 — the children this step spawns are bounded by what the deadline leaves.
  noteCycleDeadline(deadline, handoffDispatchTimeoutMs(), step);
  if (deadline === undefined) {
    const s = step === "handoff" ? terminalReasonAtHandoff(state, undefined, now) : state;
    if (s.pipelineState.cycleDeadlineMs === undefined) return { parked: false, state: s };
    const { cycleDeadlineMs: _stale, ...ps } = s.pipelineState;
    return { parked: false, state: { ...s, pipelineState: ps } };
  }
  const next =
    state.pipelineState.cycleDeadlineMs === deadline
      ? state
      : { ...state, pipelineState: { ...state.pipelineState, cycleDeadlineMs: deadline } };
  if (step === "handoff") {
    // #1593 — a step that ended past the deadline, or on a backstop kill, does
    // not leave its own verdict standing as the cycle's terminal reason.
    return {
      parked: false,
      state: terminalReasonAtHandoff(next, deadline, now, handoffDispatchTimeoutMs()),
      deadline,
    };
  }
  if (step === "merged") return { parked: false, state: next, deadline };
  const grace = handoffDispatchTimeoutMs();
  const remaining = deadline - now;
  const useful = remaining - grace;
  const need = MIN_USEFUL_MS[step] ?? 0;
  if (useful > 0 && useful >= need) return { parked: false, state: next, deadline };
  const noFit = useful > 0;
  trace(
    `work-driver: deadline park before ${step} — ${useful}ms useful (remaining ${remaining}ms − handoff grace ${grace}ms), step needs ${need}ms (deadline ${deadline})`,
  );
  const capped = appendEvent(next, {
    kind: "cap-hit",
    at: now,
    cap: noFit ? "deadline:no-fit" : "deadline",
    reviewRound: next.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: noFit
      ? `caller deadline ${deadline} (absolute epoch ms); ${useful}ms of useful time remained after the ${grace}ms handoff grace, and "${step}" needs at least ${need}ms — ${refusedStepText(next, step)}`
      : `caller deadline ${deadline} (absolute epoch ms); ${remainingText(remaining, grace)} — ${refusedStepText(next, step)}`,
  });
  return { parked: true, state: capped, deadline };
}

/**
 * The loop-side deadline boundary handler (#1238). Runs `deadlineCheck` and
 * returns the state the loop continues with. When the check parks, the
 * capped state is persisted with `currentStep: "handoff"` (so the comment
 * posts before the caller's kill) and the operator is notified; the caller
 * sees the step change and `continue`s. Otherwise the returned state carries
 * the resolved deadline (persisted once, when it first appears), so a budget
 * resolves exactly once per cycle.
 */
export async function parkAtDeadlineBoundary(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): Promise<WorkState> {
  const checked = await deadlineCheck(ctx, state, step, Date.now());
  if (!checked.parked) {
    if (checked.state !== state) await persistCycle(ctx, checked.state);
    return checked.state;
  }
  const last = checked.state.eventLog[checked.state.eventLog.length - 1];
  const why =
    last?.kind === "cap-hit" && last.cap === "deadline:no-fit"
      ? `too little time is left before the caller's deadline for ${step} to do useful work`
      : "the caller's deadline is within the handoff grace";
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} parked at the ${step} boundary — ${why}, so no new step starts. Routing to handoff so the comment posts before the deadline.`,
  );
  const toHandoff: WorkState = {
    ...checked.state,
    pipelineState: { ...checked.state.pipelineState, currentStep: "handoff" },
  };
  await persistCycle(ctx, toHandoff);
  return toHandoff;
}

/**
 * #1593 — run a cycle under its own deadline clock (cycle-deadline-clock.ts):
 * every child it spawns is then bounded by the deadline the boundary check
 * resolved, and the handoff's by the allowance after it.
 */
export function withCycleClock<T>(fn: () => Promise<T>): Promise<T> {
  return runWithCycleClock(fn);
}
