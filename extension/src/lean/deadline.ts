/**
 * lean/deadline — the caller's whole-cycle deadline, read the way `work` reads
 * it (#1920 item 2).
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

/** One minute, the unit `--timeout` is given in — the same constant `work` uses. */
export const MINUTE_MS = 60_000;

/**
 * The flag's own arm, in the same shape the environment's two inputs use: a
 * duration in ms, resolved to an epoch by the reader — never a written env var.
 *
 * `--timeout` is the HOST's input to the one contract (`work`'s reader is the
 * only thing that parses the two env names), and the resolution is the shared
 * reader's. Writing the flag into `process.env` — which an earlier shape of this
 * did — would leak one run's budget into every later dispatch of the process and
 * leave a parent with no deadline it can read back.
 *
 * `--timeout` yields to both env inputs: an explicit absolute deadline outranks a
 * duration, and a budget the host exported itself outranks the flag, because that
 * export is the host's own word for how long the cycle may run.
 */
export function flagBudgetMs(timeoutMs: number | undefined): CycleBudgetMs | undefined {
  return timeoutMs === undefined ? undefined : (timeoutMs as CycleBudgetMs);
}

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
