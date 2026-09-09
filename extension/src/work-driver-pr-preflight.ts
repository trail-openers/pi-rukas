/**
 * work-driver-pr-preflight — "does this issue already have an open PR?"
 *
 * The driver had no answer to that question. `runBranch` never looked, and
 * `mechanizedCommitPr` calls `gh pr create` unconditionally, so a cycle
 * started with `--restart` (which wipes the state file) treats an issue as
 * greenfield even when a PR for it is sitting open on GitHub.
 *
 * Live evidence — issue #5, 2026-08-05: PR #358 was open on
 * `feature/issue-5-surface-thinking-only-output` when `/work 5 --restart`
 * ran. The driver picked a near-identical slug
 * (`…-thinking-only-model-output`), rebuilt the whole issue, and merged that
 * as PR #359. #358 is now orphaned — its issue is closed, so it can never
 * auto-close — and the two implementations had diverged (#359 guards
 * `toolUses.length === 0`, #358 does not). A full cycle was paid for twice
 * and the winner was decided by merge order, not review.
 *
 * The load-bearing detail: the second cycle chose a DIFFERENT branch name,
 * so a branch-scoped lookup would not have caught it. The idempotency key
 * has to be the issue number (#362).
 *
 * This module only detects. Adopting an existing branch/PR and resuming into
 * it needs mechanized branch setup (#287); until then the driver halts with a
 * cap-hit and lets the operator decide, per §7 cap-hit doctrine.
 */

import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** An open PR the driver believes already covers this cycle's issue. */
export interface ExistingPr {
  number: number;
  headRefName: string;
  /** Which signal matched — surfaced in the handoff so the operator can judge it. */
  matchedBy: "body" | "branch";
}

/** Shape of the normalized PR rows we consume (forge adapter rows). */
export interface PrListRow {
  number: number;
  headRefName?: string;
  body?: string;
}

/** #362 escape hatch: PI_ENSEMBLE_PR_PREFLIGHT=0 restores the old blind-create behaviour. */
export function prPreflightEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_PR_PREFLIGHT;
  return v !== "0" && v !== "false";
}

/**
 * Match an open PR against an issue number, most-reliable signal first.
 *
 * 1. A GitHub closing keyword in the body. `mechanizedCommitPr` writes
 *    `Fixes #<N>` for every active issue (work-driver-commit.ts), so this is
 *    exact for driver-authored PRs. `Closes` / `Resolves` are accepted too
 *    since human-authored PRs use them interchangeably.
 * 2. The head branch naming the issue. Catches human and pre-driver branches
 *    that never wrote a closing keyword.
 *
 * Both patterns reject a numeric continuation, so issue #5 does not match
 * `Fixes #55` or `feature/issue-55-…`.
 *
 * Known gap: for a bundled branch like `issues-85-111-114`, only the FIRST
 * issue matches by branch. The body check covers the rest for driver-authored
 * PRs, which is where bundling comes from in the first place.
 */
export function matchPrForIssue(prs: PrListRow[], issue: number): ExistingPr | undefined {
  const bodyRe = new RegExp(
    String.raw`\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#${issue}(?!\d)`,
    "i",
  );
  const branchRe = new RegExp(String.raw`issues?-?${issue}(?!\d)`, "i");
  const byBody = prs.find((pr) => bodyRe.test(pr.body ?? ""));
  if (byBody) {
    return {
      number: byBody.number,
      headRefName: byBody.headRefName ?? "(unknown)",
      matchedBy: "body",
    };
  }
  const byBranch = prs.find((pr) => branchRe.test(pr.headRefName ?? ""));
  if (byBranch) {
    return {
      number: byBranch.number,
      headRefName: byBranch.headRefName ?? "(unknown)",
      matchedBy: "branch",
    };
  }
  return undefined;
}

/**
 * Look for an open PR already covering `issue`.
 *
 * Fails OPEN: any `gh` or parse failure returns undefined so the cycle
 * proceeds. A lookup outage must never block work — the cost of missing a
 * duplicate is one wasted cycle, the cost of a false halt is every cycle.
 */
export async function findOpenPrForIssue(
  execFn: VerifyExecFn,
  repoRoot: string,
  issue: number,
): Promise<ExistingPr | undefined> {
  // NOTE: this site stays a direct command rather than going through the
  // forge adapter because the test suite pins the `gh pr list` command
  // string and the raw-JSON row shape (which does not include `body`,
  // the field `matchPrForIssue` reads). The forge adapter's `prList` does
  // not request `body` in its `--json` field list, so routing through it
  // would break the body-signal half of the matcher. The S4 spec for this
  // file does not name a forge method for this site either.
  let stdout: string;
  try {
    ({ stdout } = await execFn(
      "gh pr list --state open --limit 100 --json number,headRefName,body",
      {
        cwd: repoRoot,
        maxBuffer: 4 * 1024 * 1024,
      },
    ));
  } catch (err) {
    trace(`pr-preflight: gh pr list failed, proceeding: ${(err as Error).message?.slice(0, 200)}`);
    return undefined;
  }
  let rows: PrListRow[];
  try {
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) return undefined;
    rows = parsed as PrListRow[];
  } catch (err) {
    trace(
      `pr-preflight: gh pr list returned unparseable JSON: ${(err as Error).message?.slice(0, 120)}`,
    );
    return undefined;
  }
  return matchPrForIssue(rows, issue);
}

/**
 * Exact-branch re-entry check for `mechanizedCommitPr` (census 2026-09-09):
 * an OPEN PR whose head IS this cycle's branch means a previous attempt
 * already consolidated, pushed and opened the PR — re-running `integrate()`
 * would `checkout -B` the branch back to base and `prCreate` a duplicate.
 * Distinct from `findOpenPrForIssue` (fuzzy issue/branch matching, used
 * before any dispatch is paid): this one is exact and runs at the seam that
 * actually creates the PR. Fails OPEN (undefined) on any gh/JSON error —
 * the push non-fast-forward rejection remains the backstop.
 */
export async function findOpenPrForBranch(
  execFn: VerifyExecFn,
  repoRoot: string,
  branchName: string,
): Promise<number | undefined> {
  try {
    const { stdout } = await execFn(
      `gh pr list --state open --head ${JSON.stringify(branchName)} --json number --limit 5`,
      { cwd: repoRoot, maxBuffer: 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) return undefined;
    const n = (parsed[0] as { number?: unknown } | undefined)?.number;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  } catch (err) {
    trace(
      `pr-preflight: gh pr list --head failed, proceeding: ${(err as Error).message?.slice(0, 200)}`,
    );
    return undefined;
  }
}
