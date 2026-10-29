#!/usr/bin/env bun
/**
 * lean/submit-tests — the extractor and the boundary validation the specify
 * step applies to every row a child reports.
 *
 * Two layers, two failure shapes, and the test keeps them apart:
 *   - `extractSubmitTests` reads a tool call. A call whose required fields are
 *     missing or of the wrong type is malformed and counted in `skipped`.
 *   - `validateSubmitRows` judges a row against the spec and the worktree. An
 *     unknown criterion, an escaping path, or a file that is not there is
 *     DROPPED with a reason — never trusted, never fatal.
 */

import type { PiSpec } from "../src/lean/spec.ts";
import { validateSubmitRows } from "../src/lean/specify-tree.ts";
import { extractSubmitTests } from "../src/lean/submit-tests-extract.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SPEC: PiSpec = {
  problem: "p",
  size: "S",
  criteria: [
    { id: "AC1", text: "retries", verify: "test" },
    { id: "AC2", text: "docs", verify: "manual" },
    { id: "AC3", text: "builds", verify: "command", command: "bun run build" },
  ],
};

function call(args: unknown): { name: string; arguments: unknown } {
  return { name: "submit_tests", arguments: args };
}

// ---------------------------------------------------------------- extractor

{
  const { rows, skipped } = extractSubmitTests([
    call({ criterionId: "AC1", testFiles: ["tests/AC1-a.test.ts"] }),
    call({ criterionId: " AC2 ", testFiles: ["tests/AC2.test.ts"], note: "  docs  " }),
    // Two calls for one criterion are two rows; the parent merges them.
    call({ criterionId: "AC1", testFiles: ["tests/AC1-b.test.ts"] }),
    { name: "bash", arguments: { command: "ls" } },
    null,
    "not an object",
    // Malformed: each is a call the model faked past the schema.
    call({ testFiles: ["a.ts"] }),
    call({ criterionId: "AC1" }),
    call({ criterionId: "AC1", testFiles: [] }),
    call({ criterionId: "AC1", testFiles: "tests/AC1.test.ts" }),
    call({ criterionId: 7, testFiles: ["a.ts"] }),
    call({ criterionId: "AC1", testFiles: ["", "   ", 5, "ok.ts"] }),
  ]);
  assert(skipped === 5, `malformed calls counted as skipped (got ${skipped}, want 5)`);
  assert(rows.length === 4, `rows kept (got ${rows.length}, want 4)`);
  assert(
    rows[0]?.criterionId === "AC1" && rows[1]?.criterionId === "AC2",
    "criterion ids read, and trimmed",
  );
  assert(rows[1]?.note === "docs", "note trimmed and kept");
  assert(rows[0]?.note === undefined, "an absent note stays absent");
  assert(
    rows[3]?.testFiles.length === 1 && rows[3]?.testFiles[0] === "ok.ts",
    "blank and non-string entries dropped from testFiles",
  );
}

// ------------------------------------------------------- boundary validation

