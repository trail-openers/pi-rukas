/**
 * lean/deadline — the caller's whole-cycle deadline, read the way `work` reads it.
 *
 * A lean run stops STARTING steps once its deadline is inside the handoff allowance, as `work` does, so a
 * host's `--timeout` never kills it mid-step with no result document. The reporting states are exempt:
 * `test-lean-cycle-arm.ts` (e) and `test-lean-verified-handback-deadline.ts` pin that.
 *
 * Both rules read the helpers `work` reads — `resolveCycleDeadline` and `handoffDispatchTimeoutMs` — so one
 * env contract drives both engines: `leanDeadline` resolves the host's `--timeout`,
 * `PI_ENSEMBLE_CYCLE_BUDGET_MS` and `PI_ENSEMBLE_CYCLE_DEADLINE` to one absolute epoch ONCE, persisted so a
 * resume keeps the clock; `deadlineStopsSteps` ends step work at
 * `deadline − PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` and never stops the reporting states.
 *
 * What this module does NOT do is bound a child already running — that is the step's own
 * `WorkConfig.budgets` `childBoundMs`. The deadline decides only when a step may START.
 */

import { type CycleBudgetMs, resolveCycleDeadline } from "../work-driver-deadline.ts";
import { handoffDispatchTimeoutMs } from "../work-driver-handoff.ts";
import { REPORT_STATES, type Step } from "./state.ts";
import { VerifyInfraError } from "./verify-types.ts";

/** One minute, the unit `--timeout` is given in — the same constant `work` uses. */
export const MINUTE_MS = 60_000;

/**
 * The run's absolute deadline: the host's arm and the env resolved once, or the one this record carries — the
 * record wins while a budget is set, so a resume cannot restart the clock. `flagMs` is the `--timeout` arm,
 * passed as a VALUE so no caller writes the environment.
 */
export function leanDeadline(
  persisted: number | undefined,
  now: number,
  flagMs?: CycleBudgetMs,
): number | undefined {
  return resolveCycleDeadline(process.env, persisted, now, flagMs);
}

/**
 * Has step work's end arrived? True means start no NEW step; the run ends handed-back with its
 * document. `handback`/`decline` are exempt — without them the host gets no result at all.
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
 * The handoff allowance itself — `deadlineStopsSteps`'s threshold as a NUMBER, so a caller that must fit work
 * inside the deadline does not re-read the env and disagree about where step work ends.
 */
export function handoffAllowanceMs(): number {
  return handoffDispatchTimeoutMs();
}

/**
 * Bound a long piece of work that runs AFTER something else in the same step: the time the deadline still
 * leaves, minus the allowance the handback needs. The engine consults the cycle arm only BETWEEN steps, so one
 * step with two long runs would otherwise outlive the deadline by the whole second run.
 *
 * Throws the handback-naming `VerifyInfraError` whenever the run may not start at all. `full` is returned when
 * there is no deadline: an absent deadline is never a reason to shrink a timeout.
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
 * The reason line the engine stamps when the run stops at a step boundary without a verdict. `cause` names
 * what stopped it (`cycle deadline <epoch> reached`, `job killed`); `why` is the reader that stopped it,
 * appended verbatim so the record says which; omit it and the sentence is the plain one.
 */
export function stopReason(steps: Step[], state: string, cause: string, why?: string): string {
  const last = steps[steps.length - 1];
  const lastText =
    last === undefined ? "no step ran" : `${last.key} ended ${last.outcome?.kind ?? "undecided"}`;
  return `${cause} at ${state}: ${lastText}, no new step started${why === undefined ? "" : `; ${why}`}`;
}
