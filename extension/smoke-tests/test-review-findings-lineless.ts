#!/usr/bin/env bun
/**
 * #1469 — the unkillable row: a line-less finding on a file that still exists
 * at head used to be carried forever. `linesFate` returned CARRY before any
 * resolving rule (`row.line === undefined || row.snippetHash === NO_LINE_SNIPPET`),
 * the operator-facing acceptance exit refuses every CRITICAL, and the carried
 * row kept stamping the verdict CRITICAL_ISSUES_FOUND every round — which is
 * also what closes the round-cap merge route. The only ways out were deleting
 * the file or hand-editing the findings store.
 *
 * These are the end-to-end scenarios for the fix: a COMPLETE full review in
 * which the producing lens no longer reports the row (same lens, path and
 * title) retires it, for every severity; a delta or an incomplete round never
 * does; a row the round re-reports is matched, not retired; a pre-fix row
 * retires with no migration; an invalid path still has no automatic exit; and a
 * carried line-less finding renders `path:?`, never `path:undefined`.
 *
 * The pure unit view of the same rule — `rowFate` over a hand-built row, where
 * the accepted-row and invalid-path asymmetries are cheap to express — is in
 * test-review-findings-fate.ts. Its scenarios drive the store directly; these
 * drive `runLensReview`, because the symptom this issue reports is the VERDICT,
 * and only the review computes that.
 *
 * Split from test-review-findings-resolve.ts for the AGENTS.md §12 500-line
 * gate; that file's scenario B (a no-line MEDIUM row on a present file) is the
 * pre-fix contract this supersedes, and its docstring says so.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderSummary } from "../src/lens-review-render.ts";
import { runLensReview } from "../src/lens-review.ts";
import { snippetHashAt } from "../src/review-findings-match.ts";
import { FINDINGS_FILE, readBranchRows } from "../src/review-findings-store.ts";
import { FULL_DIFF, type StubFinding, setupReviewFixture } from "./lib/review-findings-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// What the first lens reports this round; `blockNonFirst` makes a round incomplete.
let reportNow: StubFinding[] = [];
let blockNonFirst = false;
const fixture = setupReviewFixture({
  prefix: "findings-lineless",
  files: {
    "src/a.ts": "// header\nexport const a = 1;\nexport const b = 2;\n",
    "src/keep.ts": "export const k = 1;\n",
  },
  report: () => reportNow,
  blockNonFirst: () => blockNonFirst,
});
const repo = fixture.repo;
const ledgerDir = fixture.ledgerDir;
const sh = fixture.sh;

const runRound = (branch: string, head: string, findings: StubFinding[]) => {
  reportNow = findings;
  return runLensReview({
    cwd: repo,
    branch,
    diff: FULL_DIFF,
    head,
    full: true,
    lensChildFn: fixture.stubLens,
  });
};
const head = () => sh("git rev-parse HEAD");
const branchRow = (branch: string) => readBranchRows(repo, branch).then((r) => r[0]);

/** Put the branch back on `main` and cut a fresh branch for one scenario. */
const fresh = (name: string) => {
  sh("git checkout -q main");
  sh(`git checkout -q -b ${name}`);
};

/** A file-level CRITICAL: the shape PR #1418 could not get rid of. */
const lineless: StubFinding = {
  severity: "CRITICAL",
  path: "src/keep.ts",
  title: "Hardcoded secret",
};
/** A file-level MEDIUM: the rule is one rule, so the severity must not matter. */
const linelessMedium: StubFinding = {
  severity: "MEDIUM",
  path: "src/keep.ts",
  title: "Unclear module contract",
};

