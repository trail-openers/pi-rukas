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
import {
  type BaselineVerdict,
  type RedBaselineVerdict,
  isRedBaseline,
} from "./work-driver-verify-baseline.ts";
import { type NameRoots, compareNames, failingTestNames } from "./work-driver-verify-names.ts";

/** The label of the first base run of a confirmation — the probe's own tree. */
export const BASE_CONFIRM_FIRST_LABEL = "base1";
/**
 * The label of the confirming run. Distinct from the first on purpose: the
 * second run is a fresh `git worktree add` of the same base commit, because a
 * reused tree inherits whatever the first run's gate wrote into its own
 * checkout — which is a second source of flakiness, not a control.
 */
export const BASE_CONFIRM_SECOND_LABEL = "base2";

/**
 * The two trees a base run's names are anchored in.
 *
 * Each run prints its failures under ITS OWN absolute tree, and the two runs of
 * one confirmation are two different throwaway checkouts of one commit — so raw
 * string equality between their names is false for every test in the repo, and a
 * rule built on it would refuse every legitimate red base. This is the same
 * anchoring #1404's commit-pr attribution uses (`compareNames`): a name must sit
 * inside one of the trees this seam knows, and the paths RELATIVE to those roots
 * must be equal.
 */
export interface BaseConfirmRoots {
  /** The first run's throwaway tree. */
  firstRoot: string;
  /** The confirming run's throwaway tree. */
  secondRoot: string;
}

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
  firstNames?: readonly string[];
  /** The confirming run's names, when it ran and its stream carried them. */
  secondNames?: readonly string[];
  /** Names both red runs named — the overlap the confirmed-red arm requires. */
  commonNames?: readonly string[];
}

/** A run's failing-test names: a base run is NAMED iff this list is non-empty. */
function namesOf(run: BaselineVerdict | undefined, root: string | undefined): string[] | undefined {
  if (run === undefined || run.status !== "red") return undefined;
  // A REUSED arm carries the stream the probe read, but the throwaway tree that
  // printed it is gone — so its names are unplaceable and stay unanchored. That
  // is the honest shape: `compareNames` cannot put a path in a tree it cannot
  // name, and an unanchored name matches nothing (see `BaseConfirmRoots`). A
  // reused arm never needs the name rule anyway — the record already states its
  // second run — so the roots only matter for runs this seam just watched.
  if (run.reused === true || root === undefined || root === "") {
    const bare = failingTestNames(run.rawStream);
    return bare.length > 0 ? bare : undefined;
  }
  const names = failingTestNames(run.rawStream);
  return names.length > 0 ? names : undefined;
}

