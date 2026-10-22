/**
 * work-develop-own-commit — #1768: a develop pass counts as done only when the
 * child COMMITTED its own work.
 *
 * The green path in work-develop-topological.ts (runAt) and work-develop-
 * dependent.ts ran the #622 safety net BEFORE `greenCountsAsWork`. A child that
 * exited 0 mid-step with a dirty worktree and no commit of its own had its dirt
 * committed by the net, and that driver commit then satisfied commits > 0 — so
 * unfinished work was reported as `agent done: developer` and rode into verify
 * (orchard #507: six paths committed by the net, `test/review_test.sh` never
 * written; orchard #439: the same at 80 minutes).
 *
 * This module asks the question the net was answering for the child: did THIS
 * pass commit anything? It reads with the two primitives the crash path already
 * uses (`commitsAheadOfBase`, the crash path's bounded status reader) and adds
 * no git reader of its own.
 *   - commits > 0            → own work; the caller runs the net exactly as today
 *   - 0 commits, clean tree  → unchanged, so the existing GREEN_DOWNGRADE applies
 *   - 0 commits, dirty tree  → UNFINISHED: no net, one corrective dispatch into
 *     the SAME worktree (no reset, no clean), then one re-read
 *   - either read unreadable → not-ok; never read as clean or green
 */
import type { DispatchResult } from "./types.ts";
import { trace } from "./trace.ts";
import { uncommittedPaths } from "./work-develop-crash.ts";
import { type ExecFn, commitsAheadOfBase, runGit } from "./work-develop-git.ts";

/** How many uncommitted paths a reason or prompt names before it says +N more. */
const SHOWN_PATHS = 10;
/** Bound on the reason string the verdict and the cap evidence carry. */
const REASON_MAX = 400;

function namePaths(paths: string[]): string {
  if (paths.length === 0) return "none";
  const shown = paths.slice(0, SHOWN_PATHS).join(", ");
  return paths.length > SHOWN_PATHS ? `${shown} (+${paths.length - SHOWN_PATHS} more)` : shown;
}

/** The corrective pass: same workstream, same worktree, same dispatch seam the
 *  first pass used. Returns the child's reply text (appended-to prompt is the
 *  caller's business; this module only asks the child to finish). */
/** The corrective pass: same workstream, same worktree, same dispatch seam the
 *  first pass used. `undefined` means it could not be dispatched (no captured
 *  brief), which the caller still parks on — it never reads as green. */
export type CorrectiveDispatch = (paths: string[]) => Promise<DispatchResult | undefined>;

export type OwnCommitOutcome =
  /** The pass has commits of its own (or had none and the corrective round made
   *  them): the caller continues on the normal green path, safety net included. */
  | { kind: "own-work" }
  /** Nothing to do: 0 commits and a clean tree. The caller's existing
   *  GREEN_DOWNGRADE path applies unchanged. */
  | { kind: "unchanged" }
  /** The corrective round committed, or the pass already had commits. */
  | { kind: "green"; uncommittedBefore: string[] }
  /** Unfinished: no commit of its own, dirt left, corrective round did not fix it. */
  | { kind: "unfinished"; uncommitted: string[]; reason: string };

/** The paragraph the corrective dispatch is told: what is still uncommitted,
 *  and that finishing means committing. Short — the child already has its full
 *  original brief in the prompt this is appended to. */
export function unfinishedPromptSuffix(paths: string[]): string {
  return [
    "",
    "",
    `Your previous pass ended with ${paths.length} uncommitted path(s) and no commit of your own:`,
    namePaths(paths),
    "Finish the work you described as remaining, then COMMIT it. The step is not counted",
    "done until a commit of yours is ahead of your base; the driver will not commit it for you.",
  ].join("\n");
}

export async function requireOwnCommit(args: {
  id: string;
  cwd: string;
  base: string | undefined;
  execFn: ExecFn;
  /** The caller's dispatch for this workstream, with the corrective paragraph appended. */
  corrective?: CorrectiveDispatch;
}): Promise<OwnCommitOutcome> {
  const { id, cwd, base, execFn } = args;
  const git = runGit(execFn);
  const read = async (): Promise<{ commits: number } | { unreadable: string }> =>
    commitsAheadOfBase(git, cwd, base);

  const first = await read();
  if (!("commits" in first))
    return {
      kind: "unfinished",
      uncommitted: [],
      reason: `commits ahead of base unreadable — ${first.unreadable}`,
    };
  if (first.commits > 0) return { kind: "own-work" };

  const status = await uncommittedPaths(execFn, cwd);
  if (!("paths" in status))
    return {
      kind: "unfinished",
      uncommitted: [],
      reason: `worktree status unreadable — ${status.unreadable}`,
    };
  if (status.paths.length === 0) return { kind: "unchanged" };

  trace(
    `work-driver: develop ${id} — exited without a commit of its own, ${status.paths.length} uncommitted path(s): ${namePaths(status.paths)}`,
  );
  const unfinished = (extra?: string): OwnCommitOutcome => ({
    kind: "unfinished",
    uncommitted: status.paths,
    reason: `${status.paths.length} uncommitted path(s), no commit of its own: ${namePaths(status.paths)}${extra ? `; ${extra}` : ""}`.slice(0, REASON_MAX),
  });
  if (!args.corrective) return unfinished();

  const again = await args.corrective(status.paths);
  if (again === undefined) return unfinished("the corrective pass could not be dispatched");

  const second = await read();
  if (!("commits" in second))
    return unfinished(`corrective pass left the commit count unreadable — ${second.unreadable}`);
  if (second.commits > 0) {
    trace(
      `work-driver: develop ${id} — corrective pass committed its own work (${second.commits} commit(s))`,
    );
    return { kind: "green", uncommittedBefore: status.paths };
  }
  return unfinished("the corrective pass committed nothing either");
}
