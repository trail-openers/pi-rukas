/**
 * work-driver-branch-salvage — #545 same-issue dirty worktree salvage.
 *
 * The branch step refuses a dirty leftover of the SAME issue (#475's
 * refusal is unchanged — the worktree is never destroyed here). But the
 * operator who hit that refusal used to salvage by hand (`git diff >
 * patch`, copy the untracked files, then remove). This module is the
 * deterministic version of that recipe: for every worktree the cycle
 * ALREADY knows about (`state.pipelineState.worktrees`, populated by a
 * prior branch step — the `--restart` shape where the state file
 * survives the wipe), if it holds work, copy `git diff HEAD`, the
 * untracked-file manifest, and the untracked file contents into
 * `<scratch>/salvage/<basename>/`. Returns a human-readable summary
 * (empty when nothing was salvaged) for the plumb report.
 *
 * NEVER removes the worktree — that decision stays with the operator.
 * Any git failure on a single worktree is skipped (traced), not fatal:
 * salvage must not turn a handoff into a crash.
 */

import { trace } from "./trace.ts";
import { type ExecFn, inspectWorktreeForLoss } from "./worktree.ts";
import { salvageUncommittedWork } from "./worktree-salvage.ts";

async function salvageKnownDirtyWorktreesInner(
  execFn: ExecFn,
  wtPath: string,
  id: string,
  scratchAbs: string,
): Promise<string | undefined> {
  const finding = await inspectWorktreeForLoss(execFn, wtPath, wtPath, "HEAD").catch(
    () => undefined,
  );
  if (!finding) return undefined; // clean — nothing to salvage
  const salvageDir = await salvageUncommittedWork(execFn, wtPath, scratchAbs);
  return `Salvaged dirty worktree ${wtPath} (workstream '${id}') to ${salvageDir} (salvage.patch, untracked.txt, files/) — inspect it, then remove the worktree (\`git worktree remove --force -- ${wtPath}\`) and re-run.`;
}

export async function salvageKnownDirtyWorktrees(
  execFn: ExecFn,
  worktrees: Record<string, string>,
  scratchAbs: string,
): Promise<string> {
  const notes: string[] = [];
  for (const [id, wtPath] of Object.entries(worktrees)) {
    const note = await salvageKnownDirtyWorktreesInner(execFn, wtPath, id, scratchAbs).catch(
      (salvErr) => {
        trace(
          `work-driver: salvage of ${wtPath} failed: ${(salvErr as Error).message?.slice(0, 200)}`,
        );
        return undefined;
      },
    );
    if (note) notes.push(note);
  }
  return notes.join("\n");
}
