/**
 * work-driver-explain-own-commit — the cap-hit explanation for
 * `develop-incomplete-uncommitted` (#1768), split from work-driver-explain.ts
 * (which sits at the §12 500-line cap) the same way
 * work-driver-explain-develop-crash.ts is: one cap family, one module, and the
 * `explainCap` switch keeps a single one-line case for it.
 */

import { DEVELOP_INCOMPLETE_UNCOMMITTED } from "./work-develop-own-commit.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * #1768 — the child exited 0 with its work still uncommitted and no commit of
 * its own, and the one corrective pass committed nothing either. The evidence
 * names the paths, which is the whole point: pre-fix the driver committed them
 * itself and the step reported `agent done: developer` over unfinished work.
 */
export function explainOwnCommitIncomplete(state: WorkState): string {
  const ev = lastCapHit(state, DEVELOP_INCOMPLETE_UNCOMMITTED)?.evidence ?? "(no detail recorded)";
  return `a developer ended its develop pass with uncommitted paths and no commit of its own, and the corrective pass committed nothing either — ${ev}. The safety net did NOT commit them (that driver commit is what made an unfinished pass read as done, and the work then reached verify missing its deliverables), so the work is still sitting uncommitted in the worktree named above. Finish it and commit there (\`git -C <worktree> status\`, then commit), or split the issue so one pass fits what a child can finish and commit, then re-run \`/work <issue> --restart\``;
}
