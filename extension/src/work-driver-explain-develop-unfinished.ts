/**
 * work-driver-explain-develop-unfinished — the cap-hit explanation for
 * `develop-incomplete-uncommitted` (#1768), split from
 * `work-driver-explain.ts` so that file stays under the §12 500-line cap with
 * headroom for new caps. Same seam as `work-driver-explain-develop-crash.ts`:
 * one cap family, one module, and the `explainCap` switch keeps a one-line
 * case for it.
 *
 * The sentence is built from the `branch-completed.unfinished` records the
 * classify seam wrote (which workstream, which tree reading, which paths), so
 * the operator sees WHAT the child left uncommitted rather than merely that a
 * pass was refused — and can recover it from the worktree, because the driver
 * deliberately never commits it.
 */

import { developUnfinished, unfinishedTreeSentence } from "./work-develop-unfinished.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

export function explainDevelopUnfinished(state: WorkState): string {
  const blocked = developUnfinished(state.eventLog);
  const hit = lastCapHit(state, "develop-incomplete-uncommitted");
  if (blocked.length === 0) {
    return `a develop child reported ok without committing its own work and the driver could not read back which workstream it was — ${hit?.evidence ?? "the state file's event log carries the dispatch tail"}. Inspect each worktree (\`git -C <worktree> status\`) before re-running: the pass left its work uncommitted and the safety net deliberately did not commit it, because committing a pass the driver cannot certify is how orchard #439/#507 shipped a cycle whose test file was never written`;
  }
  const detail = blocked.map((r) => `[${r.id}] ${unfinishedTreeSentence(r)}`).join("; ");
  return `a develop child exited 0 and reported itself done, but made no commit of its own ahead of its base while its work was still sitting in the worktree, so the pass is NOT counted as done and the driver dispatched one corrective round to finish and commit it — ${detail}. The corrective round did not finish either, so the cycle parked here rather than verifying a step nobody completed: the safety net is recovery for a pass that earned its green and never commits an unfinished one, so the work is still in the worktree named above. Commit or finish it there (\`git -C <worktree> status\`, then \`git -C <worktree> diff\`) and re-run \`/work <issue> --restart\``;
}
