/**
 * lean-step-bound — the wall clock a lean step's CHILD may be given, read against
 * the run's cycle deadline (#2660).
 *
 * A lean step bounds its child by one number: the `minutes` row of
 * `WorkConfig.budgets` for its state (`lean/step-budget.ts`'s `armBudget`). The engine
 * consults the run's resolved deadline only BETWEEN steps, and the AsyncLocalStorage
 * cycle clock that `spawn-child-bound.ts` clamps against is recorded by the `/work`
 * driver alone — nothing under `src/lean/` ever calls `noteCycleDeadline`, so the clamp
 * answers `{clamped: false}` for every lean spawn. A step still running and still
 * emitting when the deadline passed was therefore bounded by nothing: the field's cells
 * overran 978 s and 541 s into a build step by 1150 s and 1158 s past the deadline,
 * past the 10-minute child grace, until the harness's outer wall took the cell — no
 * handback, an empty result document, and no patch although the workspace held edits.
 *
 * The bound is therefore derived PER DISPATCH, at arm time, from the same two shared
 * helpers the clamped precedents read (`lean/ci-tier-budget.ts`, `lean/review-bound.ts`):
 * the run's recorded `deadlineMs` and `handoffAllowanceMs()`. The child gets the
 * smaller of its configured minutes and what the deadline leaves OUTSIDE the allowance,
 * so the kill lands before the line and the handback still has its allowance to run in.
 *
 * Deliberately NOT a second mechanism: the cycle clock is not recorded for lean (that
 * would make a lean spawn inherit a `/work` cycle's clock and every other clamp in the
 * spawn follow from it), and no new clock is read — the lever takes the instant the caller
 * is standing at, the same scripted `ctx.now()` the step's other waits already read, so
 * arming a bound costs no clock read of its own and a re-dispatch re-measures the room from
 * where it actually is.
 *
 * Measuring from NOW and not from the step's durable start is the whole point for a step that
 * re-arms: `build` re-arms per retry inside its own loop, and a window taken from the entry's
 * `startedAt` hands a child dispatched minutes later the first child's full length — its kill
 * then lands that much past deadline plus the allowance, which is the defect one retry deep.
 *
 * Lives outside `src/lean/` for the same reason `request-stall-policy.ts` does: this is
 * spawn policy, not engine state. It reads the shared deadline helpers as PARAMETERS
 * through the arms the step hands it, so it never imports the lean tree, and the lean
 * line total does not grow with it.
 */

import { leanStepDeadlineBoundEnabled } from "./lean-step-deadline-bound-switch.ts";
import type { Budget } from "./lean/config.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "./lean/review-bound.ts";
import type { Outcome } from "./lean/state.ts";
import { type BudgetArms, armBudget } from "./lean/step-budget.ts";
import type { StallArms } from "./request-stall-policy.ts";
import { capsEnabled, childBoundGraceMs } from "./spawn-child-bound.ts";
import { traceWarn } from "./trace.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";

/** One minute, the unit every bound in this stack prints. */
const MINUTE_MS = 60_000;

/**
 * What a step hands {@link leanStepBound}: the run's resolved deadline (absent means no
 * deadline, which never shrinks a bound) and the instant the dispatch is armed at — `now`, not
 * the step's durable start, because the room has to be what the deadline still leaves AT THAT
 * INSTANT for a step that re-arms (`build` re-arms its child per retry). `now` is supplied
 * rather than read here so arming a bound costs no clock read of its own: a scripted clock
 * counts reads, and one extra slot would move a step's stop.
 */
export interface StepBoundArms {
  deadlineMs?: number;
  now?: number;
}

/** The least room a deadline-derived bound may leave between the child's bound and the
 *  row it replaced: below it the deadline saved nothing worth a clamp, and the child's
 *  own grace would exceed the shortening. A rule about the SHORTENING — it is compared
 *  against `full - left`, the size of the clamp. Its sibling below is a rule about the
 *  KILL's placement. Both are 30 s today and are deliberately two constants: either could
 *  move alone (a steer that needs longer to land changes the kill rule, not the clamp's
 *  worth). Both are pinned by the literal assertions in `test-lean-deadline-step-bound.ts`. */
export const MIN_DEADLINE_GRACE_MS = 30_000;

