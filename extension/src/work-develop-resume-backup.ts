/**
 * work-develop-resume-backup — #1016: protect uncommitted work before a resumed
 * develop fan-out re-dispatches a workstream into its existing worktree.
 *
 * A crash can leave a failed workstream's partial edits in its worktree. The
 * resumed attempt would run the developer over them with no saved copy, so an
 * overwrite would lose them. Before any non-kept workstream is dispatched, its
 * uncommitted work (driver artefacts excluded) is saved to a re-appliable patch
 * against its base. The worktree is NOT reset here. A workstream whose state
 * cannot be read or saved is refused (fail closed), never dispatched. A
 * workstream whose cwd is outside `<repoRoot>/.worktrees/` is refused before any
 * git write touches it.
 */
import { trace } from "./trace.ts";
import {
  type ExecFn,
  assertInsideWorktrees,
  errText,
  isValidBaseSha,
  nextRetryAttempt,
  retryPatchPath,
  runGit,
  savePartialWork,
  unstagePaths,
  workEntriesOf,
  worktreeStatus,
} from "./work-develop-git.ts";

export interface InterruptedBackup {
  /** Workstream id → the reason it must not be dispatched. */
  refused: Record<string, string>;
  /** Workstream id → the saved patch path (one per workstream with work). */
  saved: Record<string, string>;
  /** Notes that do not refuse anything (e.g. an unstage that failed after a save). */
  notes: string[];
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
  const out: InterruptedBackup = { refused: {}, saved: {}, notes: [] };
  const git = runGit(args.execFn);
  for (const id of args.ids) {
    const cwd = args.worktrees[id];
    if (typeof cwd !== "string") continue; // a missing worktree is refused by the fan-out
    try {
      assertInsideWorktrees(args.repoRoot, cwd);
    } catch (err) {
      out.refused[id] = `persisted worktree path refused — ${errText(err)}`;
      continue;
    }
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
    let saved: string;
    try {
      // The next free attempt number: a second resume never collides with the first.
      const attempt = await nextRetryAttempt(args.scratchAbs, id);
      const patchPath = retryPatchPath(args.scratchAbs, id, attempt);
      saved = await savePartialWork(git, cwd, base, work, patchPath);
    } catch (err) {
      out.refused[id] = `could not save uncommitted work before resume — ${errText(err)}`;
      continue;
    }
    out.saved[id] = saved;
    trace(`work-driver: resumed ${id}: uncommitted work saved to ${saved}`);
    // The save staged the work to build the patch; unstage it so the index is
    // left as the developer left it (the working tree is never touched here). A
    // failure after a successful save is a note: the patch exists, so it does
    // not refuse the workstream.
    try {
      await unstagePaths(git, cwd, work);
    } catch (err) {
      out.notes.push(
        `${id}: could not unstage the saved work after the resume save — ${errText(err)}`,
      );
    }
  }
  return out;
}
