#!/usr/bin/env bun
/**
 * #1105 — the findings memory through `runLensReview`, end to end (offline).
 *
 * Lens children are injected (`lensChildFn`), so no Pi child is spawned. A
 * temp clone carries three rounds on one branch:
 *   1. first review — a MEDIUM finding is reported; the verdict is
 *      ISSUES_FOUND and the row is recorded beside the ledger;
 *   2. a follow-up round — the lenses receive the prior finding as a fenced
 *      DATA block, and a delta review after lines were inserted above the
 *      cited code suppresses it (suppressed-unchanged, same row), so the
 *      verdict is APPROVED and the finding is listed as suppressed;
 *   3. an operator acceptance by row id, then a full review — the finding is
 *      suppressed-accepted and the verdict stays APPROVED;
 *   4. a new finding is reported and recorded open;
 *   5. a full review where the lens omits that open finding on unchanged code
 *      carries it forward — the row stays open and the verdict stays ISSUES_FOUND;
 *   6. a delta review of an unrelated file: the open finding on unchanged code
 *      still blocks the delta verdict (ISSUES_FOUND).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLensReview } from "../src/lens-review.ts";
import { acceptFinding, readBranchRows } from "../src/review-findings-store.ts";
import { FULL_DIFF, setupReviewFixture } from "./lib/review-findings-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = [
  "// header",
  "export function alpha(x: number) {",
  "  const a = x + 1;",
  "  return a * 2;",
  "}",
];

// What the first lens reports this round (each scenario reassigns them).
let reportLine = 4;
let reportTitle: string | undefined = "Division by zero possible";
const fixture = setupReviewFixture({
  prefix: "findings-run",
  files: { "src/a.ts": `${SRC.join("\n")}\n` },
  report: () =>
    reportTitle
      ? [
          {
            severity: "MEDIUM",
            path: "src/a.ts",
            line: reportLine,
            title: reportTitle,
          },
        ]
      : [],
});
const repo = fixture.repo;
const sh = fixture.sh;
const seenPrior = fixture.seenPrior;
const c1 = sh("git rev-parse HEAD");

const common = { cwd: repo, branch: "feat/x", lensChildFn: fixture.stubLens };
// A pasted diff satisfies the full-review path (the stubs never read it).
const FULL_DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export function alpha(x: number) {";

try {
  // Round 1 — a first review.
  const r1 = await runLensReview({ ...common, diff: FULL_DIFF });
  assert(
    r1.verdict === "ISSUES_FOUND",
    `round 1: the MEDIUM finding blocks (verdict ${r1.verdict})`,
  );
  const rows1 = await readBranchRows(repo, "feat/x");
  assert(
    rows1.length === 1 && rows1[0]?.status === "open",
    "round 1: one open row is recorded for the branch",
  );
  const rowId = rows1[0]?.id ?? "";
  assert(seenPrior[0] === "", "round 1: the first review's lenses see no prior block");

  // Round 2 — a delta review after two lines were inserted above the code.
  writeFileSync(path.join(repo, "src", "a.ts"), `// new 1\n// new 2\n${SRC.join("\n")}\n`);
  sh("git add -A");
  sh("git commit -qm two");
  const c2 = sh("git rev-parse HEAD");
  reportLine = 6;
  seenPrior.length = 0;
  const r2 = await runLensReview({ ...common, since: c1, head: c2 });
  assert(
    seenPrior.some(
      (p) => p.includes("<<<prior-findings") && p.includes("Division by zero possible"),
    ),
    "round 2: every lens receives the prior finding in a fenced DATA block",
  );
  assert(
    r2.verdict === "APPROVED" && r2.findings.length === 0,
    `round 2: the delta suppresses the known finding on untouched code (verdict ${r2.verdict})`,
  );
  assert(
    r2.suppressed?.[0]?.reason.includes("outside") === true && r2.suppressed?.[0]?.rowId === rowId,
    "round 2: the suppressed finding names the same row and the delta reason",
  );
  assert(
    (await readBranchRows(repo, "feat/x")).length === 1,
    "round 2: the same row is updated, not duplicated",
  );

  // Round 3 — the operator accepts it; a full review keeps it suppressed.
  const acc = await acceptFinding(repo, "feat/x", rowId, {
    by: "op@example.com",
    reason: "known; tracked for the next release",
  });
  assert(acc.ok, "round 3: the operator accepts the row by id");
  const r3 = await runLensReview({ ...common, diff: FULL_DIFF, full: true, head: c2 });
  assert(
    r3.verdict === "APPROVED" && r3.suppressed?.[0]?.reason.includes("op@example.com") === true,
    "round 3: the accepted finding is suppressed on a full review and the verdict is APPROVED",
  );

  // Round 4 — a new finding is reported and recorded open.
  reportTitle = "Unchecked slice bound";
  const r4 = await runLensReview({ ...common, diff: FULL_DIFF, full: true, head: c2 });
  assert(r4.verdict === "ISSUES_FOUND", `round 4: the new finding blocks (verdict ${r4.verdict})`);

  // Round 5 — the lens omits it on unchanged code: carried forward, not resolved.
  reportTitle = undefined;
  const r5 = await runLensReview({ ...common, diff: FULL_DIFF, full: true, head: c2 });
  assert(
    r5.verdict === "ISSUES_FOUND" && r5.findings.some((f) => f.title === "Unchecked slice bound"),
    `round 5: an omitted open finding on unchanged code still blocks (verdict ${r5.verdict})`,
  );
  assert(
    (await readBranchRows(repo, "feat/x")).some(
      (r) => r.title === "Unchecked slice bound" && r.status === "open",
    ),
    "round 5: the carried row stays open",
  );

  // Round 6 — a delta review of an unrelated file: the open row on unchanged
  // code is carried into the delta's verdict too.
  writeFileSync(path.join(repo, "src", "b.ts"), "export const z = 1;\n");
  sh("git add -A");
  sh("git commit -qm three");
  const c3 = sh("git rev-parse HEAD");
  const r6 = await runLensReview({ ...common, since: c2, head: c3 });
  assert(
    r6.verdict === "ISSUES_FOUND" && r6.findings.some((f) => f.title === "Unchecked slice bound"),
    `round 6: an open row on unchanged code still blocks a delta verdict (verdict ${r6.verdict})`,
  );
} finally {
  fixture.cleanup();
}

process.exit(exit);
