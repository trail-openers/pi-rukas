/**
 * lens-review-autonomy-fixtures — the shared harness for the #1144 review-
 * autonomy scenarios (`test-review-autonomy.ts`'s #1125 block): a real clone
 * whose PR changes exactly one line, the findings-store seeder that puts a
 * round's findings on the carried path, and the round-capped merge decision.
 *
 * The scenarios drive the REAL `runLensReview` and the REAL merge guard, so
 * what they assert is the pipeline's behaviour, not a mock's. This module holds
 * only the scaffolding (the 500-line gate: the scenarios themselves live in the
 * test file, which already carried the adversarial-tool-path matrix).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MergeTarget } from "../../src/merge-target.ts";
import type { LedgerEntry } from "../../src/review-ledger.ts";
import { latestEntry, readLedgerAt } from "../../src/review-ledger.ts";
import { hookDecision } from "../merge-guard-helpers.ts";

/** A stored row's invariant fields: the test's rows are all open, unmatched,
 * and never resolved — an impossible snippet means the store matches no lens
 * finding to them and never resolves them, so a seeded row is a carried row. */
const SEEDED = {
  anchor: "file",
  lens: "SECURITY",
  snippetHash: "0000000000000000",
  status: "open",
  firstSeen: 1,
  lastSeen: 1,
} as const;

export interface SeedRow {
  severity: string;
  path: string;
  line?: number;
  title: string;
}

/** The findings-store file beside the ledger the review reads and writes. */
export function storeFileOf(ledgerFile: string): string {
  return path.join(path.dirname(ledgerFile), "review-findings.json");
}

/** Replace this branch's stored rows with `rows`, leaving other branches'
 * rows untouched (the store is one file for every branch of the clone). */
export function seedFindings(storeFile: string, branch: string, rows: readonly SeedRow[]): void {
  const onBranch = rows.map((r, i) => ({
    id: (0x1000 + i).toString(16).padStart(8, "0"),
    branch,
    path: r.path,
    titleClass: r.title.toLowerCase(),
    title: r.title,
    severity: r.severity,
    line: r.line,
    ...SEEDED,
  }));
  let others: unknown[] = [];
  try {
    others = (JSON.parse(readFileSync(storeFile, "utf8")).rows as unknown[]).filter(
      (r) => (r as { branch?: string }).branch !== branch,
    );
  } catch {
    // No store yet — this branch's rows are the whole file.
  }
  writeFileSync(storeFile, JSON.stringify({ rows: [...others, ...onBranch] }, null, 2), "utf8");
}

/** The branch's latest lens entry — the row the round-cap rule and the merge
 * guard read. */
export function latestLensEntry(ledgerFile: string, branch: string): LedgerEntry | undefined {
  return latestEntry(readLedgerAt(ledgerFile), branch, "lens");
}

/** Wait until the branch's lens entry records round `n`. The ledger write is
 * fire-and-forget (#984), so a scenario reads the entry through this seam
 * rather than racing it. */
export async function waitForLensRound(
  ledgerFile: string,
  branch: string,
  n: number,
): Promise<LedgerEntry | undefined> {
  for (let i = 0; i < 250; i++) {
    const row = latestLensEntry(ledgerFile, branch);
    if (row?.round === n) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return latestLensEntry(ledgerFile, branch);
}

/** The shape the #973 round-cap rule reads: ISSUES_FOUND at the round cap, with
 * the residual-findings disclosure on the PR (the marker is what makes the
 * carried findings visible; without it the guard refuses). `over` lets a caller
 * choose the strict rule's `passed` — the field the guard's strict path scores —
 * so a scenario picks which gate decides. */
export async function roundCapDecision(opts: {
  row: LedgerEntry;
  target: MergeTarget;
  over?: Partial<LedgerEntry>;
}) {
  const { row, target } = opts;
  const adversarial: LedgerEntry = {
    branch: row.branch,
    kind: "adversarial",
    patchId: row.patchId,
    passed: true,
    at: row.at - 1,
    detail: "completed",
  };
  const capped: LedgerEntry = {
    ...row,
    passed: false,
    round: 3,
    detail: "ISSUES_FOUND",
    ...opts.over,
  };
  const oid = row.headSha ?? target.headOid;
  return hookDecision("gh pr merge 12", [adversarial, capped], {
    patchId: row.patchId,
    ghComments: JSON.stringify({
      comments: [
        {
          body: `residuals\n<!-- pi-rukas:lens-residuals branch=${row.branch} patch=${row.patchId} -->`,
        },
      ],
    }),
    fetchedHead: oid,
    target: { ...target, headOid: oid },
  });
}

/** The same merge with NO disclosure comment on the PR — the refusal half of
 * the round-cap rule. */
export async function mergeWithoutDisclosure(opts: {
  row: LedgerEntry;
  target: MergeTarget;
}) {
  const { row, target } = opts;
  const oid = row.headSha ?? target.headOid;
  return hookDecision("gh pr merge 12", [], {
    patchId: row.patchId,
    ghComments: JSON.stringify({ comments: [] }),
    fetchedHead: oid,
    target: { ...target, headOid: oid },
  });
}

/** Commit `files` on a new branch cut from the mainline, then commit one more
 * time with `final` — so the PR's changed lines are exactly the lines `final`
 * adds, and every file present before is out of the range. The scenarios need
 * to know the changed ranges exactly; a helper that "makes a repo" and leaves
 * the range implicit is what makes such a test wrong. */
export function buildPrRepo(
  repoDir: string,
  branch: string,
  files: Record<string, string>,
  final: Record<string, string>,
): void {
  const g = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
  g("checkout", "-q", "-b", branch, "main");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(repoDir, name), content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "branch start");
  for (const [name, content] of Object.entries(final)) {
    writeFileSync(path.join(repoDir, name), content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "the PR's change");
}
