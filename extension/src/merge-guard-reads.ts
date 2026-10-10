/**
 * merge-guard-reads — the forge reads and refusal texts the merge guard
 * (merge-guard.ts) needs on the lens-decision branch, extracted into their
 * own module to keep the guard under the 500-line file-size limit.
 *
 * Two concerns live here:
 *
 * - `readPrCommentBodies` (#973): the PR/MR comment bodies the round-cap
 *   path's disclosure check reads (the guard's own exec call through the
 *   injectable `execFn`, no new forge seam).
 * - The strict-rule / not-evaluated refusal texts for the lens branch
 *   (#1000): the `applies: false` fall-through must distinguish "the
 *   round-cap path was not evaluated" from the `applies: true` path, where
 *   the rule WAS evaluated and a specific condition N failed (that refusal
 *   names the condition verbatim).
 */

import { prCommentsCmd } from "./forge-commands.ts";
import { extractCommentRows } from "./forge-comments.ts";
import type { MergeExecFn, MergeTarget } from "./merge-target.ts";
import { isValidRepoValue } from "./merge-tokens.ts";
import type { LedgerEntry } from "./review-ledger.ts";
import { trace } from "./trace.ts";

/** Per-exec timeout for the guard's gh/git calls. */
const EXEC_TIMEOUT_MS = 30_000;

/**
 * #973 — the PR/MR comment bodies the round-cap path's disclosure check
 * reads (design decision 5: the guard's own exec call through the injectable
 * `execFn`, no new forge seam). The command is the CANONICAL seam
 * `prCommentsCmd` (forge-commands.ts — the same shape the `prComments`
 * adapter seam and the residual-disclosure post use: `gh pr view N
 * --json comments` on GitHub, the MR's `notes` endpoint on GitLab), so the
 * round-cap path works on GitLab too (a `glab mr view N --output json` read
 * has no `notes` field at all — the GitLab branch of the old hand-rolled
 * read could never find the marker). Every fault is fail-closed: an
 * unreadable comments list returns [] (the marker check fails, the merge is
 * refused) — the disclosure is a condition, and a missing condition is a
 * refusal, never a pass.
 */
export async function readPrCommentBodies(
  execFn: MergeExecFn,
  cwd: string,
  target: MergeTarget,
  prNumber: number,
  repoValue: string | undefined,
): Promise<string[]> {
  // Defensive second check mirroring readGhTarget (#955 lens fix 1): the
  // repo value is agent-derived (the `-R` flag or a PR URL) and is
  // interpolated into this exec string; an invalid value is a refusal
  // (fail closed — [] means the marker check fails and the merge is
  // refused), never a post or a pass.
  if (repoValue !== undefined && !isValidRepoValue(repoValue)) {
    trace(`merge-guard: invalid repo value ${repoValue} — comment read refused (fail closed)`);
    return [];
  }
  const repoFlag = repoValue ? ` -R ${repoValue}` : "";
  try {
    const { stdout } = await execFn(prCommentsCmd(target.forge, prNumber) + repoFlag, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: EXEC_TIMEOUT_MS,
    });
    return extractCommentRows(target.forge, stdout).map((row) => {
      const o = row as Record<string, unknown>;
      const body = o.body;
      return typeof body === "string" ? body : "";
    });
  } catch (err) {
    trace(`merge-guard: comment read failed: ${(err as Error).message?.slice(0, 120)}`);
    return [];
  }
}

/**
 * #1000 — the lens-branch refusal text. The round-cap path was consulted
 * and REFUSED TO APPLY (`applies: false`); the operator must be told that
 * the round-cap path was NOT evaluated — distinct from the `applies: true`
 * path, where the rule WAS evaluated and a specific condition N failed (the
 * guard renders that condition verbatim).
 *
 * Two shapes: no lens entry at all (nothing to evaluate), and a lens entry
 * whose verdict the round-cap rule cannot verify (a legacy row without a
 * `detail` field, or a non-ISSUES_FOUND verdict — the rule applies ONLY to
 * an ISSUES_FOUND latest entry).
 */
export function lensNotEvaluatedRefusal(
  branch: string,
  lens: LedgerEntry | undefined,
): { block: true; reason: string } {
  const override = " (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";
  if (!lens) {
    return {
      block: true,
      reason: `no lens review on file for branch \`${branch}\` (latest: none) — the round-cap path was not evaluated (there is no entry to evaluate); run dispatch_lens_review and let it complete before merging${override}`,
    };
  }
  // A MALFORMED (non-string) detail is refused earlier by the round-cap
  // path itself (applies: true names the malformed entry), so the only
  // fall-through without a string detail is a row that simply lacks it.
  const detail =
    typeof lens.detail === "string"
      ? `verdict=${lens.detail}`
      : "verdict=unrecorded (legacy entry)";
  return {
    block: true,
    reason: `no passing lens review on file for branch \`${branch}\` (latest: passed=${lens.passed}, ${detail}) — the round-cap path was not evaluated (it applies only to an ISSUES_FOUND latest entry); run dispatch_lens_review and let it complete before merging${override}`,
  };
}
