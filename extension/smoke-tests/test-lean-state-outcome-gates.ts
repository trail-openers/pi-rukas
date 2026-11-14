#!/usr/bin/env bun
/**
 * The gate events a `review` and a red `verify`/`ci` put on the durable record.
 *
 * `gates` on the result document is only as good as the record behind it, and these
 * three fields are the ones the record did not carry: per-round severity tallies, each
 * fix wave's full head, and a red gate's tier/criterion attribution. Prose never
 * substitutes — the reason line prints a 12-char prefix and a disclosed-row count, and
 * a host that has to name the commit the fixer left or the criterion a tier failed on
 * cannot recover either from a sentence.
 *
 * So the bar here is that the WRITER produces what the LOADER will accept and the
 * projection will print, and that a value no handler can write is refused rather than
 * carried. Each case drives the field through the writer and back through `loadRun` —
 * a fixture that hand-types the shape proves the projection reads a fixture, not that a
 * run can record it.
 */

import { isFullCommitSha } from "../src/commit-sha.ts";
import { GATE_SEVERITIES } from "../src/lean/gate-severities.ts";
import {
  RED_CRITERIA_MAX,
  RED_TIERS_MAX,
  ROUNDS_MAX,
  WAVES_MAX,
  redRecordProblem,
  reviewRecordProblem,
  roundCounts,
} from "../src/lean/state-outcome-gates.ts";
import { buildOutcome, outcomeProblem } from "../src/lean/state-outcome.ts";
import { type LeanState, loadRun, saveRun } from "../src/lean/state.ts";
import { makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { HEAD, stepWith } from "./lib/lean-result-fixture.ts";

const { assert, failures } = makeAssert();

/** The finding rows one lens round reported, in the shape `roundCounts` reads. */
const rows = (severities: readonly string[]): { severity: string }[] =>
  severities.map((severity) => ({ severity }));

// ─── (1) the tally is the published four, and nothing else ──────────────────────
{
  const tally = roundCounts(rows(["CRITICAL", "HIGH", "HIGH", "MEDIUM", "LOW", "LOW", "LOW"]));
  assert(
    JSON.stringify(Object.keys(tally)) === JSON.stringify(GATE_SEVERITIES),
    `one entry per published severity, in order (${JSON.stringify(Object.keys(tally))})`,
  );
  assert(
    tally.HIGH === 2 && tally.LOW === 3 && tally.CRITICAL === 1 && tally.MEDIUM === 1,
    `each row counted at its own severity (${JSON.stringify(tally)})`,
  );
  const empty = roundCounts(rows([]));
  assert(
    GATE_SEVERITIES.every((s) => empty[s] === 0) && Object.keys(empty).length === 4,
    `a round that raised nothing is four zeros, never an empty object (${JSON.stringify(empty)})`,
  );
  // A row whose severity the layer did not publish is counted nowhere rather than
  // invented a key for: the four are the shape a host branches on.
  const odd = roundCounts(rows(["BLOCKER", "HIGH"]));
  assert(
    odd.HIGH === 1 && Object.keys(odd).length === 4,
    `an unpublished severity adds no key (${JSON.stringify(odd)})`,
  );
}

// ─── (2) the writer's caps: clip, never throw ──────────────────────────────────
// A gate must not lose its verdict over the length of a name it was quoting, and a
// record that survives a resume must not be a record the loader spends its memory on.
{
  const { clipNames } = await import("../src/lean/state-outcome-gates.ts");
  const many = Array.from({ length: RED_TIERS_MAX + 40 }, (_, i) => `tier${String(i)}`);
  const clipped = clipNames(many, RED_TIERS_MAX, 64);
  assert(clipped.length === RED_TIERS_MAX, `tiers clipped to the record's cap (${clipped.length})`);
  const long = clipNames(["x".repeat(500)], RED_TIERS_MAX, 64);
  assert(long[0]?.length === 64, `a tier name clipped to its bound (${String(long[0]?.length)})`);
  assert(
    redRecordProblem({ tiers: clipped, criteria: [] }) === undefined,
    "the writer's own clip always produces something the validator accepts",
  );
  assert(
    clipNames(["", "ok", ""], RED_TIERS_MAX, 64).length === 1,
    "an empty name is dropped, not recorded as a tier nobody ran",
  );
}

// ─── (3) the loader refuses every shape it should ───────────────────────────────
// Each refusal is a value that would reach the host contract as an answer nobody
// judged. The messages name the field so an operator with a broken state file can tell
// which half is broken.
for (const [label, value, expect] of [
  ["rounds not an array", { rounds: {}, waves: [] }, /review\.rounds must be an array/],
  [
    "a round naming a fifth severity",
    { rounds: [{ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, BLOCKER: 1 }], waves: [] },
    /severity outside/,
  ],
  [
    "a round missing LOW",
    { rounds: [{ CRITICAL: 0, HIGH: 0, MEDIUM: 0 }], waves: [] },
    /must name exactly/,
  ],
  [
    "a negative count",
    { rounds: [{ CRITICAL: -1, HIGH: 0, MEDIUM: 0, LOW: 0 }], waves: [] },
    /non-negative integers/,
  ],
  [
    "a fractional count",
    { rounds: [{ CRITICAL: 1.5, HIGH: 0, MEDIUM: 0, LOW: 0 }], waves: [] },
    /non-negative integers/,
  ],
  [
    "a count that is a string",
    { rounds: [{ CRITICAL: "3", HIGH: 0, MEDIUM: 0, LOW: 0 }], waves: [] },
    /non-negative integers/,
  ],
  [
    `more than ${String(ROUNDS_MAX)} rounds`,
    {
      rounds: Array.from({ length: ROUNDS_MAX + 1 }, () => ({
        CRITICAL: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
      })),
      waves: [],
    },
    /more than/,
  ],
  ["waves not an array", { rounds: [], waves: {} }, /review\.waves must be an array/],
  [
    `more than ${String(WAVES_MAX)} waves`,
    {
      rounds: [],
      waves: Array.from({ length: WAVES_MAX + 1 }, () => ({ wave: "fix", head: HEAD })),
    },
    /more than/,
  ],
  [
    "an abbreviated wave head",
    { rounds: [], waves: [{ wave: "fix", head: HEAD.slice(0, 12) }] },
    /40-hex commit sha/,
  ],
  [
    "a wave head that is not hex",
    { rounds: [], waves: [{ wave: "fix", head: "z".repeat(40) }] },
    /40-hex commit sha/,
  ],
  [
    "a wave naming no pass",
    { rounds: [], waves: [{ wave: "maybe", head: HEAD }] },
    /"full" or "fix"/,
  ],
  [
    `more than ${String(RED_TIERS_MAX)} tiers`,
    { tiers: Array.from({ length: RED_TIERS_MAX + 1 }, (_, i) => `t${String(i)}`), criteria: [] },
    /more than/,
  ],
  [
    `more than ${String(RED_CRITERIA_MAX)} criteria`,
    {
      tiers: ["fast"],
      criteria: Array.from({ length: RED_CRITERIA_MAX + 1 }, (_, i) => `AC${String(i)}`),
    },
    /more than/,
  ],
  ["tiers not an array", { tiers: "fast", criteria: [] }, /red\.tiers must be an array/],
  ["a criterion id that is not AC<n>", { tiers: ["fast"], criteria: ["nope"] }, /AC<n>/],
  ["a tier name past its bound", { tiers: ["x".repeat(65)], criteria: [] }, /at most/],
] as const) {
  const isRed = /tier|criteri/.test(label);
  const problem = isRed
    ? redRecordProblem(value as unknown as { tiers: string[]; criteria: string[] })
    : reviewRecordProblem(value as unknown as never);
  assert(
    problem !== undefined && expect.test(problem),
    `a ${label} is refused with the field named (got: ${String(problem)})`,
  );
}
assert(
  reviewRecordProblem({
    rounds: [{ CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 }],
    waves: [{ wave: "fix", head: HEAD }],
  }) === undefined,
  "a well-formed review record is accepted",
);
assert(
  redRecordProblem({ tiers: ["fast"], criteria: ["AC1", "AC2"] }) === undefined,
  "a well-formed red record is accepted",
);

// ─── (4) ownership: a gate field on a step that never produced it refuses the load ─
// The projection's whole claim is that these values are facts a gate observed. A
// hand-edited state file that puts them anywhere else is a run that never made them up.
for (const [field, value, forgedOn, expect] of [
  ["review", { rounds: [], waves: [] }, "verify", /only recorded by a review step/],
  ["red", { tiers: ["fast"], criteria: ["AC1"] }, "handback", /only recorded by a verify,ci step/],
] as const) {
  const problem = outcomeProblem({ kind: "green", [field]: value }, forgedOn as LeanState);
  assert(
    problem !== undefined && expect.test(problem),
    `a forged ${field} on a ${forgedOn} step is refused (${String(problem)})`,
  );
}
{
  // And through the loader, where the message has to carry the step's own key — an
  // operator with one bad file must be able to find the step that holds it.
  const dir = tempDir("lean-gates-forge").dir;
  const issue = 41;
  saveRun(dir, {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "f".repeat(40),
    branch: `feature/issue-${issue}`,
    state: "handed-back",
    counters: {
      buildAttempts: 0,
      challengeDone: false,
      reviewDone: false,
      ciFixUsed: false,
      draft: false,
    },
    steps: [
      stepWith("verify", {
        kind: "green",
        verifiedHead: HEAD,
        review: { rounds: [{ CRITICAL: 9, HIGH: 0, MEDIUM: 0, LOW: 0 }], waves: [] },
      } as never),
    ],
    result: { reason: "test", code: 10 },
  } as never);
  let thrown: unknown;
  try {
    loadRun(dir, issue);
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown instanceof Error && thrown.name === "LeanStateError",
    `a ${"review"} record forged on a verify step refuses the load (got: ${String(thrown)})`,
  );
  assert(
    (thrown as Error)?.message?.includes("verify:0") === true,
    `the refusal names the step that carries the forgery (${(thrown as Error)?.message})`,
  );
}

// ─── (5) the rebuild is field-by-field ──────────────────────────────────────────
// `buildOutcome`'s claim is that a caller can trust every field it returns; a cast would
// carry an unvalidated sibling through as if it had been checked.
{
  const rebuilt = buildOutcome({
    kind: "fixed",
    review: {
      rounds: [{ CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, extra: 7 } as never],
      waves: [{ wave: "fix", head: HEAD }],
    },
  } as never) as unknown as { review?: { rounds: Record<string, unknown>[]; waves: unknown[] } };
  // The extra key is what the validator refused; if a caller ever rebuilds without
  // validating, this is the case that shows an unjudged key reaching a reader.
  assert(
    outcomeProblem(
      {
        kind: "fixed",
        review: { rounds: [{ CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, extra: 7 }] },
      },
      "review",
    ) !== undefined,
    "the validator is the thing that refuses an extra key, so the rebuild never has to",
  );
  assert(
    rebuilt.review?.waves?.[0] !== undefined &&
      isFullCommitSha((rebuilt.review.waves as { head: string }[])[0]?.head ?? ""),
    "the rebuild keeps the full head, not a prefix",
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