{
  const present = new Set(["tests/AC1-a.test.ts", "tests/AC2.test.ts"]);
  const { kept, dropped } = await validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["tests/AC1-a.test.ts"] },
      // Unknown criterion — not in the spec at all.
      { criterionId: "AC9", testFiles: ["tests/AC9.test.ts"] },
      // A criterion that is in the spec but not `verify: "test"`.
      { criterionId: "AC2", testFiles: ["tests/AC2.test.ts"] },
      { criterionId: "AC3", testFiles: ["tests/AC3.test.ts"] },
      // Escapes the worktree, or sits in a directory the step never accepts.
      { criterionId: "AC1", testFiles: ["/etc/passwd"] },
      { criterionId: "AC1", testFiles: ["tests/../../outside.ts"] },
      { criterionId: "AC1", testFiles: ["tests/../outside.ts"] },
      { criterionId: "AC1", testFiles: [".pi/lean-state/9.json"] },
      { criterionId: "AC1", testFiles: ["x/.git/config"] },
      { criterionId: "AC1", testFiles: ["node_modules/dep/index.ts"] },
      { criterionId: "AC1", testFiles: ["tests/AC1-a.test.ts", "tests/missing.test.ts"] },
      { criterionId: "AC1", testFiles: ["./tests/AC1-a.test.ts"] },
    ],
    { spec: SPEC, exists: (p) => present.has(p) },
  );

  assert(kept.length === 1, `kept rows (got ${kept.length}, want 1)`);
  assert(
    kept[0]?.criterionId === "AC1" && kept[0]?.testFiles.join() === "tests/AC1-a.test.ts",
    `the one legitimate row kept verbatim (got ${JSON.stringify(kept[0])})`,
  );
  const reasons = dropped.map((d) => `${d.criterionId}|${d.reason}`);
  const has = (id: string, needle: string) =>
    reasons.some((r) => r.startsWith(`${id}|`) && r.includes(needle));
  assert(has("AC9", "unknown"), "an unknown criterion is dropped, naming the criterion");
  assert(has("AC2", "not a test criterion"), "a manual criterion is dropped");
  assert(has("AC3", "not a test criterion"), "a command criterion is dropped");
  assert(has("AC1", "absolute"), "an absolute path is dropped");
  assert(has("AC1", ".."), "a path containing .. is dropped");
  assert(has("AC1", ".pi/"), ".pi/ is refused");
  assert(has("AC1", ".git/"), ".git/ is refused");
  assert(has("AC1", "node_modules/"), "node_modules/ is refused");
  assert(has("AC1", "does not exist"), "a missing file is dropped");
  assert(
    kept.length === 1 && reasons.every((r) => !r.includes("./tests/AC1-a")),
    "a ./ prefix normalises to the same kept path",
  );
}

// ---------------------------------------------------- the frozen-path boundary
//
// `challenge` alone passes `frozenPaths`: the adversary may add tests, never
// replace one. Two things are pinned here that the end-to-end case cannot show
// on its own — the refusal fires for EVERY path shape that names the frozen
// file (`./`, `//`, a `\` separator), because the check runs on the normalised
// path; and it fires BEFORE the existence check, because a frozen path does
// exist, so a swapped order would report the misleading "not a regular file"
// instead of the truth.
{
  const present = new Set(["tests/AC1-a.test.ts", "tests/AC1-frozen.test.ts"]);
  const { kept, dropped } = await validateSubmitRows(
    [
      // The same frozen file, spelled four ways. All four must refuse.
      { criterionId: "AC1", testFiles: ["tests/AC1-frozen.test.ts"] },
      { criterionId: "AC1", testFiles: ["./tests/AC1-frozen.test.ts"] },
      { criterionId: "AC1", testFiles: ["./tests//AC1-frozen.test.ts"] },
      { criterionId: "AC1", testFiles: ["tests\\AC1-frozen.test.ts"] },
      // And a genuinely new file, which must survive the same call.
      { criterionId: "AC1", testFiles: ["tests/AC1-a.test.ts"] },
    ],
    {
      spec: SPEC,
      exists: (p) => present.has(p),
      frozenPaths: new Set(["tests/AC1-frozen.test.ts"]),
    },
  );
  const frozenReasons = dropped.filter((d) => d.reason.includes("frozen acceptance test"));
  assert(kept.length === 1, `one kept row (got ${kept.length}, want 1)`);
  assert(
    kept[0]?.testFiles.join() === "tests/AC1-a.test.ts",
    `the new file kept and the frozen ones refused (got ${JSON.stringify(kept[0]?.testFiles)})`,
  );
  assert(
    frozenReasons.length === 4,
    `every spelling of the frozen path refused, not just the canonical one (got ${frozenReasons.length}, want 4)`,
  );
  assert(
    frozenReasons.every((d) => d.path === "tests/AC1-frozen.test.ts"),
    `each refusal is recorded under the NORMALISED path (got ${JSON.stringify(frozenReasons.map((d) => d.path))})`,
  );
  assert(
    present.has("tests/AC1-frozen.test.ts") &&
      frozenReasons.every((d) => d.reason.includes("may not replace")),
    "the reason says the adversary may not replace it — the file EXISTS, so this is not the existence check firing",
  );
}

