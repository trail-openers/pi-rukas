/**
 * adversarial-comments — the comment-retention check for ONE adversarial round
 * (#1040). It runs on the diff that round reviews; the result feeds both the
 * reviewer's prompt (renderCommentEvidence) and the loop's `comments:` report
 * line (formatReportLine), so the two can never disagree.
 */

import {
  COMMENT_RETENTION_PATHS,
  type LostCommentResult,
  checkDiffComments,
  commentRetentionEnabled,
} from "./comment-retention.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";

export async function roundCommentCheck(
  diff: string,
  headRef: string | undefined,
  workCwd: string | undefined,
): Promise<LostCommentResult> {
  if (!commentRetentionEnabled()) {
    return { ok: false, reason: "PI_ENSEMBLE_COMMENT_RETENTION=0" };
  }
  return checkDiffComments(
    diff,
    headRef,
    workCwd ?? process.cwd(),
    verifyTimeoutMs(),
    undefined,
    COMMENT_RETENTION_PATHS,
  );
}
