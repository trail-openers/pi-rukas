#!/usr/bin/env bun
/**
 * #1105 — a finding citing a path that is missing at the head commit does not
 * disable the findings memory for the run (offline, through `runLensReview`).
 *
 * Lens children are injected (`lensChildFn`). One lens reports two findings on
 * one round: one on `src/gone.ts` (a wrong path a lens cited — absent at head)
 * and one on the real `src/a.ts`. Then:
 *   1. the run records: no memoryNote, both rows exist, the real-file row keeps
 *      its normal identity (anchor + cited line + snippet), and the missing-path
 *      row is a no-line row (anchor `file`, no line);
 *   2. both findings are reported and the verdict is ISSUES_FOUND;
 *   3. the operator accepts the missing-path row by id — a later full review
 *      suppresses it by title (suppressed-accepted), so an accepted wrong
 *      citation can be cleared; the real-file finding is still reported.
 */

import { runLensReview } from "../src/lens-review.ts";
import { snippetHashAt } from "../src/review-findings-match.ts";
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
// The lines the store reads at head: git shows the file with its trailing newline.
const HEAD = `${SRC.join("\n")}\n`.split("\n");
// The first lens reports a finding on a path that does not exist at head, and
// one on the real file. Every lens answers with evidence, so the round is complete.
const fixture = setupReviewFixture({
  prefix: "findings-missing",
  branch: "feat/x",
  files: { "src/a.ts": HEAD.join("\n") },
  report: () => [
    { severity: "MEDIUM", path: "src/gone.ts", line: 3, title: "Missing null check" },
    { severity: "MEDIUM", path: "src/a.ts", line: 4, title: "Division by zero possible" },
  ],
});
const repo = fixture.repo;
const sh = fixture.sh;
const c1 = sh("git rev-parse HEAD");

const common = { cwd: repo, branch: "feat/x", lensChildFn: fixture.stubLens };
const FULL_DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export function alpha(x: number) {";

try {
  // Round 1 — the run records despite the missing path.
  const r1 = await runLensReview({ ...common, diff: FULL_DIFF, head: c1 });
  assert(r1.memoryNote === undefined, "round 1: the run records (memoryNote is unset)");
  assert(
    r1.findings.length === 2 && r1.verdict === "ISSUES_FOUND",
    `round 1: both findings are reported (verdict ${r1.verdict})`,
  );
  const rows = await readBranchRows(repo, "feat/x");
  const real = rows.find((r) => r.path === "src/a.ts");
  const gone = rows.find((r) => r.path === "src/gone.ts");
  assert(rows.length === 2, "round 1: one row per finding is recorded");
  assert(
    real?.anchor === "alpha" && real.line === 4 && real.snippetHash === snippetHashAt(HEAD, 4),
    "round 1: the real-file finding keeps its normal identity (anchor, line, snippet)",
  );
  assert(
    gone?.anchor === "file" && gone.line === undefined,
    "round 1: the missing-path finding is a no-line row (anchor file, no line)",
  );

  // Round 2 — the operator accepts the missing-path row; a full review then
  // suppresses it by title, and the real-file finding is still reported.
  const acc = await acceptFinding(repo, "feat/x", gone?.id ?? "", {
    by: "op@example.com",
    reason: "wrong path cited; tracked elsewhere",
  });
  assert(acc.ok, "round 2: the operator accepts the missing-path row by id");
  const r2 = await runLensReview({ ...common, diff: FULL_DIFF, full: true, head: c1 });
  assert(
    !r2.findings.some((f) => f.path === "src/gone.ts") &&
      (r2.suppressed ?? []).some(
        (s) => s.finding.path === "src/gone.ts" && s.reason.includes("op@example.com"),
      ),
    "round 2: the accepted missing-path finding is suppressed by its title, naming the operator",
  );
  assert(
    r2.findings.some((f) => f.path === "src/a.ts"),
    "round 2: the real-file finding is still reported",
  );
  assert(r2.memoryNote === undefined, "round 2: the run still records (memoryNote is unset)");
} finally {
  fixture.cleanup();
}

process.exit(exit);