try {
  // The unkillable row itself.
  fresh("feat/lineless-critical");
  const s1 = await runRound("feat/lineless-critical", head(), [lineless]);
  assert(
    s1.verdict === "CRITICAL_ISSUES_FOUND",
    `S round 1: the line-less CRITICAL blocks (${s1.verdict})`,
  );
  const sRow1 = await branchRow("feat/lineless-critical");
  assert(
    sRow1?.line === undefined && sRow1.noLine === true,
    `S round 1: the row stores the explicit no-line marker (${JSON.stringify(sRow1?.noLine)})`,
  );
  // A later commit changes an UNRELATED file: the row's own path is untouched,
  // so nothing about its code changed — the retirement rests on the complete
  // review's silence alone, which is exactly what a line-less row can rest on.
  writeFileSync(path.join(repo, "src", "other.ts"), "export const o = 1;\n");
  sh("git add -A");
  sh("git commit -qm unrelated-file");
  const s2 = await runRound("feat/lineless-critical", head(), []);
  const sRow2 = await branchRow("feat/lineless-critical");
  assert(
    sRow2?.status === "resolved" && sRow2.resolvedReason === "not-reported",
    `S round 2: a complete full review that no longer reports it retires the line-less CRITICAL (${sRow2?.status}/${sRow2?.resolvedReason})`,
  );
  assert(
    s2.verdict !== "CRITICAL_ISSUES_FOUND" && !s2.findings.some((f) => f.title === lineless.title),
    `S round 2: the retired row no longer blocks or stamps the verdict (${s2.verdict})`,
  );

  // One rule for every severity: the same round retires a line-less MEDIUM.
  fresh("feat/lineless-medium");
  await runRound("feat/lineless-medium", head(), [linelessMedium]);
  const sm2 = await runRound("feat/lineless-medium", head(), []);
  const smRow = await branchRow("feat/lineless-medium");
  assert(
    smRow?.status === "resolved" &&
      smRow.resolvedReason === "not-reported" &&
      sm2.verdict === "APPROVED",
    `S-medium: a line-less MEDIUM retires under the same rule (${smRow?.status}/${sm2.verdict})`,
  );

  // A full round whose lens DOES still report the same lens/path/title keeps
  // the row open: the retirement rule cannot clear a finding a lens still sees.
  fresh("feat/lineless-reappear");
  await runRound("feat/lineless-reappear", head(), [lineless]);
  const sr1 = await runRound("feat/lineless-reappear", head(), [lineless]);
  const srRow = await branchRow("feat/lineless-reappear");
  assert(
    srRow?.status === "open" && sr1.verdict === "CRITICAL_ISSUES_FOUND",
    `S-reappear: a full round that re-reports the same finding keeps the row open (${sr1.verdict})`,
  );

  // The same row under a DELTA round never retires: the round saw only its own
  // range, so its silence about the row is not evidence.
  fresh("feat/lineless-delta");
  await runRound("feat/lineless-delta", head(), [lineless]);
  const sdBase = head();
  writeFileSync(path.join(repo, "src", "other.ts"), "export const o = 2;\n");
  sh("git add -A");
  sh("git commit -qm unrelated-file");
  const sd2 = await runLensReview({
    cwd: repo,
    branch: "feat/lineless-delta",
    diff: "diff --git a/src/other.ts b/src/other.ts\n+++ b/src/other.ts\n+export const o = 2;",
    head: head(),
    since: sdBase,
    lensChildFn: fixture.stubLens,
  });
  assert(
    (await branchRow("feat/lineless-delta"))?.status === "open" &&
      sd2.verdict === "CRITICAL_ISSUES_FOUND",
    `S-delta: a delta review never retires a line-less CRITICAL (${sd2.verdict})`,
  );

  // And under a round in which a lens was blocked it never retires either. A
  // blocked lens makes computeVerdict answer REVIEW_INCOMPLETE before it ever
  // looks at the findings (#3's "never silently downgrade"), so the verdict
  // alone cannot show the row survived: the assertion is on the ROW (still
  // `open`, and still carried into the review's blocking list).
  fresh("feat/lineless-incomplete");
  await runRound("feat/lineless-incomplete", head(), [lineless]);
  writeFileSync(path.join(repo, "src", "other.ts"), "export const o = 3;\n");
  sh("git add -A");
  sh("git commit -qm unrelated-file");
  blockNonFirst = true;
  const si2 = await runRound("feat/lineless-incomplete", head(), []);
  blockNonFirst = false;
  const siRow = await branchRow("feat/lineless-incomplete");
  assert(
    si2.verdict === "REVIEW_INCOMPLETE" &&
      siRow?.status === "open" &&
      si2.findings.some((f) => f.title === lineless.title),
    `S-incomplete: a round with a blocked lens never retires a line-less CRITICAL (${si2.verdict}/${siRow?.status})`,
  );

  // A row written BEFORE the fix: no `line`, the empty snippet hash, and no
  // `noLine` marker at all. It retires under the same rule with no migration,
  // so an operator with an already-stuck PR is unblocked by the next full review.
  fresh("feat/lineless-prefix");
  await runRound("feat/lineless-prefix", head(), [lineless]);
  const preFile = path.join(ledgerDir, FINDINGS_FILE);
  const preStored = JSON.parse(readFileSync(preFile, "utf8")) as {
    rows: Array<Record<string, unknown>>;
  };
  for (const r of preStored.rows) {
    if (r.branch === "feat/lineless-prefix") {
      // The pre-fix spelling: NEITHER `line` nor `noLine` present at all, which
      // JSON.stringify drops for an `undefined` value - so this writes the row
      // exactly as the pre-fix code wrote it, with no `delete` in the way.
      r.line = undefined;
      r.noLine = undefined;
      r.lineHash = undefined;
      r.snippetHash = snippetHashAt([], undefined);
    }
  }
  writeFileSync(preFile, JSON.stringify(preStored));
  const sp2 = await runRound("feat/lineless-prefix", head(), []);
  const spRow = await branchRow("feat/lineless-prefix");
  assert(
    spRow?.status === "resolved" && spRow.resolvedReason === "not-reported",
    `S-prefix: a pre-fix row (no line, empty snippet hash) retires under the same rule (${spRow?.status}/${spRow?.resolvedReason})`,
  );
  assert(
    sp2.verdict !== "CRITICAL_ISSUES_FOUND",
    `S-prefix: the pre-fix row no longer stamps the verdict (${sp2.verdict})`,
  );

  // A line-less row whose path is a DIRECTORY at head still carries (scenario Q
  // for the CRITICAL case): the retirement rule is not a second exit that
  // overrides "an invalid path has no automatic exit".
  fresh("feat/lineless-invalid");
  mkdirSync(path.join(repo, "src", "pkg2"));
  writeFileSync(path.join(repo, "src", "pkg2", "f.ts"), "export const f = 1;\n");
  sh("git add -A");
  sh("git commit -qm pkg2");
  await runRound("feat/lineless-invalid", head(), [
    { severity: "CRITICAL", path: "src/pkg2", title: "Directory gap" },
  ]);
  const sv2 = await runRound("feat/lineless-invalid", head(), []);
  const svRow = await branchRow("feat/lineless-invalid");
  assert(
    svRow?.status === "open" && sv2.verdict === "CRITICAL_ISSUES_FOUND",
    `S-invalid: a line-less CRITICAL on a directory path is carried, never retired (${sv2.verdict})`,
  );

  // A carried line-less finding renders `path:?`, never `path:undefined`
  // (criterion 3). The row has to still be CARRIED for the renderer to see it,
  // so this drives the incomplete control.
  fresh("feat/lineless-render");
  await runRound("feat/lineless-render", head(), [lineless]);
  blockNonFirst = true;
  const se2 = await runRound("feat/lineless-render", head(), []);
  blockNonFirst = false;
  assert(
    (await branchRow("feat/lineless-render"))?.status === "open",
    "S-render: the row is still carried, so the renderer has something to print",
  );
  const seRendered = renderSummary(se2, 1);
  assert(
    seRendered.includes(`${lineless.path}:?`),
    "S-render: the carried line-less finding renders path:?",
  );
  assert(
    !seRendered.includes("undefined"),
    "S-render: no rendered finding line contains the literal text undefined",
  );
  assert(
    seRendered.includes("Carried from earlier rounds (1)"),
    "S-render: the carried line-less row sits under the labelled carried heading",
  );
} finally {
  fixture.cleanup();
}

process.exit(exit);
