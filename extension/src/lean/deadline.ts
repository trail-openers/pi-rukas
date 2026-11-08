/**
 * lean/deadline — the caller's whole-cycle deadline, read the way `work` reads
 * it.
 *
 * `work` stops STARTING steps once its deadline is inside the handoff allowance
 * (`work-driver-deadline.ts`'s step boundary) and hands off. A lean run had no
 * such boundary: only a step's own budget bounded it, so a host's
 * `--timeout`/deadline killed the container mid-step with no result document.
 *
 * The reporting exemption is the rule this module states and the suite must
 * keep: `test-lean-deadline-host-channel.ts` case (e) drives a real run that
 * ARRIVES at `handback` with its deadline already gone — the crossing is placed
 * by the step the run stands in, not by a tick count — so deleting the
 * `REPORT_STATES` branch below turns that case red. A regression there is loud,
 * not silent.
 *
 * Two rules, both read from the SAME helper `work` uses, so one exported
 * constant (`MINUTE_MS`) and one env contract drive both engines:
 *
 *   - `leanDeadline` is `resolveCycleDeadline` over the environment and the
 *     arm this record already carries: the host's `--timeout <minutes>`, the
 *     exported `PI_ENSEMBLE_CYCLE_BUDGET_MS` and the exported
 *     `PI_ENSEMBLE_CYCLE_DEADLINE` resolve to one absolute epoch ONCE, which the
 *     engine persists on its own record so a resume keeps the clock the first
 *     run resolved;
 *   - `deadlineStopsSteps` is `work`'s boundary answer restated for a lean step
 *     (no per-step `MIN_USEFUL_MS` floors — lean has no develop or lens-fix
 *     step to size): step work ends at `deadline − PI_ENSEMBLE_HANDOFF_TIMEOUT_MS`,
 *     and the step that reports the run (`handback`/`decline`) is never stopped,
 *     exactly as `work` never parks its own handoff.
 *
 * What this module does NOT do is bound a child already running: `work` does
 * that through the AsyncLocalStorage cycle clock (`cycle-deadline-clock.ts`),
 * and lean has no frame to open — its children are built by `lean/build.ts`
 * through `spawnSpecialist`, and the step's own `WorkConfig.budgets` bound
 * `childBoundMs` is what stops them. The deadline therefore decides only when a
 * step may START. A lean child bounded by the caller's deadline is a separate
 * change, not a claim this module or its suite makes.
 *
 * A run stopped at the deadline is not a crash and not a signal: it is the same
 * answer `work` gives a cycle its deadline cut off, so it ends `handed-back` at
 * exit 10 with a result document.
 */

import { type CycleBudgetMs, resolveCycleDeadline } from "../work-driver-deadline.ts";
import { handoffDispatchTimeoutMs } from "../work-driver-handoff.ts";
import { REPORT_STATES, type Step } from "./state.ts";
import { VerifyInfraError } from "./verify-types.ts";

/** One minute, the unit `--timeout` is given in — the same constant `work` uses. */
export const MINUTE_MS = 60_000;

/**
 * The run's absolute deadline: the host's arm and the env resolved once, or the
 * one this record already carries. The record wins while a budget is still set —
 * which is the shared reader's own rule, so a resume cannot restart the clock.
 *
 * `flagMs` is the `--timeout` arm (`flagBudgetMs` mints it in
 * `work-driver-deadline.ts`); it is passed as a VALUE, so no caller writes the
 * environment. The env is read here and only here, which is
 * what keeps one contract for both engines: a bare `PI_ENSEMBLE_CYCLE_DEADLINE`
 * still stops a lean run, and a bare `PI_ENSEMBLE_CYCLE_BUDGET_MS` still stops
 * it, with no second copy of the parsing rules.
 *
 * The shared `resolveCycleDeadline` is called with the record's own value and
 * no cycle state at all: a lean run has no cycle state, and minting a fake
 * `WorkState` to reach the shared rules is how a reader of the record starts
 * disagreeing with the writer about its shape.
 */
export function leanDeadline(
  persisted: number | undefined,
  now: number,
  flagMs?: CycleBudgetMs,
): number | undefined {
  return resolveCycleDeadline(process.env, persisted, now, flagMs);
}

/**
 * Has step work's end arrived? True means start no NEW step: the loop stops as
 * though there were no handler left, and the run ends handed-back with its
 * document. `handback`/`decline` are exempt — they are the report, and a run
 * that could not write it would leave the host with no result at all.
 */
export function deadlineStopsSteps(
  deadline: number | undefined,
  now: number,
  next: string,
): boolean {
  if (deadline === undefined) return false;
  if ((REPORT_STATES as readonly string[]).includes(next)) return false;
  return deadline - now <= handoffDispatchTimeoutMs();
}

/**
 * The handoff allowance itself — `deadlineStopsSteps`'s threshold as a NUMBER.
 *
 * A caller that must fit work INSIDE the deadline needs the allowance to
 * subtract, not just the boundary answer, and re-reading
 * `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` at the caller is how the two start disagreeing
 * about where step work ends. `lean/ci` subtracts this before starting its full
 * tier, so the tier can never be given the time the handback still needs.
 */
export function handoffAllowanceMs(): number {
  return handoffDispatchTimeoutMs();
}

/**
 * Bound a long piece of work that runs AFTER something else in the same step,
 * given the run's whole-cycle deadline: the time the deadline still leaves,
 * minus the allowance the handback needs.
 *
 * The engine consults the cycle arm only BETWEEN steps, so one step that
 * contains two long runs — `lean/ci`'s forge wait and then its full verify tier
 * — can outlive the host's deadline by the whole second run and die with no
 * result document. This is the number the second run may be given, and the
 * handback naming the deadline is thrown INSTEAD of a number whenever the run
 * may not start at all: inside the allowance, or with nothing left outside it.
 *
 * `work` is what is being bounded, named by `what` so the message says which
 * run refused to start. `full` is the bound that run would have been given with
 * no deadline in play, which is the answer returned when there is none: there is
 * nothing to clamp against, and an absent deadline is never a reason to shrink a
 * timeout. The allowance subtracted is {@link handoffAllowanceMs} — the same
 * number {@link deadlineStopsSteps} compares against, so a caller can never be
 * handed time the engine's own boundary says the run does not have.
 */
export function clampToCycleDeadline(
  deadline: number | undefined,
  now: number,
  full: number,
  what: string,
): number {
  if (deadline === undefined) return full;
  const left = deadline - now;
  const minutesLeft = Math.max(0, Math.round(left / MINUTE_MS));
  if (deadlineStopsSteps(deadline, now, what))
    throw new VerifyInfraError(
      `the ${what} was not started: it left ${String(minutesLeft)} min of the cycle deadline, inside the handoff allowance`,
    );
  const clamped = Math.min(full, left - handoffAllowanceMs());
  if (clamped <= 0)
    throw new VerifyInfraError(
      `the ${what} was not started: it left ${String(minutesLeft)} min of the cycle deadline, no room for it outside the handoff allowance`,
    );
  return clamped;
}

/**
 * The reason line the engine stamps when the clock, not a verdict, ended the
 * run: what the last step decided, and what was not started. Named rather than
 * left to `ended at <state>` so the document and the host's message say which
 * clock stopped it.
 */
export function deadlineReason(steps: Step[], state: string, deadline: number): string {
  const last = steps[steps.length - 1];
  const lastText =
    last === undefined ? "no step ran" : `${last.key} ended ${last.outcome?.kind ?? "undecided"}`;
  return `cycle deadline ${deadline} reached at ${state}: ${lastText}, no new step started`;
}
