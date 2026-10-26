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
 *   red + red, names neither run can place    → confirmed-red ("unplaceable-names")
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
import {
  type NameResolution,
  type NameRoots,
  compareNames,
  failingTestNames,
} from "./work-driver-verify-names.ts";

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

/**
 * The two runs a confirmation judged, kept so the evidence can name both.
 * A REUSED arm stands in for its own confirming run: the record states that the
 * probe watched both, which is the whole confirmation, and no second stream
 * exists to show.
 */
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
  /**
   * #1826 round 1 — the evidence sentence for the arms a name comparison cannot
   * answer: set when the two runs named failing tests that NO anchored comparison
   * could place, so the confirmation rests on two red runs and the operator is
   * told that rather than a name match that never happened.
   */
  namesUnplaceable?: true;
}

/**
 * A run's failing-test names: a base run is NAMED iff this list is non-empty.
 *
 * Relative names are ANCHORED here. The loop prints a failure under the tree it
 * executed in, but most harnesses print a path RELATIVE to that tree (`FAILED:
 * tests/a.ts`), and a relative spelling records nothing about which tree printed
 * it — `compareNames` refuses one, so two identically red runs printing
 * `tests/a.ts` came back "disagree" and every legitimate red base written that
 * way was refused. Joining the name with the run's OWN tree root is not a guess:
 * a relative path resolves against the cwd the run executed in, and that tree is
 * the one this seam created and named. A name the join cannot place — because no
 * root survives (a REUSED arm, whose throwaway checkout is already removed) —
 * stays exactly as printed and is counted unplaceable rather than compared, so
 * anchoring can only ever make a name MORE placeable, never place a lie.
 */
function namesOf(run: BaselineVerdict | undefined, root: string | undefined): string[] | undefined {
  if (run === undefined || run.status !== "red") return undefined;
  const names = failingTestNames(run.rawStream);
  if (names.length === 0) return undefined;
  // A REUSED arm has no stream and no tree left (see `BaseConfirmRoots`), so its
  // names stay unanchored — and it never needs the name rule anyway, because its
  // record already states its second run.
  const anchorable = run.reused !== true && root !== undefined && root !== "";
  return anchorable ? names.map((n) => anchorName(n, root as string)) : names;
}

/** `path` joined under `root` when it is relative; unchanged when absolute. */
function anchorName(path: string, root: string): string {
  return path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
}

/** True when a run printed any failing-test name at all. */
function named(names: readonly string[] | undefined): boolean {
  return names !== undefined && names.length > 0;
}

/**
 * The names two runs agree on, anchored in their own trees (see `BaseConfirmRoots`).
 *
 * One `NameResolution` memo is threaded through every comparison of the call:
 * `compareNames` re-walks each root and each name through `realpath` unless it is
 * given one, so without it a pair of runs printing C and B names costs 2·C·B
 * stat-heavy walks for a handful of directories that never change inside a call.
 */
function commonNames(
  first: readonly string[],
  second: readonly string[],
  roots: BaseConfirmRoots,
): string[] {
  const resolution: NameResolution = new Map();
  // The two runs are two trees, so each pair is compared against BOTH roots:
  // `changeRoots` carries the other run's tree and `probeRoot` this run's, which
  // is the shape `compareNames` strips on.
  const anchor = (a: string, b: string): boolean =>
    compareNames(
      a,
      b,
      { changeRoots: [roots.secondRoot], probeRoot: roots.firstRoot },
      resolution,
    ) === "same" ||
    compareNames(
      a,
      b,
      { changeRoots: [roots.firstRoot], probeRoot: roots.secondRoot },
      resolution,
    ) === "same";
  return first.filter((a) => second.some((b) => anchor(a, b)));
}

/**
 * True when a run's names are all uncomparable because NO run's names could be
 * placed in a tree at all.
 *
 * Two spellings of one failure — an absolute one from a gate that prints `$PWD`,
 * a relative one from a harness that prints its own cwd-relative path — can
 * never be placed against each other by an anchored comparison, and reporting
 * that as "the runs named different tests" would refuse a base that failed twice
 * in the same way. When every name of BOTH runs comes back unplaceable there is
 * no name evidence either way, so the caller falls back to the arm a stream that
 * named nothing uses: red twice is sufficient, and the evidence says so.
 */
function everyNameUnplaceable(
  first: readonly string[],
  second: readonly string[],
  roots: BaseConfirmRoots,
): boolean {
  const resolution: NameResolution = new Map();
  const placeable = (name: string): boolean =>
    second.some(
      (b) =>
        compareNames(
          name,
          b,
          { changeRoots: [roots.secondRoot], probeRoot: roots.firstRoot },
          resolution,
        ) !== "unknown" ||
        compareNames(
          name,
          b,
          { changeRoots: [roots.firstRoot], probeRoot: roots.secondRoot },
          resolution,
        ) !== "unknown",
    );
  return [...first, ...second].every((name) => !placeable(name));
}

