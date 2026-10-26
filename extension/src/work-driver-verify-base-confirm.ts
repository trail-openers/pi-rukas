/**
 * work-driver-verify-base-confirm — #1826: a base commit is red TWICE before a
 * cycle may park as `verify-baseline-red`.
 *
 * Why (#1826): one production repository, one day, ten of twenty /work cycles
 * parked as `verify-baseline-red` on a SINGLE red run of the whole-command base
 * probe — four of them inside one 40-minute window, while a fifth cycle started
 * inside that window ran the same check on the same mainline, passed it, and
 * merged. The park's evidence said "no specific assertion could be extracted",
 * so the red that failed ten cycles named no test at all. A single run of a
 * loaded host's gate is not evidence about an immutable commit: queueing behind
 * other cycles' verify slots, a per-test kill, or a dependency that settled late
 * all make one run lie.
 *
 * #1647's selected-verify path already refused this (`judge` in
 * `work-driver-verify-select-exec.ts` runs `probe` then `probe2` and requires
 * red on both). This module extends that discipline to the whole-command probe
 * every project uses. It is a behavioural model only: the selected-verify code
 * is neither changed nor reused, and this seam makes its own second
 * `probeBaselineVerify` call.
 *
 * The decision rule, in one table (first run → second run → answer):
 *
 *   red / red-timed-out     → no second run at all: today's routing is kept
 *   unknown / green         → no second run at all (not red)
 *   red + green             → not-confirmed  (a flaky base; never a park)
 *   red + unknown           → not-confirmed
 *   red + red-timed-out     → not-confirmed
 *   red + red, names on both, ≥1 common name → confirmed-red
 *   red + red, names on both, disjoint        → names-disagree
 *   red + red, names on exactly one           → names-disagree
 *   red + red, names on neither               → confirmed-red
 *
 * The name rule's arms are not decoration. `failingTestNames` returns `[]`
 * whenever the stream's `FAILED: <n> test(s)` summary disagrees with its
 * per-file markers — the normal outcome for a non-loop gate — so a rule that
 * required names would refuse every legitimate red base. Requiring nothing on
 * both would let two runs that failed DIFFERENT tests excuse each other, and
 * "one side named" is precisely that shape: one run saw which test broke, the
 * other saw nothing, and the disagreement is between the runs, not between the
 * base and the change.
 *
 * What this module never does: it never runs the gate itself (the caller injects
 * `probe`, which is `probeBaselineVerify` in production — so the second run's
 * cost, its bound, and its fresh tree are the caller's to pin), never treats a
 * killed or unreadable run as a confirming red, and never caches.
 */
import { type BaselineVerdict, isRedBaseline } from "./work-driver-verify-baseline.ts";
import { failingTestNames } from "./work-driver-verify-names.ts";

/** The label of the first base run of a confirmation — the probe's own tree. */
export const BASE_CONFIRM_FIRST_LABEL = "base1";
/**
 * The label of the confirming run. Distinct from the first on purpose: the
 * second run is a fresh `git worktree add` of the same base commit, because a
 * reused tree inherits whatever the first run's gate wrote into its own
 * checkout — which is a second source of flakiness, not a control.
 */
export const BASE_CONFIRM_SECOND_LABEL = "base2";

/** What the two base runs established, as the callers of this rule report it. */
export type BaseRedConfirmation = "confirmed-red" | "not-confirmed" | "names-disagree";

/** The two runs a confirmation judged, kept so the evidence can name both. */
export interface BaseRedConfirmationRuns {
  /** The run that asked the question: the probe's first run at the base. */
  first: BaselineVerdict;
  /** The confirming run — absent when the first run's arm decided alone. */
  second?: BaselineVerdict;
}

export interface BaseRedConfirmationResult extends BaseRedConfirmationRuns {
  confirmation: BaseRedConfirmation;
  /** True when a second run of the gate was paid for. */
  ranSecond: boolean;
  /** The first run's names, when its stream carried them (see the header). */
  firstNames?: string[];
  /** The confirming run's names, when it ran and its stream carried them. */
  secondNames?: string[];
  /** Names both red runs named — the overlap the confirmed-red arm requires. */
  commonNames?: string[];
}

/** A run's failing-test names: a base run is NAMED iff this list is non-empty. */
function namesOf(run: BaselineVerdict | undefined): string[] | undefined {
  if (run === undefined || run.status !== "red") return undefined;
  const names = failingTestNames(run.rawStream);
  return names.length > 0 ? names : undefined;
}

/** The names two runs agree on, in the first run's order. */
function intersect(first: readonly string[], second: readonly string[]): string[] {
  const set = new Set(second);
  return first.filter((n) => set.has(n));
}

