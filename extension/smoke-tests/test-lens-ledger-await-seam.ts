#!/usr/bin/env bun
/**
 * #984 — the deterministic-await seam: `finishLensReview` returns
 * `{ summary, ledgerWrite }`; awaiting `ledgerWrite` lets an offline test
 * read the ledger file after the run. This case asserts that the summary is
 * byte-identical before and after awaiting `ledgerWrite`.
 * Resolution-independence (the summary resolving without the write) is a
 * structural property of `finishLensReview`, not something this case proves.
 *
 * Lives in its own file (moved out of test-lens-kill-ledger.ts) to stay
 * under the 500-line file gate without condensing the other file's header.
 * Uses the REAL ledger write (no mock — `finishLensReview` swallows write
 * failures via catch(trace), so the await always resolves) in a temp repo
 * whose git common dir receives the ledger file.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { finishLensReview } from "../src/lens-review-finish.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
    exit = 1;
  }
  return a === e;
}
// Temp repo with a local bare origin + a feature branch (same shape as the
// setupRepo in test-lens-kill-ledger.ts — duplicated here because that helper
// is test-local and not shared in smoke-tests/lib/).
function setupRepo(): { repo: string; branch: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lens984-repo-"));
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin.git");
  execSync(`git init -q ${origin}`, { stdio: "ignore" });
  execSync(`git clone -q ${origin} ${repo}`, { stdio: "ignore" });
  const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "ignore" });
  git("git config user.email t@t.t");
  git("git config user.name t");
  git("echo base > base.txt");
  git("git add base.txt");
  git('git commit -qm "base"');
  git("git branch -M dev");
  git("git push -q origin dev");
  git("git remote set-head origin dev");
  git("git checkout -qb feature/x dev");
  git("echo change > change.txt");
  git("git add change.txt");
  git('git commit -qm "change"');
  git("git push -q origin feature/x");
  return {
    repo,
    branch: "feature/x",
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

{
  const repo = setupRepo();
  const blockedSummary = {
    verdict: "REVIEW_INCOMPLETE" as const,
    totalFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [
      {
        lens: "SIMPLICITY",
        ok: false,
        ms: 10,
        startMs: 0,
        findings: [],
        attempts: 1,
        blocked: true,
        parseError: "spawn failed",
      },
    ],
    findings: [],
  };
  const r = await finishLensReview(blockedSummary, "MEDIUM", repo.repo, repo.branch, {
    hasCritical: false,
  });
  try {
    eq(r.summary.verdict, "REVIEW_INCOMPLETE", "(2e) finish returns REVIEW_INCOMPLETE");
    // Snapshot the summary SYNCHRONOUSLY before the await — the two sides
    // must be independent (a shared r.summary on both sides would compare
    // the value against itself).
    const beforeJson = JSON.stringify(r.summary);
    // Await the ledger write — the seam the issue's deterministic-await option
    // requires; writeLensLedgerEntry swallows failures via catch(trace).
    await r.ledgerWrite;
    // The #912 rule — the ledger write is a side effect, never a gate.
    assert(
      JSON.stringify(r.summary) === beforeJson,
      "(2e) the summary is byte-identical across the ledger-write await — summary changed across the ledger-write await",
    );
    assert(
      JSON.stringify(r.summary) === JSON.stringify({ ...blockedSummary, note: r.summary.note }),
      "(2e) the summary still matches the blocked shape plus the finish note",
    );
    // #973 — the disclosure note fires ONLY on ISSUES_FOUND; this run is
    // REVIEW_INCOMPLETE, so no note is set (finish's single note site).
    assert(r.summary.note === undefined, "(2e) a non-ISSUES_FOUND run carries no note");
  } finally {
    repo.cleanup();
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
