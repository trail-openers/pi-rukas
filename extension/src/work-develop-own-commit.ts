/**
 * work-develop-own-commit — #1768: a develop pass counts as done only when the
 * child COMMITTED its own work. The green path in work-develop-topological.ts
 * and work-develop-dependent.ts ran the #622 safety net BEFORE
 * `greenCountsAsWork`, so a child that exited 0 with a dirty tree and no commit
 * of its own had its dirt committed by the net — and that DRIVER commit then
 * satisfied commits > 0, so unfinished work read as `agent done: developer`
 * (orchard #507: six paths committed by the net, its test never written; orchard
 * #439: same shape, the net's commit the only copy of the change).
 *
 * This asks the question the net was answering for the child, with primitives
 * the crash path already uses (no new git verb). commits > 0 -> own work, the
 * caller runs the net as today. 0 commits and clean -> unchanged, so the
 * existing GREEN_DOWNGRADE applies. 0 commits and dirty -> UNFINISHED: the net
 * does NOT run, one corrective pass goes into the SAME worktree (no reset, no
 * clean — the dirt IS the work) and one re-read follows. An unreadable read is
 * not-ok naming its cause: absence of evidence is not evidence of a finished
 * pass.
 */
import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { type ExecFn, commitEntriesOf, commitsAheadOfBase, runGit } from "./work-develop-git.ts";
import { treeReader } from "./work-develop-crash.ts";
import { namePaths, unfinishedPromptSuffix } from "./work-develop-paths.ts";
import { appendEvent, type WorkState } from "./workflow-state.ts";

/** Bound on the reason string the verdict and the cap evidence carry. */
const REASON_MAX = 400;

/** The corrective pass: same workstream, same worktree, the dispatch seam the
 *  first pass used. `undefined` = could not be dispatched (no captured brief),
 *  which the caller still parks on — it never reads as green. */
export type CorrectiveDispatch = (paths: string[]) => Promise<DispatchResult | undefined>;

export type OwnCommitOutcome =
  /** commits > 0: normal green path, safety net included (leftovers = recovery). */
  | { kind: "own-work" }
  /** 0 commits, clean tree: the caller's existing GREEN_DOWNGRADE applies. */
  | { kind: "unchanged" }
  /** The corrective pass committed: green path, no net — the leftover rule
   *  exists for a pass that already had commits of its own. */
  | { kind: "green" }
  /** No commit of its own, dirt left, and the corrective pass did not fix it. */
  | { kind: "unfinished"; uncommitted: string[]; reason: string };

/** The child's uncommitted paths, read through the crash classifier's bounded
 *  reader; `.pi/` and `tmp/` drop out via `commitEntriesOf`, so a driver file
 *  never makes a pass look dirty. Unreadable is `unreadable`, never []. */
type PathsRead = { paths: string[] } | { unreadable: string };

async function uncommittedPaths(execFn: ExecFn, cwd: string): Promise<PathsRead> {
  const parsed = await treeReader(execFn)(cwd);
  return Array.isArray(parsed)
    ? { paths: commitEntriesOf(parsed).map((e) => e.path) }
    : { unreadable: parsed.unreadable };
}

export async function requireOwnCommit(args: {
  id: string;
  cwd: string;
  base: string | undefined;
  execFn: ExecFn;
  /** The caller's dispatch for this workstream, its brief carrying the
   *  finish-and-commit paragraph for the paths it is given. */
  corrective?: CorrectiveDispatch;
}): Promise<OwnCommitOutcome> {
  const { id, cwd, base, execFn } = args;
  const git = runGit(execFn);
  const read = () => commitsAheadOfBase(git, cwd, base);

  const first = await read();
  if (!("commits" in first))
    return { kind: "unfinished", uncommitted: [], reason: `commits unreadable — ${first.unreadable}` };
  if (first.commits > 0) return { kind: "own-work" };

  const status = await uncommittedPaths(execFn, cwd);
  if (!("paths" in status))
    return { kind: "unfinished", uncommitted: [], reason: `status unreadable — ${status.unreadable}` };
  const paths = status.paths;
  if (paths.length === 0) return { kind: "unchanged" };

  trace(`work-driver: develop ${id} — no commit of its own, ${paths.length} uncommitted: ${namePaths(paths)}`);
  const unfinished = (extra?: string): OwnCommitOutcome => ({
    kind: "unfinished",
    uncommitted: paths,
    reason: `${paths.length} uncommitted path(s), no commit of its own: ${namePaths(paths)}${extra ? `; ${extra}` : ""}`.slice(0, REASON_MAX),
  });
  if (!args.corrective) return unfinished();

  const again = await args.corrective(paths);
  if (again === undefined) return unfinished("the corrective pass could not be dispatched");

  const second = await read();
  if (!("commits" in second))
    return unfinished(`corrective pass left the commit count unreadable — ${second.unreadable}`);
  if (second.commits > 0) {
    trace(`work-driver: develop ${id} — corrective pass committed (${second.commits})`);
    return { kind: "green" };
  }
  return unfinished("the corrective pass committed nothing either");
}

/** The cap this park emits — one name, so every registration and the test read
 *  it from here rather than each typing their own copy. */
export const DEVELOP_INCOMPLETE_UNCOMMITTED = "develop-incomplete-uncommitted";

/** Park the workstreams whose develop pass ended with uncommitted paths and no
 *  commit of its own, after the one corrective pass in its own worktree. Returns
 *  the parked state, or `undefined` when none needs parking and the caller
 *  proceeds to the converged emit and the gates as before. Not the crash park
 *  beside it: a crash is an infrastructure fault; this is unfinished WORK the
 *  child itself declared done, and the operator's action is to finish or split
 *  it. Not the safety net either: committing that dirt is what made the pass
 *  read as done. */
export function parkUnfinishedDevelop(
  state: WorkState,
  unfinished: ReadonlyMap<string, string[]>,
  issue: number,
): WorkState | undefined {
  if (unfinished.size === 0) return undefined;
  const named = [...unfinished.entries()].map(([id, p]) => `${id}: ${namePaths(p)}`).join(" | ");
  lifecycle.emitStepNotice(
    "develop",
    `a developer ended its pass with uncommitted work and no commit of its own (${named}); the pass is not counted as done`,
    issue,
  );
  trace(`work-driver: ${DEVELOP_INCOMPLETE_UNCOMMITTED} — ${named}`);
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: DEVELOP_INCOMPLETE_UNCOMMITTED,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: boundJoinFailures([named]),
  });
}

export { unfinishedPromptSuffix };
