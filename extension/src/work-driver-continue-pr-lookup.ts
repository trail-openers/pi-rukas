/**
 * work-driver-continue-pr-lookup — #1468: decide whether `--continue-pr` has
 * exactly one PR it may continue, and whether that PR's head is safe to use.
 * Everything here is read-only: it caps before any branch, ref or worktree
 * is touched.
 */

import type { ForgeType } from "./forge-detect.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { netRefProblem } from "./work-driver-net-git.ts";
import type { OpenPrLookup, OpenPrMatch } from "./work-driver-pr-preflight.ts";

export type ContinueLookupOutcome =
  | { ok: true; pr: OpenPrMatch }
  | {
      cap: "continue-pr-not-found" | "continue-pr-ambiguous" | "continue-pr-fork";
      evidence: string;
    };

/** Map a lookup to the one PR to continue, or the cap that says why not. */
export function classifyContinueLookup(
  result: OpenPrLookup,
  issue: number,
  forge: ForgeType,
): ContinueLookupOutcome {
  if (forge !== "github") {
    return {
      cap: "continue-pr-not-found",
      evidence: `the forge is ${forge}; --continue-pr reads GitHub pull requests only`,
    };
  }
  if (result.kind === "unreadable")
    return { cap: "continue-pr-not-found", evidence: result.reason };
  const [pr, ...rest] = result.prs;
  if (!pr) return { cap: "continue-pr-not-found", evidence: `no open PR matches issue #${issue}` };
  if (rest.length > 0) {
    const list = result.prs.map((p) => `#${p.number} (${p.matchedBy})`).join(", ");
    return { cap: "continue-pr-ambiguous", evidence: `open PRs for issue #${issue}: ${list}` };
  }
  // gh omits isCrossRepository for an unknown fork state; only an explicit false is ours.
  if (pr.isCrossRepository !== false || !pr.headRepository) {
    return {
      cap: "continue-pr-fork",
      evidence: `PR #${pr.number} head ${pr.headRefName ?? "(unknown)"} is from another repository or a deleted fork`,
    };
  }
  return { ok: true, pr };
}

/**
 * Why the PR's head may not be used, or undefined. The head name comes from
 * the PR, so it is untrusted: the character check runs before git sees it,
 * and git runs in argv form.
 */
export async function continueHeadProblem(
  execFn: VerifyExecFn,
  repoRoot: string,
  pr: OpenPrMatch,
  mainline: string,
): Promise<string | undefined> {
  const head = pr.headRefName ?? "";
  const refProblem = netRefProblem(head);
  if (refProblem) return `PR #${pr.number} head: ${refProblem}`;
  try {
    await execFn("git", { argv: ["check-ref-format", "--branch", head], cwd: repoRoot });
  } catch {
    return `PR #${pr.number} head "${head}" is not a valid branch name`;
  }
  if (head === mainline) return `PR #${pr.number} head is the mainline ${mainline}`;
  if (pr.baseRefName !== mainline) {
    return `PR #${pr.number} targets ${pr.baseRefName ?? "(unknown)"}, not the mainline ${mainline}`;
  }
  return undefined;
}