/** The least grace a deadline-derived kill may sit behind its wrap-up steer. A child
 *  steered and killed in the same instant never reads the steer, and the steer is the
 *  half of the bound that costs the child nothing — so a derivation that would leave the
 *  kill less than this behind the bound keeps the configured grace instead and places the
 *  bound a full grace before the line. A rule about the KILL, compared against the
 *  grace/placement arithmetic; see {@link MIN_DEADLINE_GRACE_MS} for why the two 30 s
 *  floors are not merged into one constant. */
export const MIN_KILL_GRACE_MS = 30_000;

/** Why the deadline did not shorten a bound, or `undefined` when it did. */
type InertCause = "switch" | "deadline" | "caps" | "now" | "room" | "row";

/** The one cause table, so the disclosure and the decision cannot disagree. */
function inertCause(arms: StepBoundArms, minutes: number): InertCause | undefined {
  if (minutes <= 0) return "row";
  if (!leanStepDeadlineBoundEnabled()) return "switch";
  if (arms.deadlineMs === undefined) return "deadline";
  if (arms.now === undefined) return "now";
  if (!capsEnabled()) return "caps";
  // The room the rule needs is stated in `leanStepBound` and repeated here as a guard
  // only: a step whose deadline sits inside the pair the grace is derived from has no
  // room for a bounded child at all.
  if (arms.deadlineMs - arms.now <= handoffDispatchTimeoutMs() + MIN_DEADLINE_GRACE_MS)
    return "room";
  return undefined;
}

const CAUSE_TEXT: Record<InertCause, string> = {
  switch: "PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND=0",
  deadline: "no cycle deadline",
  caps: "PI_ENSEMBLE_DISPATCH_CAPS=0",
  now: "no dispatch instant",
  room: "no room outside the handoff allowance",
  row: "no minutes row",
};

/** What one arm decided: the bound the child gets, and the disclosure when it changed. */
export interface StepBound {
  /** The bound to hand the dispatch, ms. Always the configured minutes when the rule is
   *  inert — never zero, never negative, never a timer that kills the child on arrival. */
  readonly boundMs: number;
  /** True when the deadline (not the row) set the bound. */
  readonly clamped: boolean;
  /** The arm bounded nothing and why; `undefined` when it armed, when there was nothing
   *  to bound, or when the row already sat inside what the deadline leaves. */
  readonly inert?: string;
  /** The deadline's own sentence, for a verdict reason and the trace. Present exactly
   *  when `clamped`, so a step cannot print a deadline it never consulted. */
  readonly sentence?: string;
  /** The grace the kill may sit behind its steer, ms — the configured grace, since the
   *  bound is armed a grace before the line plus the allowance. Present exactly when
   *  `clamped`; absent on every pre-change arm, which keeps the off arm byte-identical. */
  readonly graceMs?: number;
}

/** What the deadline leaves the child outside the handoff allowance, from the dispatch instant. */
function deadlineRoom(arms: StepBoundArms, allowance: number): number {
  return (arms.deadlineMs as number) - (arms.now as number) - allowance;
}

/**
 * The bound one dispatch may be given, asked at arm time.
 *
 * `full` is the configured minutes' worth of milliseconds (0 when the state has no row,
 * which means no bound at all and nothing for this rule to shorten). The result is
 * never larger than `full` and never the engine's boundary stop: a deadline that leaves
 * no room outside the allowance leaves the CHILD'S OWN bound untouched rather than
 * arming a timer that fires on arrival — starting no step at all is the engine's job
 * between steps, and a step already running must still hand back.
 *
 * Traces one line when it clamps, and one when it declined to, so an operator reading
 * a cell can tell a bound that held from a lever that armed nothing.
 */
