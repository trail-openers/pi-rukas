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
 * written; orchard #439: the same shape at 80 minutes, the net's commit the only
 * copy of the change).
 *
 * This module asks the question the net was answering on the child's behalf:
 * did THIS pass commit anything? It reads with the primitives the crash path
 * already uses (`commitsAheadOfBase`, and the crash reader's own bounded status
 * read, which this module re-implements at the same bound and parse rather than
 * growing work-develop-crash.ts past its current size) and adds no new git verb.
 *
 *   - commits > 0            → own work; the caller runs the net exactly as today
 *   - 0 commits, clean tree  → unchanged, so the existing GREEN_DOWNGRADE applies
 *   - 0 commits, dirty tree  → UNFINISHED: the net does NOT run; one corrective
 *     pass is dispatched into the SAME worktree (no reset, no clean — the dirt
 *     is the work), then one re-read
 *   - either read unreadable → not-ok, naming the cause. Never read as clean or
 *     green: absence of evidence is not evidence of a finished pass.
 *
 * The park for the UNFINISHED outcome lives in work-develop-own-commit-park.ts.
 */
import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { type ExecFn, commitEntriesOf, commitsAheadOfBase, parseStatus, runGit } from "./work-develop-git.ts";
import { namePaths, unfinishedPromptSuffix } from "./work-develop-paths.ts";
import { appendEvent, type WorkState } from "./workflow-state.ts";

/** Bound on the reason string the verdict and the cap evidence carry. */
const REASON_MAX = 400;

/** The corrective pass: same workstream, same worktree, same dispatch seam the
 *  first pass used. `undefined` means it could not be dispatched (no captured
 *  brief), which the caller still parks on — it never reads as green. */
export type CorrectiveDispatch = (paths: string[]) => Promise<DispatchResult | undefined>;

export type OwnCommitOutcome =
  /** The pass has commits of its own, so the caller continues on the normal
   *  green path, safety net included (leftovers stay recovery, as today). */
  | { kind: "own-work" }
  /** Nothing to do: 0 commits and a clean tree. The caller's existing
   *  GREEN_DOWNGRADE path applies unchanged. */
  | { kind: "unchanged" }
  /** The corrective pass committed. The caller continues on the green path but
   *  does NOT run the net: the child has now committed its own work, and the
   *  net's leftover rule exists for a pass that already had commits. */
  | { kind: "green" }
  /** Unfinished: no commit of its own, dirt left, corrective pass did not fix it. */
  | { kind: "unfinished"; uncommitted: string[]; reason: string };

/** The same status read the crash classifier makes — same argv, same `-z`
 *  parse, same 30s bound — reduced to the commit-eligible paths. Driver
 *  artefacts (`.pi/`, `tmp/`) are dropped, so a driver file can never make a
 *  pass look dirty. An unreadable read is `unreadable`, never an empty list. */
async function uncommittedPaths(
  execFn: ExecFn,
  cwd: string,
): Promise<{ paths: string[] } | { unreadable: string }> {
  const BOUND_MS = 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = execFn("git", {
      cwd,
      argv: ["status", "--porcelain", "-z", "--untracked-files=all"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: BOUND_MS,
    });
    const settled = await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`git status timed out after ${BOUND_MS}ms`)), BOUND_MS);
      }),
    ]);
    const parsed = parseStatus(settled.stdout);
    if (!Array.isArray(parsed)) return { unreadable: parsed.unreadable };
    // The same drop rule the safety net uses: a .pi/ or tmp/ edit is the
    // driver's own file, never the child's unfinished work.
    return { paths: commitEntriesOf(parsed).map((e) => e.path) };
  } catch (err) {
    return { unreadable: String((err as Error)?.message ?? err).slice(0, 200) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    return { kind: "green" };
  }
  return unfinished("the corrective pass committed nothing either");
}

/** The cap this park emits — one name, so every registration and the test read
 *  it from here rather than each typing their own copy. */
export const DEVELOP_INCOMPLETE_UNCOMMITTED = "develop-incomplete-uncommitted";

/**
 * Park the workstreams whose develop pass ended with uncommitted paths and no
 * commit of its own, after the one corrective pass in its own worktree. Returns
 * the parked state, or `undefined` when no workstream needs parking (the caller
 * then proceeds to the converged emit and the gates as before).
 *
 * Deliberately NOT the crash park beside it: a crash is an infrastructure fault
 * the operator fixes by keeping the host awake, and its own cap already says
 * so. This is unfinished WORK — the child exited 0 and said so itself — and the
 * operator's action is to finish it or split it. And deliberately NOT the safety
 * net: committing the child's dirt is what made the unfinished pass read as done.
 */
export function parkUnfinishedDevelop(
  state: WorkState,
  unfinished: ReadonlyMap<string, string[]>,
  issue: number,
): WorkState | undefined {
  if (unfinished.size === 0) return undefined;
  const named = [...unfinished.entries()]
    .map(([id, paths]) => `${id}: ${namePaths(paths)}`)
    .join(" | ");
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
