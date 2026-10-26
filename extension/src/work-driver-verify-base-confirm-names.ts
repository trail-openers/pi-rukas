import type { BaseConfirmRoots } from "./work-driver-verify-base-confirm.ts";
/**
 * work-driver-verify-base-confirm-names — the failing-test NAME rule of a #1826
 * base confirmation.
 *
 * The decision table lives in `work-driver-verify-base-confirm.ts`; this module
 * answers the one question inside it that needs the filesystem: do these two runs
 * name the SAME failing test? They are separate because the rule is a lookup over
 * two throwaway trees and the table is a pure function of the arms — different
 * failure modes, different reviews, and the tree work is where the cost of a
 * confirmation lives (`compareNames` walks each root through `realpath`).
 *
 * The rule, in one line: a base run is NAMED iff its stream carried at least one
 * failing-test name, and two runs agree when an anchored comparison places the same
 * path in one of the two trees. A name neither comparison can place is not evidence
 * of a disagreement — it is the absence of name evidence, and the caller decides on
 * "red twice" instead (see `everyNameUnplaceable`).
 */
import type { BaselineVerdict } from "./work-driver-verify-baseline.ts";
import { type NameResolution, compareNames, failingTestNames } from "./work-driver-verify-names.ts";

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
 * the one the caller created and named. A name the join cannot place — because no
 * root survives (a REUSED arm, whose throwaway checkout is already removed) —
 * stays exactly as printed and is counted unplaceable rather than compared, so
 * anchoring can only ever make a name MORE placeable, never place a lie.
 */
export function namesOf(
  run: BaselineVerdict | undefined,
  root: string | undefined,
): string[] | undefined {
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
export function named(names: readonly string[] | undefined): boolean {
  return names !== undefined && names.length > 0;
}

/**
 * Compare one pair of names against BOTH trees, with one shared `NameResolution`
 * memo for the whole call.
 *
 * The memo is load-bearing for cost: `compareNames` re-walks each root and each name
 * through `realpath` unless it is given one, so without it a pair of runs printing C
 * and B names costs 2·C·B stat-heavy walks for a handful of directories that never
 * change inside a call.
 *
 * Each pair is tried in both orientations because the two runs live in two trees:
 * `changeRoots` carries one run's tree and `probeRoot` the other's, and either run
 * may be the one whose absolute spelling is the comparable one.
 */
function pairIsSame(
  a: string,
  b: string,
  roots: BaseConfirmRoots,
  resolution: NameResolution,
): boolean {
  return (
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
    ) === "same"
  );
}

/** The names two runs agree on, anchored in their own trees (see `BaseConfirmRoots`). */
export function commonNames(
  first: readonly string[],
  second: readonly string[],
  roots: BaseConfirmRoots,
): string[] {
  const resolution: NameResolution = new Map();
  return first.filter((a) => second.some((b) => pairIsSame(a, b, roots, resolution)));
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
export function everyNameUnplaceable(
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