/** The names two runs agree on, anchored in their own trees (see `BaseConfirmRoots`). */
function commonNames(
  first: readonly string[],
  second: readonly string[],
  roots: BaseConfirmRoots,
): string[] {
  // The two runs are two trees, so each pair is compared against BOTH roots:
  // `changeRoots` carries the other run's tree and `probeRoot` this run's, which
  // is the shape `compareNames` strips on.
  const anchor = (a: string, b: string): boolean =>
    compareNames(a, b, { changeRoots: [roots.secondRoot], probeRoot: roots.firstRoot }) ===
      "same" ||
    compareNames(a, b, { changeRoots: [roots.firstRoot], probeRoot: roots.secondRoot }) === "same";
  return first.filter((a) => second.some((b) => anchor(a, b)));
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
  /**
   * The two trees the runs execute in — required to compare their names. Omit
   * them (or pass empty strings) when a run's tree no longer exists, as for a
   * REUSED arm whose throwaway checkout was already removed: anchoring is then
   * impossible, and the caller is asserting that this arm's confirmation came
   * from its record rather than from a name comparison.
   */
  roots: BaseConfirmRoots = { firstRoot: "", secondRoot: "" },
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
  // A REUSED arm's confirmation lives in its RECORD, not in a re-run: `secondRun:
  // "red"` is the colour the probe itself watched, and the tree that printed the
  // stream is gone, so a second run would buy evidence the name rule cannot anchor
  // while paying a full suite run for an answer the record already holds. Short of
  // this short-circuit the reused colour fell into the "exactly one run named" arm
  // below and came back `names-disagree` — a confirmation this cycle had already
  // paid for, thrown away by a comparison it cannot perform.
  //
  // A reused arm stating any OTHER colour (or nothing) is a colour and not an
  // answer: it was judged once, which is what #1826 refuses to act on. It is
  // refused HERE rather than sent to the probe below, because the caller's reuse
  // branch injects a probe that REJECTS on purpose — reaching it is the failure
  // that assertion is made of, never a suite run to be quietly paid for.
  //
  // `second` is the arm itself, not a run: on a reused arm there is exactly ONE
  // base run, and the record's `secondRun` field is what says a second was run and
  // agreed. Handing `baseRunsProse` the same verdict under both labels — which is
  // what the shape of the type forces, since a `second` is only "absent" when the
  // question was never asked — keeps the evidence naming BOTH runs (the #1826
  // requirement) while being honest that this seam watched one.
  if (first.reused === true && (first.secondRun === undefined || first.secondRun === "red")) {
    // `second` is the arm itself, not a run: a reused arm has exactly ONE base run,
    // and the record's `secondRun` field is what says a second was run and agreed.
    // Handing `baseRunsProse` the same verdict under both labels — which is what the
    // shape of the type forces, since a `second` is only "absent" when the question
    // was never asked — keeps the evidence naming BOTH runs (the #1826 requirement)
    // while `runNames` keeps it from attributing a test to a run that named none.
    return decided("confirmed-red", { first, second: first }, false);
  }
  const second = await probe(BASE_CONFIRM_SECOND_LABEL, timeoutMs);
  const firstNames = namesOf(first, roots.firstRoot);
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
  const secondNames = namesOf(second, roots.secondRoot);
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
  const common = commonNames(firstNames, secondNames, roots);
  if (common.length === 0) {
    return decided("names-disagree", { first, second }, true, firstNames, secondNames);
  }
  return decided("confirmed-red", { first, second }, true, firstNames, secondNames, common);
}

/** The operator's line for one base run, naming which run it was. */
function runLine(which: string, run: BaselineVerdict): string {
  // A REUSED arm is a colour, not a stream: the record carries the arm
  // (`timedOut`) but no output, so it may be reported as the arm it is and never
  // as a test the probe watched. Rebuilding a plain `red` from a killed record is
  // the #1765 lens-round-1 defect — it tells an operator to go fix a test nobody
  // ran — and it is why this reads the arm before any colour shorthand.
  if (run.status === "red-timed-out") return `${which}: FAILED, killed at its bound`;
  if (run.status === "red") return `${which}: FAILED`;
  if (run.status === "green") return `${which}: PASSED`;
  return `${which}: not established (${run.reason})`;
}

/**
 * The names one run's evidence carries, for the operator's line.
 *
 * A REUSED arm is asked for NOTHING: its record has no stream, and the run it
 * describes happened in a tree this seam cannot see. Printing the live second
 * run's names under "base run 1" would attribute a test to a run that named no
 * test — and on a reused arm the whole evidence sentence is the one sentence an
 * operator acts on.
 */
function runNames(
  run: BaselineVerdict | RedBaselineVerdict,
  names: readonly string[] | undefined,
): readonly string[] | undefined {
  if (run.status !== "red" && run.status !== "red-timed-out") return names;
  if (run.reused === true) return undefined;
  return names === undefined || names.length === 0 ? undefined : [...names];
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
  return `${runLine("base run 1", result.first)}${namesSuffix(runNames(result.first, result.firstNames))}; ${runLine("base run 2", result.second)}${namesSuffix(runNames(result.second, result.secondNames))}${common}`;
}
