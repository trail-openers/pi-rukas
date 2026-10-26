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
  confirmRedBase,
} from "../src/work-driver-verify-base-confirm.ts";
import type { BaselineVerdict } from "../src/work-driver-verify-baseline.ts";

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
 * The loop's own triad: per-file markers anchored in the tree that ran, plus a
 * summary whose count agrees with them. Anything else and `failingTestNames`
 * returns `[]`, which is the "no names" arm — so a case that wants names has to
 * print this shape rather than any line beginning `FAILED:`.
 */
const named = (tree: string, ...paths: string[]): string =>
  [
    ...paths.map((p) => `FAILED: ${tree}/${p}`),
    `FAILED: ${paths.length} test(s) — ${paths.join(", ")}`,
  ].join("\n");

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

// ── a probe that throws is the caller's problem, not a silent red ──
{
  let threw = false;
  try {
    await run(red(), [], { throwOn: 1 });
  } catch {
    threw = true;
  }
  assert(threw, "an injected probe that throws propagates — the rule folds nothing into a red");
}

process.exit(exit);
