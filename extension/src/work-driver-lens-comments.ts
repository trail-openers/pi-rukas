/**
 * work-driver-lens-comments — the comment DATA block for the six-lens context
 * (#1040). Every lens receives it; the check runs in the lens worktree (`cwd`),
 * against the branch as pushed (`origin/<branch>`). An unrun check is NOT
 * CHECKED, never silence.
 */

import { COMMENT_JUDGEMENT_PROSE } from "./adversarial-prompts.ts";
import { renderCommentEvidence } from "./comment-evidence.ts";
import {
  COMMENT_RETENTION_PATHS,
  type LostCommentResult,
  findLostComments,
  makeExecFn,
} from "./comment-retention.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";

export async function lensCommentContext(
  cwd: string,
  baseSha: string | undefined,
  branchName: string | undefined,
): Promise<string> {
  let res: LostCommentResult;
  if (!baseSha || !branchName) {
    res = { ok: false, reason: "missing baseSha or branchName" };
  } else {
    try {
      res = await findLostComments(
        makeExecFn(),
        cwd,
        baseSha,
        `origin/${branchName}`,
        COMMENT_RETENTION_PATHS,
        verifyTimeoutMs(),
      );
    } catch (err) {
      res = { ok: false, reason: (err as Error).message?.slice(0, 120) || "error" };
    }
  }
  const data = renderCommentEvidence(res);
  return data ? `\n\n${data}\n\n${COMMENT_JUDGEMENT_PROSE}` : "";
}
