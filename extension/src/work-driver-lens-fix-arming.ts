/**
 * work-driver-lens-fix-arming — resolving ONE fixer's dispatch bound, and
 * saying which clock set it.
 *
 * Split out of `work-driver-lens-fix-budget.ts` for the AGENTS.md §12 500-line
 * gate; the budget module keeps the parks and the wall-clock reads and re-exports
 * what its callers have always taken from it. The two files are one subject:
 * `work-driver-lens-fix-budget.ts` decides whether a fixer may start, this one
 * decides how long it may run and WHAT SAID SO.
 *
 * #1798 is why the second question needs its own function. The bound used to be
 * a number and nothing else: `Math.min(the fixer's own ceiling, what the loop
 * budget leaves)`, traced and returned. Downstream — the completion event, the
 * cap, the cause table — a fixer killed at its 45-minute ceiling was
 * indistinguishable from one killed by the 90-minute review clock, so the
 * generic entry answered `environment` for both and told operators to "clear the
 * provider, the host or the deadline". Measured on three field cycles, none of
 * which had a provider or host fault and every one of which died on a pi-rukas
 * knob. The bound's SOURCE is a fact the resolver already computed and threw
 * away; keeping it is the whole change.
 */

import { trace } from "./trace.ts";
import type { FixerBound, FixerBoundSource } from "./work-driver-fixer-bound.ts";
import { type FixerIdentity, fixerStepName } from "./work-driver-lens-fix-identity.ts";
import { MIN_FIX_DISPATCH_MS, lensRoundReserveMs } from "./work-driver-lens-loop-numbers.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

// `reviewFixDispatchBound` takes the loop's two clock reads as arguments rather
// than importing them: `work-driver-lens-fix-budget.ts` re-exports this module,
// so importing it back would close a cycle. Callers build `reads` from that
// module's `reviewRemainingMs` / `unboundReason`. See `FixerBudgetReads`.

/**
 * How the resolver reads the loop's clock. The budget module
 * (`work-driver-lens-fix-budget.ts`) owns `reviewRemainingMs` and the
 * `PI_ENSEMBLE_REVIEW_ENFORCE` hatch, and it re-exports this module — so
 * importing it back would close a cycle. Both default to the budget module's
 * behaviour and are overridable for tests of the arithmetic alone.
 */
export interface FixerBudgetReads {
  /** What the loop budget leaves right now; `undefined` = nothing is armed
   *  (enforcement off, or no lens round has stamped the clock). */
  remaining?: number;
  /** Why nothing is armed, for the un-armed trace. Only read when `remaining`
   *  is `undefined`. */
  unboundReason?: string;
  /** The budget read itself — used when `remaining` is not supplied. */
  readRemaining?: (state: WorkState, now: number) => number | undefined;
  /** The un-armed reason itself — used when `unboundReason` is not supplied. */
  readUnboundReason?: () => string;
}

/**
 * The dispatch bound the remaining loop budget leaves, if any: `undefined`
 * when the dispatch runs uncapped (enforcement off, no review clock, or a step
 * outside the review loop), otherwise what the budget leaves — never less than
 * `MIN_FIX_DISPATCH_MS`, never more than `requestedTimeoutMs` (the cap only ever
 * shortens a dispatch). #1242 removed the band (~9 min) where this returned
 * `undefined` and a fixer ran unbound at the loop's tightest moment; every
 * fixer that is dispatched is bounded, and either outcome is traced once.
 */
export function reviewFixDispatchBoundMs(
  state: WorkState,
  step: WorkStep,
  now: number,
  requestedTimeoutMs?: number,
  /** #1789 — WHICH fixer this dispatch is, so the armed trace names the
   *  right step. Defaults to the lens-fix half of the loop. */
  fixer: FixerIdentity = "lens-fix",
): number | undefined {
  return reviewFixDispatchBound(state, step, now, requestedTimeoutMs, fixer)?.boundMs;
}

/**
 * #1798 — the same resolution PLUS the fact the number alone cannot carry:
 * WHICH clock set the bound.
 *
 * `undefined` exactly where `reviewFixDispatchBoundMs` is (`step` is not a
 * fix-loop step, enforcement off, no review clock). The source is decided from
 * the SAME comparison the arithmetic already made — the ceiling won, or the
 * loop budget did — never from a second reading of the knobs, so the number and
 * its attribution cannot disagree. The caller's cycle-deadline clamp is layered
 * on afterwards by the spawn layer, which already stamps `killedAtCycleDeadline`
 * on the result, so it is not guessed at here.
 */
