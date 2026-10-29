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
  const { kept, dropped } = validateSubmitRows(
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

process.exit(exit);