export function leanStepBound(arms: StepBoundArms, full: number, state: string): StepBound {
  const cause = inertCause(arms, full);
  if (cause !== undefined) {
    // A state with no minutes row has no bound for this rule to shorten: that is not an
    // inert lever, it is no lever, and saying so on every dispatch would be noise.
    const inert =
      cause === "row" ? undefined : `step deadline bound is inert: ${CAUSE_TEXT[cause]}`;
    if (inert !== undefined) traceOnce(`${state}: ${inert}`);
    return { boundMs: full, clamped: false, ...(inert === undefined ? {} : { inert }) };
  }
  const allowance = handoffDispatchTimeoutMs();
  // The grace the kill will actually sit behind, which the bound's placement must be
  // armed against: what the deadline's own placement leaves for it, floored where the
  // steer stops being worth writing and capped at the configured grace.
  const grace = Math.max(
    MIN_KILL_GRACE_MS,
    Math.min(childBoundGraceMs(), deadlineRoom(arms, allowance) - allowance - MIN_KILL_GRACE_MS),
  );
  const deadlineMs = arms.deadlineMs as number;
  // The pair this rule must keep inside the line: the wrap-up steer at the bound, then
  // the kill one grace later. The child's bound is therefore the deadline minus the
  // allowance MINUS the grace it will be armed with, so that a child still emitting when
  // the deadline passes is ended by the deadline's own arithmetic rather than by the
  // configured 10-minute grace landing a quarter hour past the line.
  const left = deadlineRoom(arms, allowance) - grace;
  if (left >= full) return { boundMs: full, clamped: false };
  // A row already tighter than the deadline is not a deadline stop, and a bound of 0 or
  // less is the engine's boundary stop rather than a child killed the instant it starts:
  // starting no step at all is the engine's job between steps, and a step already running
  // must still hand back.
  if (left <= 0 || full - left < MIN_DEADLINE_GRACE_MS) {
    const inert = `step deadline bound is inert: ${CAUSE_TEXT.room}`;
    traceOnce(`${state}: ${inert}`);
    return { boundMs: full, clamped: false, inert };
  }
  const minutesLeft = Math.max(1, Math.round(left / MINUTE_MS));
  const sentence = `cycle deadline ${String(deadlineMs)} left ${String(minutesLeft)} min outside the ${String(
    Math.round(allowance / MINUTE_MS),
  )} min handoff allowance and the ${String(Math.round(grace / MINUTE_MS))} min child grace`;
  traceOnce(`${state}: child bound ${String(full)} clamped to ${String(left)} (${sentence})`);
  return { boundMs: left, clamped: true, sentence, graceMs: grace };
}

/** The clause a minutes breach traces when the DEADLINE (not the row) set the bound, and
 *  `undefined` when the row did — the arm prints its own budget line and needs only this
 *  clause, so the deadline's wording lives here rather than in the lean arm site. */
export function deadlineTrace(bound: StepBound): string | undefined {
  return bound.clamped === true
    ? `the child stopped at the deadline, not its row (${bound.sentence})`
    : undefined;
}

/** The clause a stopped step's verdict reason carries when the DEADLINE set the bound, so a
 *  handback names the deadline and not only the ceiling (`#2660` AC3): only when the DEADLINE,
 *  not the configured row, set it — a clamp is what makes a ceiling worth naming. */
export function deadlineReasonClause(bound: StepBound | undefined): string | undefined {
  return bound?.clamped === true
    ? `the step stopped at the deadline, not its row (${bound.sentence})`
    : undefined;
}

/** One write to the trace sink, caught: a sink that throws must never cost a child its bound. */
function traceOnce(msg: string): void {
  try {
    traceWarn(`lean step bound: ${msg}`);
  } catch {
    // A sink we cannot write to cannot be written to; nothing to say about it.
  }
}

/**
 * The slice of the step's context the arms read: the run's deadline, the step log, the key
 * that names which entry is this step's, and the injected clock. Structural, so a caller
 * needs no lean import to satisfy it.
 */
export interface StepArmsCtx {
  run: { deadlineMs?: number };
  steps: readonly { state: string; startedAt: number }[];
  stepKey: string;
  /** The run's clock, the one place this module reads it (#2660): the bound's room is
   *  measured from NOW, so a re-dispatch re-measures it rather than reusing the first
   *  child's window. The stall lever keeps its own window semantics on the durable entry. */
  now: () => number;
}

/** The state this step's key names — the entry the levers read. */
function stepState(ctx: StepArmsCtx): string {
  return ctx.stepKey.split(":")[1] ?? "";
}

