/**
 * work-develop-own-commit — #1768: a develop pass counts as done only when the
 * child COMMITTED its own work. Both green paths (work-develop-topological.ts,
 * work-develop-dependent.ts) ran the #622 safety net BEFORE `greenCountsAsWork`,
 * so a child that exited 0 with a dirty tree and no commit had its dirt
 * committed by the net, and that DRIVER commit satisfied commits > 0: unfinished
 * work read as `agent done: developer` and reached verify missing its
 * deliverables (orchard #507, #439). This asks the question the net was answering
 * for the child, using primitives the crash path already has (no new git verb):
 * commits > 0 -> own work, net as today; 0 + clean -> unchanged, so the existing
 * GREEN_DOWNGRADE applies; 0 + dirty -> UNFINISHED, no net, one corrective pass
 * in the SAME worktree (the dirt IS the work) then one re-read. An unreadable
 * read is not-ok naming its cause: absence of evidence is not evidence of a
 * finished pass.
 */
import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { treeReader } from "./work-develop-crash.ts";
import { type ExecFn, commitEntriesOf, commitsAheadOfBase, runGit } from "./work-develop-git.ts";
import { namePaths, unfinishedPromptSuffix } from "./work-develop-paths.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Bound on the reason string the verdict and the cap evidence carry. */
const REASON_MAX = 400;

/** The corrective pass: same workstream, same worktree, the seam the first pass
 *  used. `undefined` = no captured brief, so nobody was dispatched; the caller
 *  still parks on it, never reads it as green. */
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

type PathsRead = { paths: string[] } | { unreadable: string };

/** The child's uncommitted paths via the crash classifier's bounded reader;
 *  `commitEntriesOf` drops `.pi/` and `tmp/`, so a driver file never makes a
 *  pass look dirty, and an unreadable read stays `unreadable`, never []. */
async function uncommittedPaths(execFn: ExecFn, cwd: string): Promise<PathsRead> {
  const parsed = await treeReader(execFn)(cwd);
  return Array.isArray(parsed)
    ? { paths: commitEntriesOf(parsed).map((e) => e.path) }
    : { unreadable: parsed.unreadable };
}

const fail = (uncommitted: string[], reason: string): OwnCommitOutcome => ({
  kind: "unfinished",
  uncommitted,
  reason: reason.slice(0, REASON_MAX),
});

export async function requireOwnCommit(args: {
  id: string;
  cwd: string;
  base: string | undefined;
  execFn: ExecFn;
  /** Its brief carries the finish-and-commit paragraph for the paths given. */
  corrective?: CorrectiveDispatch;
}): Promise<OwnCommitOutcome> {
  const { id, cwd, base, execFn } = args;
  const git = runGit(execFn);
  const read = () => commitsAheadOfBase(git, cwd, base);

  const first = await read();
  if (!("commits" in first)) return fail([], `commits unreadable — ${first.unreadable}`);
  if (first.commits > 0) return { kind: "own-work" };

  const status = await uncommittedPaths(execFn, cwd);
  if (!("paths" in status)) return fail([], `status unreadable — ${status.unreadable}`);
  const paths = status.paths;
  if (paths.length === 0) return { kind: "unchanged" };

  const named = `${paths.length} uncommitted path(s), no commit of its own: ${namePaths(paths)}`;
  trace(`work-driver: develop ${id} — ${named}`);
  if (!args.corrective) return fail(paths, named);

  if ((await args.corrective(paths)) === undefined)
    return fail(paths, `${named}; the corrective pass could not be dispatched`);
  const second = await read();
  if (!("commits" in second))
    return fail(paths, `${named}; corrective pass left the commit count unreadable`);
  if (second.commits > 0) {
    trace(`work-driver: develop ${id} — corrective pass committed (${second.commits})`);
    return { kind: "green" };
  }
  return fail(paths, `${named}; the corrective pass committed nothing either`);
}

/** The cap this park emits — one name for every registration and the test. */
export const DEVELOP_INCOMPLETE_UNCOMMITTED = "develop-incomplete-uncommitted";

/** Park the workstreams whose develop pass ended with uncommitted paths and no
 *  commit of its own, after the one corrective pass in its own worktree;
 *  `undefined` when none needs parking, and the caller proceeds to the converged
 *  emit and the gates as before. Not the crash park beside it: a crash is an
 *  infrastructure fault, this is unfinished WORK the child called done, so the
 *  operator finishes it or splits the issue.
 */
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