export function reviewFixDispatchBound(
  state: WorkState,
  step: WorkStep,
  now: number,
  requestedTimeoutMs?: number,
  fixer: FixerIdentity = "lens-fix",
  reads: FixerBudgetReads = {},
): FixerBound | undefined {
  if (step !== "lens-fix") return undefined;
  const remaining = reads.remaining ?? readLoopBudgetLeft(state, now);
  // (e) One bound line per fixer dispatch, including the un-armed case: a
  // fixer that ran with NO loop bound is exactly the fact an operator needs to
  // attribute a long kill afterwards, and previously it produced no line at all.
  if (remaining === undefined) {
    trace(
      `work-driver: ${fixerStepName(fixer)} fixer ran UNBOUND — ${
        reads.unboundReason ?? readUnboundReason()
      }`,
    );
    return undefined;
  }
  // #1742 — the owed lens round's floor is withheld from the fixer's bound:
  // a fixer that consumes the whole budget leaves a round that must be
  // refused at its own start gate, which is the cap the loop could not shed.
  const ceiling = boundCeiling(requestedTimeoutMs);
  const bound = Math.min(
    Math.max(remaining - lensRoundReserveMs(), MIN_FIX_DISPATCH_MS),
    // No ceiling given is genuinely unbounded, not an arbitrarily large one:
    // `Math.min(x, Infinity)` is also correct, but the trace below must say
    // "none" rather than print a rendered infinity.
    ceiling ?? Number.POSITIVE_INFINITY,
  );
  // Production attribution: a fixer killed AT its bound used to be
  // indistinguishable in the log from one killed by the role backstop, so a
  // park caused by the review budget could not be attributed to it. One line
  // per armed dispatch, naming the ceiling the caller passed, the reserve the
  // budget withheld and what the loop had left when the bound was resolved.
  // A caller that passed NO ceiling prints `ceiling none`, not `Infinitym` —
  // an unbounded dispatch and an arbitrarily large one are different facts and
  // the log must not render them the same.
  trace(
    `work-driver: ${fixerStepName(fixer)} fixer armed — bound ${Math.round(bound / 60_000)}m (ceiling ${ceiling === undefined ? "none" : `${Math.round(ceiling / 60_000)}m`}, reserve ${Math.round(lensRoundReserveMs() / 60_000)}m, budget left ${Math.max(0, Math.round(remaining / 60_000))}m)`,
  );
  // The ceiling won ⇒ the fixer's own knob is the bound; the loop budget left
  // less than it ⇒ the review wall clock is. Read off the value, not re-derived
  // from the environment, so a bound this function computed and the knob it
  // names are one fact.
  const source: FixerBoundSource =
    ceiling !== undefined && bound >= ceiling ? "fixer-bound" : "review-clock";
  return { boundMs: bound, source };
}

/** Never lengthen a dispatch the caller already bounded. `undefined` is the
 *  honest answer for "no ceiling was given" — rendering it as a number made an
 *  unbounded dispatch print `ceiling Infinitym`. */
function boundCeiling(requestedTimeoutMs?: number): number | undefined {
  return requestedTimeoutMs;
}

/**
 * The budget module's two reads, installed once by that module at load. They
 * default to "nothing is armed" — the honest answer for a resolver that has no
 * clock wired to it — and the un-armed trace says which module failed to wire
 * itself, so a mis-wired import is visible rather than silently unbounded.
 */
let readLoopBudgetLeft: (state: WorkState, now: number) => number | undefined = () => undefined;
let readUnboundReason: () => string = () => `the review budget was never wired (${NOT_WIRED_MARK})`;
const NOT_WIRED_MARK = "setFixerBudgetReads was not called";

export function setFixerBudgetReads(
  readRemaining: (state: WorkState, now: number) => number | undefined,
  readReason: () => string,
): void {
  readLoopBudgetLeft = readRemaining;
  readUnboundReason = readReason;
}

export { FIXER_DEVELOP_PASS, fixerStepName } from "./work-driver-lens-fix-identity.ts";
export type { FixerIdentity } from "./work-driver-lens-fix-identity.ts";