// ---------------------------------------------- the base-commit newness boundary
//
// A `submit_tests` row claims "I wrote this test". `exists` cannot tell that
// claim from "this file was checked out at me", so a boundary that stops there
// accepts both reproductions of the same fraud: (a) the child names an existing,
// green, TRACKED project test it never opened — the runner never executes it
// (it is red by absence of evidence, which is a red the proof accepts) and the
// step freezes it as the run's contract; (b) the child overwrites a tracked test
// and submits it. Both are refused by `existsAtBase`, a git read of the run's
// base commit, which nothing the child did to the working tree can move.
// Five things are pinned here:
//
//   - untouched and overwritten both refuse, with the SAME reason — the step
//     never sees the child's bytes for either, so nothing distinguishes them
//     and nothing needs to;
//   - the refusal fires on the NORMALISED path, so a `./` or `\` spelling of a
//     tracked file is not a dodge;
//   - a genuinely new file survives, and survives in the same call as the
//     refusals — the rule is not "submit nothing";
//   - a file that is in neither place reports EXISTENCE, not newness: the two
//     remedies differ (write it vs. pick a new name);
//   - no `existsAtBase` at all falls back to today's behaviour, and FROZEN still
//     outranks NEW so an inherited test keeps the reason that says leave it be.
{
  // The worktree: both files are present. Only ONE of them is in the base.
  const present = new Set(["tests/AC1-a.test.ts", "tests/AC1-tracked.test.ts"]);
  const tracked = new Set(["tests/AC1-tracked.test.ts"]);
  const asked: string[] = [];
  const { kept, dropped } = await validateSubmitRows(
    [
      // (a) the child left a tracked test exactly as it found it.
      { criterionId: "AC1", testFiles: ["tests/AC1-tracked.test.ts"] },
      // ... and the same file by every punctuation spelling it can invent.
      { criterionId: "AC1", testFiles: ["./tests/AC1-tracked.test.ts"] },
      { criterionId: "AC1", testFiles: ["tests\\AC1-tracked.test.ts"] },
      { criterionId: "AC1", testFiles: ["./tests//AC1-tracked.test.ts"] },
      // (b) the child OVERWROTE a tracked test: same path, different bytes. The
      // boundary cannot see the bytes and must not need to — the path is the
      // evidence. (c) is the file the child actually created, in the same call.
      { criterionId: "AC1", testFiles: ["tests/AC1-a.test.ts"] },
    ],
    {
      spec: SPEC,
      exists: (p) => present.has(p),
      existsAtBase: async (p) => {
        asked.push(p);
        return tracked.has(p);
      },
    },
  );
  const newness = dropped.filter((d) => d.reason.includes("already exists at the base commit"));
  assert(
    kept.length === 1 && kept[0]?.testFiles.join() === "tests/AC1-a.test.ts",
    `the one genuinely new file is kept and no tracked file is (got ${JSON.stringify(kept)})`,
  );
  assert(
    newness.length === 4,
    `every spelling of the tracked path is refused, untouched or overwritten alike (got ${newness.length}, want 4)`,
  );
  assert(
    newness.every((d) => d.path === "tests/AC1-tracked.test.ts"),
    `each refusal is recorded under the NORMALISED path (got ${JSON.stringify(newness.map((d) => d.path))})`,
  );
  assert(
    newness.every(
      (d) =>
        d.reason.includes("a new acceptance test must be a new file") &&
        d.reason.includes("tests/AC1-tracked.test.ts"),
    ),
    `the reason names the file and states the rule the child broke (got ${newness[0]?.reason})`,
  );
  assert(
    asked.length > 0 && asked.every((p) => !p.startsWith("./") && !p.includes("\\")),
    `the base probe is asked about normalised paths only, so punctuation cannot dodge it (got ${JSON.stringify(asked)})`,
  );
  // A file the child never wrote is refused for EXISTENCE, not newness.
  const missing = await validateSubmitRows(
    [{ criterionId: "AC1", testFiles: ["tests/AC1-never-written.test.ts"] }],
    { spec: SPEC, exists: () => false, existsAtBase: async () => false },
  );
  assert(
    missing.dropped.length === 1 &&
      missing.dropped[0]?.reason.includes("does not exist in the worktree") === true &&
      missing.dropped[0]?.reason.includes("base commit") === false,
    `an absent file reports EXISTENCE and never the base rule (got ${missing.dropped[0]?.reason})`,
  );
  // A caller with no base to ask about gets today's verdicts, not a refusal of
  // everything: the rule is opt-in per call, never a default that breaks a step.
  const unprobed = await validateSubmitRows(
    [{ criterionId: "AC1", testFiles: ["tests/AC1-tracked.test.ts"] }],
    { spec: SPEC, exists: (p) => present.has(p) },
  );
  assert(
    unprobed.kept.length === 1 && unprobed.dropped.length === 0,
    `no existsAtBase → the boundary judges only the pre-existing rules (kept ${unprobed.kept.length}, dropped ${unprobed.dropped.length})`,
  );
  // FROZEN still outranks NEW.
  const both = await validateSubmitRows(
    [{ criterionId: "AC1", testFiles: ["tests/AC1-tracked.test.ts"] }],
    {
      spec: SPEC,
      exists: (p) => present.has(p),
      existsAtBase: async () => true,
      frozenPaths: new Set(["tests/AC1-tracked.test.ts"]),
    },
  );
  assert(
    both.dropped.length === 1 &&
      both.dropped[0]?.reason.includes("frozen acceptance test") === true &&
      both.dropped[0]?.reason.includes("base commit") === false,
    `a frozen path is refused as FROZEN, never as merely old (got ${both.dropped[0]?.reason})`,
  );
}