/** The durable start of this step's newest entry, and the run's deadline, read ONCE. */
function stepEntry(ctx: StepArmsCtx): {
  deadlineMs?: number;
  startedAt?: number;
} {
  const state = stepState(ctx);
  let startedAt: number | undefined;
  for (const step of ctx.steps) if (step.state === state) startedAt = step.startedAt;
  return {
    ...(ctx.run.deadlineMs === undefined ? {} : { deadlineMs: ctx.run.deadlineMs }),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

/** What one dispatch is armed against: the deadline and the instant of the arming. The bound
 *  measures its room from here, so each child of a re-arming step gets what the deadline still
 *  leaves at the moment it is sent (`#2660`). */
function dispatchArms(ctx: StepArmsCtx): StepBoundArms {
  const { deadlineMs } = stepEntry(ctx);
  return { ...(deadlineMs === undefined ? {} : { deadlineMs }), now: ctx.now() };
}

/** The bound a step's LAST arm would have been given, re-derived from the same log and the
 *  run's clock — the same instants the arming itself used, so the reason a stopped step prints
 *  describes the bound that child actually carried. */
export function stepBoundOf(ctx: StepArmsCtx, state: string, full: number): StepBound | undefined {
  return stepChildBound(ctx, full, state);
}

/** The clause a stopped step's verdict reason carries when the DEADLINE set the bound, so the
 *  arm site names the ceiling in ONE call and imports nothing but this. Composes
 *  {@link stepBoundOf} with {@link deadlineReasonClause}; the reason it writes is pinned by
 *  `test-lean-deadline-step-bound.ts` (c) and the site tests' verdict text. */
export function stopReasonClause(
  ctx: StepArmsCtx,
  state: string,
  full: number,
): string | undefined {
  return deadlineReasonClause(stepBoundOf(ctx, state, full));
}

export function stepChildBound(
  ctx: StepArmsCtx,
  full: number,
  state: string,
): StepBound | undefined {
  // No row means no bound existed to shorten, and a rule that armed one would be a
  // bound no operator configured.
  if (full <= 0) return undefined;
  return leanStepBound(dispatchArms(ctx), full, state);
}

/**
 * BOTH arms of one dispatch, from ONE read of the step log (#2660).
 *
 * Every dispatching step armed these side by side — the #2644 silence lever and the
 * deadline's child bound — at six sites, each re-deriving the same state and start from
 * the same entries. One call outside the lean tree reads them once and returns both, so
 * each step passes one object to `armBudget` and no engine module carries lever arithmetic.
 * The reserve is a parameter rather than an import for the same reason `leanStepBound`
 * takes its arms as parameters: this module never reaches into `src/lean/`.
 *
 * The two levers measure from different instants on purpose. The bound takes the dispatch
 * instant (each child of a re-arming step gets what the deadline still leaves when it is
 * sent); the stall lever keeps the durable step entry, which is the window #2644 defines —
 * silence measured from when the step began.
 */
export function stepDispatchArms(
  ctx: StepArmsCtx,
  minutesRow: number,
  state: string,
): { stall: StallArms; bound: StepBound | undefined } {
  const entry = stepEntry(ctx);
  return {
    stall: {
      reserveMs: REVIEW_DEADLINE_RESERVE_MS,
      silence: () => ({ sinceMs: 0, toolInFlight: false }),
      ...(entry.deadlineMs === undefined ? {} : { deadlineMs: entry.deadlineMs }),
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    },
    bound: stepChildBound(ctx, minutesRow, state),
  };
}

/**
 * What one arm of one dispatch decided, and the one line its step must say out loud
 * (#2660). The arm sites read their levers from the step log through
 * {@link stepDispatchArms}; `armsStepBudget` is the other half of that call — it owns the
 * wording of the two inertness disclosures (the caps switch that will not enforce a minutes
 * lever, and the stall lever that armed nothing) so the engine module arms its levers
 * without carrying their prose.
 */
export function armsStepBudget(
  b: Budget | undefined,
  levers: { stall?: StallArms; bound?: StepBound },
): BudgetArms {
  return armBudget(b, levers.stall, levers.bound);
}

/** The deadline's own words for a stopped step's reason: only when the DEADLINE, not the
 *  configured row, set the bound — a clamp is what makes a ceiling worth naming. Composes
 *  {@link deadlineReasonClause}; the reason it writes is pinned by the site tests' verdict text. */
export function verdictReasonClause(verdict: Outcome, bound: StepBound | undefined): Outcome {
  const clause = deadlineReasonClause(bound);
  return clause === undefined ? verdict : { ...verdict, reason: `${verdict.reason}; ${clause}` };
}