function decided(
  confirmation: BaseRedConfirmation,
  runs: BaseRedConfirmationRuns,
  ranSecond: boolean,
  firstNames?: string[],
  secondNames?: string[],
  commonNames?: string[],
): BaseRedConfirmationResult {
  return {
    confirmation,
    first: runs.first,
    ...(runs.second === undefined ? {} : { second: runs.second }),
    ranSecond,
    ...(firstNames === undefined ? {} : { firstNames }),
    ...(secondNames === undefined ? {} : { secondNames }),
    ...(commonNames === undefined ? {} : { commonNames }),
  };
}

/**
 * Judge a first red base run, running the gate a second time when (and only
 * when) the first run's arm leaves the question open.
 *
 * `probe` is the seam's whole cost: one run of the project's command on a fresh
 * checkout of `baseSha` under `label`, bounded by `timeoutMs`. The caller owns
 * all four — this module decides WHETHER a run is owed, never how it is paid for.
 */
export async function confirmRedBase(
  first: BaselineVerdict,
  /**
   * Run the project's command once, on a FRESH checkout of the base commit, under
   * `label`. The production caller passes a bound `probeBaselineVerify`; a test
   * injects the arm it wants to observe. `timeoutMs` is the first run's tier
   * bound, and the production caller hands it to the exec verbatim, so the second
   * run is bounded by the same wall clock as the first.
   */
  probe: (label: string, timeoutMs: number) => Promise<BaselineVerdict>,
  timeoutMs: number,
): Promise<BaseRedConfirmationResult> {
  // A first `red-timed-out` is a red arm for TODAY's routing (the timeout
  // evidence, the timeout's cap precedence) but it judged nothing, so there is
  // no second run to reason about: it keeps its existing route untouched rather
  // than paying a full suite run to re-learn that the gate cannot finish.
  if (first.status === "red-timed-out") return decided("not-confirmed", { first }, false);
  // `green` and `unknown` are not red: nothing to confirm, and the PM decision
  // for a first `unknown` is explicit — a run that reached no verdict triggers
  // no second run. Both reach here only on the red branch of the callers, so an
  // answer here is a defensive one, never a route a cycle takes.
  if (!isRedBaseline(first)) return decided("not-confirmed", { first }, false);
  const second = await probe(BASE_CONFIRM_SECOND_LABEL, timeoutMs);
  const firstNames = namesOf(first);
  // A killed second run judged nothing, so it confirms nothing — even though
  // `red-timed-out` IS a red arm for today's other seams (a killed run still
  // means "the gate cannot finish"). Reading it as a confirming red is the
  // #1765 lens-round-1 shape this rule refuses to repeat, and it is why the
  // check below is on the arm rather than on `isRedBaseline`.
  if (second.status !== "red") {
    // Green, unknown or killed: the base is not established red, so the cycle
    // does not park as baseline-red and the develop failure is attributed the
    // way a green base attributes it.
    return decided("not-confirmed", { first, second }, true, firstNames);
  }
  const secondNames = namesOf(second);
  if (firstNames === undefined && secondNames === undefined) {
    // Neither run named anything — the non-loop-gate case, and the reason the
    // rule is not "names must overlap": red twice is sufficient here.
    return decided("confirmed-red", { first, second }, true);
  }
  if (firstNames === undefined || secondNames === undefined) {
    // Exactly one run saw which test broke. That is a disagreement between the
    // runs about what they judged, so it is not baseline-red.
    return decided("names-disagree", { first, second }, true, firstNames, secondNames);
  }
  const common = intersect(firstNames, secondNames);
  if (common.length === 0) {
    return decided("names-disagree", { first, second }, true, firstNames, secondNames);
  }
  return decided("confirmed-red", { first, second }, true, firstNames, secondNames, common);
}

/** The operator's line for one base run, naming which run it was. */
function runLine(which: string, run: BaselineVerdict): string {
  if (run.status === "red") return `${which}: FAILED`;
  if (run.status === "red-timed-out") return `${which}: FAILED, killed at its bound`;
  if (run.status === "green") return `${which}: PASSED`;
  return `${which}: not established (${run.reason})`;
}

/** The names a run carried, bounded so the evidence line stays short. */
function namesSuffix(names: readonly string[] | undefined): string {
  if (names === undefined) return "";
  const shown = names.slice(0, 4).join(", ");
  return ` — named: ${shown}${names.length > 4 ? `, +${names.length - 4} more` : ""}`;
}

/**
 * The prose that names BOTH base runs, appended to a confirmed-red finding.
 * Today's single-arm message says "the gate was red before this change was
 * written"; an operator reading it cannot tell one run from a confirmation, and
 * the whole point of #1826 is that a single run is not what parked the cycle.
 * Absent for a first run that decided alone (timed-out), which never confirms.
 */
export function baseRunsProse(result: BaseRedConfirmationResult): string {
  if (result.second === undefined) return "";
  const common =
    result.commonNames === undefined || result.commonNames.length === 0
      ? ""
      : ` — both runs named: ${result.commonNames.slice(0, 4).join(", ")}`;
  return `${runLine("base run 1", result.first)}${namesSuffix(result.firstNames)}; ${runLine("base run 2", result.second)}${namesSuffix(result.secondNames)}${common}`;
}