// (d) The boundary is bounded, and it does not ask git the same question twice.
// Both rules cost something the child controls: a row names N files and the
// newness rule costs one git read per name, so an unbounded row is an unbounded
// number of git calls from one tool call, and a repeated name was asked twice.
{
  const many = Array.from({ length: 9 }, (_, i) => `tests/AC1-x${i}.test.ts`);
  const over = await validateSubmitRows([{ criterionId: "AC1", testFiles: many }], {
    spec: SPEC,
    exists: () => true,
    existsAtBase: async () => false,
  });
  assert(
    over.kept.length === 0 &&
      over.dropped.length === 1 &&
      over.dropped[0]?.reason.includes("9 test files") === true &&
      over.dropped[0]?.reason.includes("8") === true,
    `(bound) a row of 9 test files is refused with a reason naming the cap, not processed (got ${JSON.stringify(over.dropped)})`,
  );
  const eight = await validateSubmitRows([{ criterionId: "AC1", testFiles: many.slice(0, 8) }], {
    spec: SPEC,
    exists: () => true,
    existsAtBase: async () => false,
  });
  assert(
    eight.kept.length === 1 && eight.kept[0]?.testFiles.length === 8,
    `(bound) eight files — the cap itself — are kept, so the rule refuses excess and not the row (got ${JSON.stringify(eight.kept)})`,
  );

  // One probe per distinct path per call: four rows and one duplicated name
  // used to be five git reads about `tests/AC1-tracked.test.ts`.
  const asked: string[] = [];
  await validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["tests/AC1-tracked.test.ts"] },
      { criterionId: "AC1", testFiles: ["./tests/AC1-tracked.test.ts"] },
      { criterionId: "AC1", testFiles: ["tests//AC1-tracked.test.ts"] },
      { criterionId: "AC1", testFiles: ["tests/AC1-a.test.ts"] },
    ],
    {
      spec: SPEC,
      exists: () => true,
      existsAtBase: async (p) => {
        asked.push(p);
        return p === "tests/AC1-tracked.test.ts";
      },
    },
  );
  assert(
    asked.length === 2 &&
      asked.includes("tests/AC1-tracked.test.ts") &&
      asked.includes("tests/AC1-a.test.ts"),
    `(memo) the base is asked once per distinct normalised path, not once per mention (got ${JSON.stringify(asked)})`,
  );
  // The memo is per CALL: a second call must re-read, because between two calls
  // the step may have committed, and a stale "new" is the fraud the rule exists
  // to refuse.
  const second: string[] = [];
  await validateSubmitRows([{ criterionId: "AC1", testFiles: ["tests/AC1-tracked.test.ts"] }], {
    spec: SPEC,
    exists: () => true,
    existsAtBase: async (p) => {
      second.push(p);
      return false;
    },
  });
  assert(
    second.length === 1,
    `(memo) the cache does not outlive the call, so a later boundary call sees the tree as it is now (got ${JSON.stringify(second)})`,
  );
}

process.exit(exit);
