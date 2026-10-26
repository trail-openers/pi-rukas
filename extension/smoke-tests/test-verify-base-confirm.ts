#!/usr/bin/env bun
/**
 * #1826 — the second base run and the decision rule, in the leaf that owns them.
 *
 * Ten of twenty /work cycles on one repository parked as `verify-baseline-red`
 * on a SINGLE red run of the whole-command base probe, four inside one
 * 40-minute window, while a fifth cycle in that same window ran the same check
 * on the same mainline, passed, and merged. This file pins the rule that closes
 * it: a first red is confirmed by a second run of the same command on a FRESH
 * tree of the same base commit, and only these outcomes are a red base:
 *
 *   red + red, names on both, ≥1 common name → confirmed-red
 *   red + red, names on neither              → confirmed-red
 *   red + green / unknown / killed            → not-confirmed
 *   red + red, names disjoint or one-sided   → names-disagree
 *   first run red-timed-out / unknown        → not-confirmed, NO second run
 *
 * `probe` is injected, so every arm is a returned `BaselineVerdict` and the
 * counters below observe the run the rule asked for: a case that asserts an
 * outcome without asserting the run count is a case that passes when the rule
 * never ran the gate at all.
 */
import {
  BASE_CONFIRM_SECOND_LABEL,
  type BaseRedConfirmation,
  ONE_SIDED_NAMES_OUTCOME,
  confirmRedBase,
} from "../src/work-driver-verify-base-confirm.ts";
import {
  baseRunsProse,
  confirmingOutcomeProse,
} from "../src/work-driver-verify-base-confirm-prose.ts";
import type { BaselineVerdict } from "../src/work-driver-verify-baseline.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BOUND = 60_000;

/** A red arm whose stream the name reader can judge. */
const red = (stream = "no markers at all"): BaselineVerdict => ({
  status: "red",
  rawStream: stream,
  probed: false,
  exitCode: 1,
  assertion: null,
});
const green = (): BaselineVerdict => ({ status: "green" });
const killed = (): BaselineVerdict => ({ status: "red-timed-out", assertion: null });
const unknown = (): BaselineVerdict => ({ status: "unknown", reason: "worktree add failed" });

/**
 * The two trees one confirmation runs in. A name is compared ANCHORED in the tree
 * that printed it (`BaseConfirmRoots`): the same test appears under a different
 * absolute prefix in each throwaway checkout, so raw string equality between the
 * two runs' names is false for every test in the repo, and a rule built on it would
 * refuse every legitimate red base. A bare, unplaceable name matches nothing.
 */
const TREE_ONE = "/tmp/pi-confirm/tree-one";
const TREE_TWO = "/tmp/pi-confirm/tree-two";
const ROOTS = { firstRoot: TREE_ONE, secondRoot: TREE_TWO };

/**
 * The pair of trees a comparison can ACTUALLY place names in. The two above are
 * synthetic paths that name no directory, which is honest for the absolute case
 * (`asPath` resolves the longest existing prefix, `/tmp`, and keeps the tail) but
 * not for the relative one: a relative name normalises to a path WITHOUT a leading
 * slash, so it resolves under the process's cwd and can never sit under either
 * root. These are real directories under the temp dir, so a relative name joined
 * onto one of them strips the way a real run's does — which is the only way a case
 * can tell "the two runs named the same test" apart from "nothing was placeable".
 */
const REAL_ONE = mkdtempSync(path.join(tmpdir(), "pi-confirm-one-"));
const REAL_TWO = mkdtempSync(path.join(tmpdir(), "pi-confirm-two-"));
const REAL_ROOTS = { firstRoot: REAL_ONE, secondRoot: REAL_TWO };
// A subtree that exists IN BOTH temp trees, so a name under it is placeable the
// way a real run's is. Unlike an absolute name under a tree that was never created
// (`asPath` still resolves its longest existing prefix), a RELATIVE name joined
// onto a root that does not exist has no prefix left to resolve, so `compareNames`
// cannot place it — the fixture's trees therefore have to exist on disk, and to
// carry the directory the names cite.
const REAL_SUB = "extension/smoke-tests";
for (const tree of [REAL_ONE, REAL_TWO]) {
  mkdirSync(path.join(tree, REAL_SUB), { recursive: true });
}

