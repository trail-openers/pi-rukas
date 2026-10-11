/**
 * work-develop-resume-backup — #1016: protect uncommitted work before a resumed
 * develop fan-out re-dispatches a workstream into its existing worktree.
 *
 * A crash can leave a failed workstream's partial edits in its worktree. The
 * resumed attempt would run the developer over them with no saved copy, so an
 * overwrite would lose them. Before any non-kept workstream is dispatched, its
 * uncommitted work (driver artefacts excluded) is saved to a re-appliable patch
 * against its base. The worktree is NOT reset here. A workstream whose state
 * cannot be read or saved is refused (fail closed), never dispatched.
 */
import { trace } from "./trace.ts";
import {
  type ExecFn,
  errText,
  isValidBaseSha,
  nextRetryAttempt,
  retryPatchPath,
  runGit,
  savePartialWork,
  workEntriesOf,
  worktreeStatus,
} from "./work-develop-git.ts";

export interface InterruptedBackup {
  /** Workstream id → the reason it must not be dispatched. */
  refused: Record<string, string>;
  /** Workstream id → the saved patch path (one per workstream with work). */
  saved: Record<string, string>;
}

/** Save each non-kept workstream's uncommitted work to a patch before dispatch. */
export async function backupInterruptedWorktrees(args: {
  execFn: ExecFn;
  repoRoot: string;
  scratchAbs: string;
  ids: string[];
  worktrees: Record<string, string | undefined>;
  baseFor: (id: string) => string | undefined;
}): Promise<InterruptedBackup> {
  const out: InterruptedBackup = { refused: {}, saved: {} };
  const git = runGit(args.execFn);
  for (const id of args.ids) {
    const cwd = args.worktrees[id];
    if (typeof cwd !== "string") continue; // a missing worktree is refused by the fan-out
    const status = await worktreeStatus(git, cwd);
    if (!Array.isArray(status)) {
      out.refused[id] = `uncommitted state unreadable — ${status.unreadable}`;
      continue;
    }
    const work = workEntriesOf(status).map((e) => e.path);
    if (work.length === 0) continue;
    const base = args.baseFor(id);
    if (!isValidBaseSha(base)) {
      out.refused[id] = "uncommitted work present but base is not a 40-hex sha";
      continue;
    }
    try {
      // The next free attempt number: a second resume never collides with the first.
      const attempt = await nextRetryAttempt(args.scratchAbs, id);
      const patchPath = retryPatchPath(args.scratchAbs, id, attempt);
      out.saved[id] = await savePartialWork(git, cwd, base, work, patchPath);
      trace(`work-driver: resumed ${id}: uncommitted work saved to ${out.saved[id]}`);
    } catch (err) {
      out.refused[id] = `could not save uncommitted work before resume — ${errText(err)}`;
    }
  }
  return out;
}
