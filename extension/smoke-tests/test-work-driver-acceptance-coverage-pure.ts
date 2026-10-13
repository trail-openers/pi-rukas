#!/usr/bin/env bun
/**
 * #1137 — the acceptance-coverage pure checks: criterion path extraction and
 * the classification (no git). Split from test-work-driver-acceptance-coverage.ts
 * to keep both under the file-size gate.
 */

import path from "node:path";
import { classifyCoverage, criterionPathsOf } from "../src/work-driver-acceptance-coverage.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- 1. paths
assert(
  JSON.stringify(criterionPathsOf("Add hunk-identity subtraction (src/a.ts, src/b.ts)")) ===
    JSON.stringify(["src/a.ts", "src/b.ts"]),
  "criterionPathsOf: extracts multiple parenthetical paths",
);
assert(
  JSON.stringify(criterionPathsOf("The docs explain the new flag (extension/src/x.ts (new))")) ===
    JSON.stringify(["extension/src/x.ts"]),
  "criterionPathsOf: planner annotation inside the path is normalised away",
);
assert(
  JSON.stringify(criterionPathsOf("The CLI prints a helpful message (docs only)")) ===
    JSON.stringify([]),
  "criterionPathsOf: a prose parenthetical (no slash, no extension) is not a path",
);
assert(
  JSON.stringify(criterionPathsOf("No parens at all, just prose about behaviour")) ===
    JSON.stringify([]),
  "criterionPathsOf: prose without parens is unmeasurable",
);
assert(
  JSON.stringify(criterionPathsOf("Ships the module (extension/src)")) ===
    JSON.stringify(["extension/src"]),
  "criterionPathsOf: a directory declaration (slash, no extension) is a path",
);

// --------------------------------------------- 2. classifyCoverage (pure)
{
  const workstreams = {
    code: { id: "code", scope: "the code", paths: ["src/a.ts", "src/b.ts"], outOfScope: [] },
    docs: { id: "docs", scope: "the docs", paths: ["AGENTS.md"], outOfScope: [] },
  };
  const diff = new Set(["src/a.ts", "AGENTS.md", "other/c.ts"]);

  // Sibling-delivered: the docs workstream's criterion is satisfied by a file
  // the docs workstream ships — the docs workstream's reviewer is never asked
  // for it (task-a), but the whole-issue check here must see it as delivered.
  const v = classifyCoverage(
    [
      "Docs explain the flag (AGENTS.md)",
      "Subtraction lands (src/a.ts)",
      "Undelivered work (src/b.ts)",
      "Prose criterion with no paths at all",
    ],
    workstreams,
    diff,
  );
  assert(v.skipped === false, "classifyCoverage: ran (not skipped)");
  assert(v.filesPresent.length === 3, "classifyCoverage: filesPresent records the diff name-set");
  assert(
    v.criteria[0].status === "delivered" && v.criteria[0].owner === "docs",
    "classifyCoverage: sibling-delivered criterion is delivered, owner = docs",
  );
  assert(
    v.criteria[1].status === "delivered" && v.criteria[1].owner === "code",
    "classifyCoverage: delivered criterion owned by code",
  );
  assert(
    v.criteria[2].status === "undelivered" && v.criteria[2].owner === "code",
    "classifyCoverage: undelivered criterion named, owner = code",
  );
  assert(v.criteria[2].missing.join(",") === "src/b.ts", "classifyCoverage: missing path recorded");
  assert(
    v.criteria[3].status === "unmeasurable",
    "classifyCoverage: prose criterion is unmeasurable, never undelivered",
  );
  assert(
    v.undelivered.length === 1 && v.undelivered[0].text === "Undelivered work (src/b.ts)",
    "classifyCoverage: the blocking set is exactly the undelivered criterion",
  );

  // Partial presence: some of the criterion's paths shipped, some did not.
  // Not a block (the converge gate parks only on fully-absent deliverables).
  const v2 = classifyCoverage(["Both (src/a.ts, src/b.ts)"], workstreams, diff);
  assert(
    v2.criteria[0].status === "delivered" && v2.criteria[0].missing.length === 1,
    "classifyCoverage: partially-present criterion is not a block (missing recorded)",
  );
  assert(v2.undelivered.length === 0, "classifyCoverage: partial presence → no undelivered set");

  // Prose that looks like a path never blocks (#1137 review): a slash-only
  // token counts only if the diff has files under it; a path after prose counts.
  const vProse = classifyCoverage(
    [
      "Errors (read/write)",
      "Docs (see docs/x.md)",
      "Covered (e.g. src/a.ts)",
      "Gone (see docs/gone.md)",
    ],
    workstreams,
    new Set(["docs/x.md", "src/a.ts"]),
  );
  assert(vProse.criteria[0].status === "unmeasurable", "classifyCoverage: '(read/write)' is prose");
  assert(
    vProse.criteria[1].status === "delivered" && vProse.criteria[2].status === "delivered",
    "classifyCoverage: paths after prose ('see docs/x.md', 'e.g. src/a.ts') are found and shipped",
  );
  assert(
    vProse.undelivered.length === 1,
    "classifyCoverage: only the unshipped prose-wrapped path blocks",
  );

  // Explicit skip: "scope unknown" shapes degrade to a recorded skip.
  const vs = classifyCoverage(["Any (src/a.ts)"], workstreams, diff, {
    skipReason: "no recorded acceptance criteria",
  });
  assert(
    vs.skipped === true && vs.skipReason !== undefined && vs.undelivered.length === 0,
    "classifyCoverage: explicit skip carries the reason and never blocks",
  );
}

process.exit(exit);