/**
 * The loop's own triad: per-file markers anchored in the tree that ran, plus a
 * summary whose count agrees with them. Anything else and `failingTestNames`
 * returns `[]`, which is the "no names" arm — so a case that wants names has to
 * print this shape rather than any line beginning `FAILED:`.
 */
const named = (tree: string, ...paths: string[]): string => {
  // A relative spelling is what most harnesses print (`FAILED: tests/a.ts`,
  // relative to the tree the run executed in) — the shape the anchoring rule
  // exists for. An empty tree prints the names bare, which is how a case stages
  // names no anchored comparison can place.
  const spell = (p: string): string => (tree === "" ? p : `${tree}/${p}`);
  return [
    ...paths.map((p) => `FAILED: ${spell(p)}`),
    `FAILED: ${paths.length} test(s) — ${paths.map((p) => spell(p)).join(", ")}`,
  ].join("\n");
};

/** What one call to `confirmRedBase` did: the answer, and the runs it paid for. */
interface Recorded {
  confirmation: BaseRedConfirmation;
  probes: Array<{ label: string; timeoutMs: number }>;
  result: Awaited<ReturnType<typeof confirmRedBase>>;
}

async function run(
  first: BaselineVerdict,
  arms: BaselineVerdict[],
  opts: { throwOn?: number; roots?: typeof ROOTS } = {},
): Promise<Recorded> {
  const probes: Array<{ label: string; timeoutMs: number }> = [];
  const result = await confirmRedBase(
    first,
    async (label, timeoutMs) => {
      probes.push({ label, timeoutMs });
      if (opts.throwOn !== undefined && probes.length === opts.throwOn) {
        throw new Error("the injected probe threw");
      }
      return arms[probes.length - 1] ?? green();
    },
    BOUND,
    opts.roots ?? { firstRoot: "", secondRoot: "" },
  );
  return { confirmation: result.confirmation, probes, result };
}

// ── the arms a second run reaches, and what each one decides ──
const secondRunCases: Array<[string, BaselineVerdict, BaseRedConfirmation, boolean]> = [
  ["red + red, no names", red(), "confirmed-red", true],
  ["red then green", green(), "not-confirmed", true],
  ["red then unknown", unknown(), "not-confirmed", true],
  ["red then killed at its bound", killed(), "not-confirmed", true],
];
for (const [label, second, want, ranSecond] of secondRunCases) {
  const r = await run(red(), [second]);
  assert(r.confirmation === want, `${label}: the decision is ${want} (got ${r.confirmation})`);
  assert(
    r.probes.length === (ranSecond ? 1 : 0),
    `${label}: ${ranSecond ? "one confirming run was paid for" : "no second run was paid for"} (got ${r.probes.length})`,
  );
  assert(
    r.result.second === undefined ? !ranSecond : r.result.second === second,
    `${label}: the record carries the confirming run it judged (got ${r.result.second?.status ?? "none"})`,
  );
}