/**
 * The arms `decided` accepts. `unplaceable-names` is one of them and NOT a member
 * of `BaseRedConfirmation`: it confirms, and callers decide on `confirmation`, so
 * what they receive is `confirmed-red` carrying the structured flag that says the
 * claim rests on two red runs rather than on a name comparison nobody made.
 */
type DecidedConfirmation = BaseRedConfirmation | "unplaceable-names";

function decided(
  confirmation: DecidedConfirmation,
  runs: BaseRedConfirmationRuns,
  ranSecond: boolean,
  firstNames?: string[],
  secondNames?: string[],
  commonNames?: string[],
): BaseRedConfirmationResult {
  // `unplaceable-names` is an internal arm: it confirms, and callers decide on
  // `confirmation`, so what they receive is `confirmed-red` with the structured
  // flag that says the claim rests on two red runs, not on a name comparison.
  const unplaceable = confirmation === "unplaceable-names";
  return {
    confirmation: unplaceable ? "confirmed-red" : confirmation,
    first: runs.first,
    ...(runs.second === undefined ? {} : { second: runs.second }),
    ranSecond,
    ...(firstNames === undefined ? {} : { firstNames }),
    ...(secondNames === undefined ? {} : { secondNames }),
    ...(commonNames === undefined ? {} : { commonNames }),
    ...(unplaceable ? { namesUnplaceable: true as const } : {}),
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
  // A REUSED arm is ANSWERED FROM ITS RECORD rather than by re-running the gate.
  // `secondRun: "red"` is the one thing that may say the base failed twice: the
  // probe watched both runs when it wrote it, and the throwaway tree that printed
  // either stream is gone — so a second run here buys a full suite execution for an
  // answer the cycle already holds, and the name rule could not anchor the pair
  // anyway (a reused arm carries no stream, so its names are unplaceable and the
  // pair would come back "exactly one run named", discarding a confirmation this
  // cycle already paid for).
  //
  // A record stating any other colour, or nothing, has been judged ONCE, and #1826
  // does not act on once. That answer is returned, not left to the probe: the
  // caller's reuse branch injects a probe that REJECTS on purpose — reaching it is
  // the failure its assertion is made of, never a run to be quietly bought — so a
  // refusal that fell through would fault the comparison instead of reporting the
  // colour for what it is.
  if (first.reused === true) {
    return first.secondRun === "red"
      ? decided("confirmed-red", { first, second: first }, false)
      : decided("not-confirmed", { first }, false);
  }
  const second = await probe(BASE_CONFIRM_SECOND_LABEL, timeoutMs);
  const firstNames = namesOf(first, roots.firstRoot);
  const secondNames = namesOf(second, roots.secondRoot);
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
  if (!named(firstNames) && !named(secondNames)) {
    // Neither run named anything — the non-loop-gate case, and the reason the
    // rule is not "names must overlap": red twice is sufficient here.
    return decided("confirmed-red", { first, second }, true);
  }
  if (!named(firstNames) || !named(secondNames)) {
    // Exactly one run saw which test broke. That is a disagreement between the
    // runs about what they judged, so it is not baseline-red.
    return decided("names-disagree", { first, second }, true, firstNames, secondNames);
  }
  // The `unplaceable-names` arm confirms exactly as "neither run named" does, and
  // is reported to the caller as that arm so no caller has to learn a fourth value
  // to decide whether a base may be claimed; the structured `namesUnplaceable` and
  // the prose below carry the distinction the operator reads. The `!named` guards
  // above narrow both lists, which is what makes them assignable here.
  if (firstNames === undefined || secondNames === undefined) {
    // Unreachable: the two guards above returned on either list being empty.
    return decided("names-disagree", { first, second }, true, firstNames, secondNames);
  }
  const both: [readonly string[], readonly string[]] = [firstNames, secondNames];
  if (everyNameUnplaceable(both[0], both[1], roots)) {
    // Neither run's names could be placed in a tree — so the name rule has read
    // nothing, and "the runs disagree" would be a verdict on an absence of
    // evidence. Same arm as a stream that named nothing (red twice suffices), and
    // the caller's note names the difference.
    return decided("unplaceable-names", { first, second }, true, firstNames, secondNames);
  }
  const common = commonNames(both[0], both[1], roots);
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
  // Only an anchored comparison may claim the runs AGREED on a name. When nothing
  // could be placed the sentence says so, because the alternative — printing the
  // two runs' names side by side — reads as a comparison this seam never made.
  const common =
    result.commonNames === undefined || result.commonNames.length === 0
      ? result.namesUnplaceable === true
        ? " — the runs' failing-test names could not be placed in either tree, so the claim rests on two red runs rather than on a name match"
        : ""
      : ` — both runs named: ${result.commonNames.slice(0, 4).join(", ")}`;
  return `${runLine("base run 1", result.first)}${namesSuffix(runNames(result.first, result.firstNames))}; ${runLine("base run 2", result.second)}${namesSuffix(runNames(result.second, result.secondNames))}${common}`;
}