// ── the name rule, three arms ──
{
  const overlap = await run(
    red(named(TREE_ONE, "tests/a.ts", "tests/b.ts")),
    [red(named(TREE_TWO, "tests/b.ts", "tests/c.ts"))],
    { roots: ROOTS },
  );
  assert(
    overlap.confirmation === "confirmed-red" &&
      overlap.result.commonNames?.length === 1 &&
      overlap.result.commonNames[0] === `${TREE_ONE}/tests/b.ts`,
    `names on both, one common: confirmed-red and the overlap is named (got ${overlap.confirmation}, ${JSON.stringify(overlap.result.commonNames)})`,
  );
  assert(
    overlap.result.firstNames?.length === 2 && overlap.result.secondNames?.length === 2,
    "names on both: each run's own names are kept for the evidence",
  );
}
{
  const disjoint = await run(
    red(named(TREE_ONE, "tests/a.ts")),
    [red(named(TREE_TWO, "tests/z.ts"))],
    { roots: ROOTS },
  );
  assert(
    disjoint.confirmation === "names-disagree" &&
      disjoint.result.commonNames === undefined &&
      disjoint.probes.length === 1,
    `names on both, disjoint: names-disagree after one confirming run (got ${disjoint.confirmation}, ${disjoint.probes.length} probes)`,
  );
  assert(
    disjoint.result.firstNames?.[0] === `${TREE_ONE}/tests/a.ts` &&
      disjoint.result.secondNames?.[0] === `${TREE_TWO}/tests/z.ts`,
    "names disjoint: both runs' names survive for the operator to read",
  );
}
{
  const oneSided = await run(red(named(TREE_ONE, "tests/a.ts")), [red("no markers at all")], {
    roots: ROOTS,
  });
  assert(
    oneSided.confirmation === "names-disagree" &&
      oneSided.result.firstNames !== undefined &&
      oneSided.result.secondNames === undefined,
    `names on exactly one run: names-disagree, never confirmed-red (got ${oneSided.confirmation})`,
  );
  const otherSide = await run(red("no markers at all"), [red(named(TREE_TWO, "tests/a.ts"))], {
    roots: ROOTS,
  });
  assert(
    otherSide.confirmation === "names-disagree" &&
      otherSide.result.firstNames === undefined &&
      otherSide.result.secondNames !== undefined,
    `names on the second run only: still names-disagree (got ${otherSide.confirmation})`,
  );
}
{
  const neither = await run(red("gate output with no markers"), [
    red("other gate output with no markers"),
  ]);
  assert(
    neither.confirmation === "confirmed-red" &&
      neither.result.firstNames === undefined &&
      neither.result.secondNames === undefined,
    "names on neither run: red twice is sufficient — a non-loop gate still parks",
  );
}

// ── #1826 round 2 — the one-sided case says "only one run named", not "different" ──
//
// Both one-sided arms refused the base before this round, but with a sentence that
// claimed the two runs named DIFFERENT failing tests. One of them named nothing, so
// the sentence sent an operator to diff two lists when one was never printed. The
// word is now the structured arm marker `ONE_SIDED_NAMES_OUTCOME`, and the disjoint
// arm keeps the old wording — so this pins BOTH sentences, and pins that they track
// the structured name lists rather than a reworded string.
{
  const oneSided = await run(red(named(TREE_ONE, "tests/a.ts")), [red("no markers at all")], {
    roots: ROOTS,
  });
  assert(
    oneSided.result.confirmingOutcome === ONE_SIDED_NAMES_OUTCOME,
    `names on the first run only: the outcome is the one-sided marker (got ${JSON.stringify(oneSided.result.confirmingOutcome)})`,
  );
  const mirrored = await run(red("no markers at all"), [red(named(TREE_TWO, "tests/a.ts"))], {
    roots: ROOTS,
  });
  assert(
    mirrored.result.confirmingOutcome === ONE_SIDED_NAMES_OUTCOME,
    `names on the second run only: the same one-sided marker whichever run went silent (got ${JSON.stringify(mirrored.result.confirmingOutcome)})`,
  );
  const disjoint = await run(red(named(TREE_ONE, "tests/a.ts")), [red(named(TREE_TWO, "tests/z.ts"))], {
    roots: ROOTS,
  });
  assert(
    disjoint.result.confirmingOutcome !== ONE_SIDED_NAMES_OUTCOME,
    `names on both, disjoint: NOT the one-sided marker — both runs printed a list, so they genuinely named different tests (got ${JSON.stringify(disjoint.result.confirmingOutcome)})`,
  );
}

// ── relative names, anchored in each run's own tree (round 1) ──
//
// Most harnesses print a failing test RELATIVE to the tree they ran in (`FAILED:
// tests/a.ts`), which is the shape the loop itself prints for a gate invoked from
// its own checkout. An anchored comparison refuses a relative name outright — it
// records nothing about which tree printed it — so before the join these two runs
// came back "disagree" and every legitimate red base printed this way was refused.
// The join is with the run's OWN tree, so agreement survives and disagreement still
// disagrees.
{
  // The two runs name THE SAME test in the only spelling most harnesses print
  // (relative to the tree that ran), and the runs execute in two different trees,
  // so the two spellings are equal strings. The join with each run's own tree root
  // is what makes the anchored comparison able to place them at all — without it
  // `compareNames` answers `unknown` for both and the pair falls to the
  // "nothing placeable" arm, which confirms but for the wrong reason. Asserting
  // the exact overlap is what tells the two arms apart.
  const twiceRedRelative = await run(
    red(named(REAL_ONE, `${REAL_SUB}/a.ts`, `${REAL_SUB}/b.ts`)),
    [red(named(REAL_TWO, `${REAL_SUB}/b.ts`, `${REAL_SUB}/c.ts`))],
    { roots: REAL_ROOTS },
  );
  assert(
    twiceRedRelative.confirmation === "confirmed-red" &&
      twiceRedRelative.result.namesUnplaceable === undefined &&
      twiceRedRelative.result.commonNames?.length === 1 &&
      twiceRedRelative.result.commonNames[0] === `${REAL_ONE}/${REAL_SUB}/b.ts`,
    `two identically red runs printing relative names: confirmed-red on the anchored shared name (got ${twiceRedRelative.confirmation}, ${JSON.stringify(twiceRedRelative.result.commonNames)}, unplaceable=${String(twiceRedRelative.result.namesUnplaceable)})`,
  );
}
{
  const disjointRelative = await run(
    red(named(REAL_ONE, `${REAL_SUB}/a.ts`)),
    [red(named(REAL_TWO, `${REAL_SUB}/z.ts`))],
    { roots: REAL_ROOTS },
  );
  assert(
    disjointRelative.confirmation === "names-disagree" && disjointRelative.probes.length === 1,
    `disjoint relative names stay a disagreement once anchored (got ${disjointRelative.confirmation})`,
  );
}
{
  // Neither run's names can be placed: the roots this seam was given name no
  // directory (the case a caller passes when a tree is already gone). The name
  // rule has read nothing, so the pair falls to the arm a stream that named
  // nothing uses — red twice — and the evidence says so rather than claiming a
  // match nobody compared.
  const unplaceable = await run(red(named("", "tests/a.ts")), [
    red(named("", "tests/a.ts")),
  ]);
  assert(
    unplaceable.confirmation === "confirmed-red" &&
      unplaceable.result.namesUnplaceable === true &&
      unplaceable.result.commonNames === undefined,
    `names neither run can place: red twice suffices, and the record says the names were not compared (got ${unplaceable.confirmation}, unplaceable=${String(unplaceable.result.namesUnplaceable)})`,
  );
  assert(
    baseRunsProse(unplaceable.result).includes("could not be placed in either tree"),
    `unplaceable names: the evidence names the absence instead of claiming a match (${JSON.stringify(baseRunsProse(unplaceable.result))})`,
  );
}

// ── the name rule stays linear in the number of names (round 1) ──
//
// `compareNames` re-walks every root and every name through `realpath` unless it
// is handed a memo, so without one a pair of runs printing N names each costs
// 2·N² stat-heavy walks. The 300-name case below is the detector: it passes in
// milliseconds with the memo and minutes without it, so the bound asserted here is
// generous on purpose — it is a regression tripwire, not a benchmark.
{
  const startedAt = Date.now();
  // The roots must be roots the comparison can actually strip: this repo's own
  // `smoke-tests` directory exists in both spellings of every tree, so a name
  // under it resolves through the longest existing prefix and gets placed. A path
  // that exists nowhere would take the "nothing placeable" arm and the 300 names
  // would never be compared at all — which is the vacuous version of this case.
  const many = Array.from({ length: 300 }, (_, i) => `${REAL_SUB}/t${i}.ts`);
  const wide = await run(red(named(REAL_ONE, ...many)), [
    red(named(REAL_TWO, ...many.slice(100))),
  ], { roots: REAL_ROOTS });
  const elapsed = Date.now() - startedAt;
  assert(
    wide.confirmation === "confirmed-red" &&
      wide.result.namesUnplaceable === undefined &&
      wide.result.commonNames?.length === 200,
    `300 names: the overlap is still computed exactly (got ${wide.confirmation}, ${wide.result.commonNames?.length}, unplaceable=${String(wide.result.namesUnplaceable)})`,
  );
  assert(
    elapsed < 5000,
    `300 names on both runs complete under a generous 5 s bound (took ${elapsed} ms — one memo per call, not one realpath per pair)`,
  );
}

// ── the arms that decide alone: no second run, ever ──
for (const [label, first] of [
  ["first run red-timed-out", killed()],
  ["first run unknown", unknown()],
  ["first run green", green()],
] as const) {
  const r = await run(first, [red()]);
  assert(
    r.probes.length === 0,
    `${label}: the gate ran NO second time (${r.probes.length} probes) — a probe cannot cost a suite run it did not earn`,
  );
  assert(
    r.confirmation === "not-confirmed" && r.result.second === undefined,
    `${label}: not-confirmed with no confirming run recorded (got ${r.confirmation})`,
  );
}

// ── the bound and the label the second run is paid under ──
{
  const r = await run(red(), [red()]);
  assert(
    r.probes.length === 1 && r.probes[0]?.timeoutMs === BOUND,
    `the confirming run is bounded by the first run's tier bound (got ${r.probes[0]?.timeoutMs})`,
  );
  assert(
    r.probes[0]?.label === BASE_CONFIRM_SECOND_LABEL && BASE_CONFIRM_SECOND_LABEL !== "base1",
    `the confirming run has its own label (${r.probes[0]?.label}) so it is a fresh tree, not the first run's`,
  );
}

// ── a confirming run that THREW is not-confirmed, and keeps the first red ──
//
// The alternative shapes are both wrong and both were reachable: folding the fault
// into `unknown` discards the run the cycle already paid for, and treating it as a
// red confirms a base nobody watched fail. So the answer is a refusal to confirm that
// keeps the first run's arm, records that a second run was paid for, and says in its
// own words that the confirming run could not be read.
{
  const threw = await run(red(), [], { throwOn: 1 });
  assert(
    threw.confirmation === "not-confirmed",
    `a confirming run that threw is not-confirmed (got ${threw.confirmation})`,
  );
  assert(
    threw.result.first.status === "red" && threw.result.second === undefined,
    "a confirming run that threw keeps the first run's red arm and records no confirming run",
  );
  assert(
    threw.result.ranSecond === true && threw.probes.length === 1,
    `a confirming run that threw is still recorded as PAID FOR (${threw.probes.length} probes, ranSecond=${String(threw.result.ranSecond)})`,
  );
  assert(
    (threw.result.confirmingOutcome ?? "").includes("could not be read"),
    `a confirming run that threw names its own outcome (got ${JSON.stringify(threw.result.confirmingOutcome)})`,
  );
  assert(
    !confirmingOutcomeProse(threw.result).includes("was green"),
    `a non-confirmed pair never reports a colour the run did not reach (${JSON.stringify(confirmingOutcomeProse(threw.result))})`,
  );
}

// ── the outcome prose names what the confirming run ACTUALLY reached ──
for (const [label, second, want] of [
  ["green", green(), "the confirming run was green"],
  ["killed", killed(), "the confirming run was killed at its bound"],
  ["unknown", unknown(), "the confirming run could not be read"],
] as const) {
  const r = await run(red(), [second]);
  assert(
    confirmingOutcomeProse(r.result) === want,
    `confirming-run prose (${label}): "${want}" (got ${JSON.stringify(confirmingOutcomeProse(r.result))})`,
  );
  assert(
    r.result.confirmation === "not-confirmed",
    `confirming-run prose (${label}): not-confirmed, never a claim (got ${r.result.confirmation})`,
  );
}

rmSync(REAL_ONE, { recursive: true, force: true });
rmSync(REAL_TWO, { recursive: true, force: true });

process.exit(exit);