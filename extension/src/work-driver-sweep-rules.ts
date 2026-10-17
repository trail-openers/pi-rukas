/**
 * work-driver-sweep-rules — the worktree sweep's READ-ONLY decision surface.
 *
 * Split out of `work-driver-worktree-sweep.ts` for the §12 500-line cap, at the
 * seam that already matters: the sweep is a pure set of rules over a worktree's
 * name and its state file, and then an IO half that turns a rule's verdict into
 * a `git` command. Everything here inspects and never executes, so the two live
 * tree-loss guards #1265 round 1 added — the group claim and the symlink check —
 * sit on the side a test can drive without a filesystem under it. The executor
 * half re-exports every name so existing importers keep their path.
 */

import { type Stats, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { trace } from "./trace.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { processAlive } from "./work-driver-resume.ts";
import type { SweepTargetResult } from "./work-driver-worktree-sweep.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The issue a worktree directory name encodes, or undefined when it does not
 * name a driver worktree at all.
 *
 * #1265 — this lookup was the whole bug. The sweep used to read
 * `.pi/work-state/<basename>.json`, but a basename is `issue-<N>-<id>`
 * (`work-driver-branch-mechanized.ts`; `issues-<N>-<M>-<id>` for a grouped
 * cycle, `issue-<N>-integrate` for the driver-owned tree) while a state file is
 * `<N>.json` (`workflow-state.ts` `workStateFile`). No worktree has ever been
 * named like a state file, so EVERY candidate fell through to
 * `state-unreadable` and the decision engine below Rules 1–2 never ran: a
 * killed cycle's leftovers accumulated forever, holding branches that the next
 * cycle then tripped over. The one test only exercised `enabled: false`, so the
 * sweep was dark in production and dark in the suite at the same time.
 *
 * The FIRST number is the primary issue — the key of the state file, which
 * `claimCycle` keys on every issue in the group anyway. A grouped cycle, though,
 * names a tree by its PRIMARY (`issues-<N>-<M>-<id>`), so a pure name comparison
 * protects only one workstream of a live group; `groupClaimedByState` covers the
 * rest. Leading zeros are rejected rather than folded: the driver formats
 * `issue-${n}-…` from a parsed decimal, so `issue-007-default` is a hand-made
 * tree, and a hand-made tree gets a skip, never a guess.
 */
export function parseWorktreeIssue(name: string): number | undefined {
  const m = /^(?:issue|issues)-(\d+)-/.exec(name);
  if (!m) return undefined;
  const digits = m[1];
  if (!digits || digits.length > 15 || (digits.length > 1 && digits.startsWith("0"))) {
    return undefined;
  }
  const issue = Number(digits);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : undefined;
}

/**
 * Whether a worktree directory belongs to the cycle that launched this sweep.
 *
 * #1265 — the guard compared the basename against `${issue}-default`, a string
 * no directory is ever named (the prefix is missing, so it never matched and
 * the launching cycle's own tree was swept like anyone else's). A tree the
 * launching cycle is about to reuse is not a leftover; removing or purging it
 * out from under the cycle that just claimed the issue destroys in-progress
 * work. The rule is therefore the basename's issue, not a name pattern: the
 * same issue the state file is keyed on.
 */
export function isLaunchingCycleOwnWorktree(name: string, launchingCycleIssue: number): boolean {
  return parseWorktreeIssue(name) === launchingCycleIssue;
}

/** The subset of a state file the group-claim rule reads. */
export type StateClaim = Pick<WorkState, "issue" | "issues"> & {
  pipelineState: { status: string };
};

/**
 * Whether a RUNNING state file claims a worktree's issue — primary **or**
 * secondary — and therefore whether the tree belongs to a cycle that has not
 * reached a terminal status.
 *
 * #1265 round 1 — two loss paths the owner/liveCycles guards do not cover, both
 * reachable the moment the sweep stops being dark:
 *
 *  - A grouped cycle launched as #10 writes one state file, `10.json`, carrying
 *    `issues: [10, 11]`, and names EVERY workstream tree by the primary —
 *    `issues-10-11-task-b`. A pure-name self-guard cannot see 11, and the state
 *    file's own `issue` is 10, so `liveCycles.has(state.issue)` never fires for
 *    the sibling either. Before this rule the running group's second workstream
 *    was purged.
 *  - `owner` is OPTIONAL (`workflow-state-schema-workstate.ts`) and is written
 *    only by `markDispatchStarted`. A file persisted at a step boundary before
 *    the first dispatch has none, so Rule 3a has nothing to test. `liveCycles`
 *    is an in-process set that a sibling Pi process is structurally not in.
 *
 * Gated on `status === "running"`: a terminal file's `issues` is a historical
 * record, not a claim, so this never blocks the reclamation #1265 is for.
 * Measured on the 32 state files on this host, 29 carry `status: handoff` or
 * `merged`; 2 are `running`. So this guard skips the two live trees and the
 * sweep still removes the dead ones.
 */
export function groupClaimedByState(state: StateClaim, worktreeIssue: number): boolean {
  return (
    state.pipelineState.status === "running" &&
    (state.issue === worktreeIssue || (state.issues?.includes(worktreeIssue) ?? false))
  );
}

/** The dependency locations `worktree-provision.ts` links into every worktree. */
const PROVISIONED_DEP_NAMES = ["node_modules", ".venv", "vendor"];

/**
 * Whether a worktree holds a provisioned dependency tree worth keeping —
 * `node_modules` / `.venv` / `vendor` present as a REAL directory rather than a
 * symlink. `worktree-provision.ts` *links* these into every worktree, and the
 * driver's own `.pi/worktree-setup` hook may `bun install` / `uv sync` one in.
 *
 * #1265 round 1 — `git clean -fdX` removes exactly the *ignored* files, which is
 * precisely those provisioned trees. When they are symlinks (or absent) the
 * removal is free: it drops a link or nothing, and the next provision re-makes
 * it. When one is a real per-checkout install it destroys a dependency tree,
 * which on a Rust/Node repo is the 30-60 minute rebuild the reviewer measured.
 * So the expensive shape — a real dependency directory — is the ONLY one that
 * suppresses the artifact purge; a tree with no provisioned deps still cleans
 * normally, and a symlink still does. A tree that cannot be read is treated as
 * worth keeping, because the safe default is not to clean.
 */
export function hasRealDependencyTree(worktreePath: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(worktreePath);
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!PROVISIONED_DEP_NAMES.includes(entry)) continue;
    let stat: Stats;
    try {
      stat = lstatSync(join(worktreePath, entry));
    } catch {
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Options for deciding sweep action.
 */
export interface DecideOpts {
  /** The worktree state from the state file. */
  state: WorkState;
  /** The resolved sweep target (from resolveSweepTarget). */
  target: SweepTargetResult;
  /** The current process PID (for self-exemption). */
  selfPid: number;
  /** Set of live issue numbers from the registry. */
  liveCycles: Set<number>;
  /** The launching cycle's own issue number (to exclude from live check). */
  launchingCycleIssue: number;
  /** Executor for running git commands. */
  execFn: ExecFn;
  /** Ceiling on the per-tree network `git fetch` the remote proof issues. */
  netProofBudget?: { remaining: number };
  /** Whether the sweep may run a network command at all (launch sweep sets this). */
  allowNetworkProof?: boolean;
}

/**
 * Action to take on a worktree.
 */
export type SweepAction =
  | { type: "skip"; reason: string }
  | { type: "purge"; target: SweepTargetResult }
  | { type: "remove"; target: SweepTargetResult };

/**
 * Result of executing a sweep action.
 */
export interface SweepResult {
  stdout: string;
  stderr?: string;
}

/**
 * Decide what to do with a validated worktree. The 6-rule engine.
 *
 * Lives here with the rules it reads; the executor that turns the verdict into
 * a `git` command is `executeSweepAction` in the sweep module. `isWorkProvably
 * OnRemote` is kept here because Rule 5's shape (fetch, then compare) is part
 * of the decision, and it only ever reaches the network through the injected
 * `execFn` — the rules module never runs a command itself.
 */
export async function decideSweepAction(opts: DecideOpts): Promise<SweepAction> {
  const {
    state,
    target,
    selfPid,
    liveCycles,
    launchingCycleIssue,
    execFn,
    netProofBudget,
    allowNetworkProof,
  } = opts;

  // Rule 1: Already handled by resolveSweepTarget (returns error if invalid)
  // Rule 2: Directory absence - handled by resolveSweepTarget (not-a-directory)

  // Rule 3: Live owner check
  const issueNumber = state.issue;
  // The group claim, read from the state file rather than the name alone, so a
  // running group's non-primary workstream is not swept. See the helper.
  if (groupClaimedByState(state, parseWorktreeIssue(target.name) ?? -1)) {
    return { type: "skip", reason: `group-claimed ${target.name}` };
  }
  const ownerPid = state.owner?.pid;
  if (ownerPid !== undefined && ownerPid !== selfPid && processAlive(ownerPid)) {
    return { type: "skip", reason: `live-owner pid=${ownerPid}` };
  }
  // Second part of live check: issue in liveCycles and not launching cycle's own
  const isIssueInLiveCycles = liveCycles.has(issueNumber);
  if (isIssueInLiveCycles && launchingCycleIssue !== issueNumber) {
    return { type: "skip", reason: `live-issue ${issueNumber}` };
  }

  // Rule 4: State is awaiting-human-merge → artifact purge only
  if (isAwaitingHumanMerge(state)) {
    return { type: "purge", target };
  }

  // Rule 5: Work provably on remote → full removal. The proof is one network
  // `git fetch` per candidate, so it is tried only within the caller's budget
  // (a launch sweep bound to a few seconds); once the budget is spent the tree
  // falls through to the local-only purge rather than holding the cycle's
  // startup for another fetch.
  if (netProofBudget && netProofBudget.remaining > 0 && allowNetworkProof !== false) {
    netProofBudget.remaining -= 1;
    if (await isWorkProvablyOnRemote(state, target.realPath, execFn)) {
      return { type: "remove", target };
    }
  }

  // Rule 6: Fallback → artifact purge only
  return { type: "purge", target };
}

/**
 * Check if the state indicates an awaiting-human-merge park.
 */
function isAwaitingHumanMerge(state: WorkState): boolean {
  // Find the last cap-hit event (highest array index)
  const capHits = state.eventLog.filter(
    (e): e is Extract<WorkEvent, { kind: "cap-hit"; cap: string }> => e.kind === "cap-hit",
  );
  if (capHits.length === 0) return false;
  // Take the last one (highest index)
  const lastCapHit = capHits[capHits.length - 1];
  if (!lastCapHit || lastCapHit.cap !== "awaiting-human-merge") return false;
  // Check if mergeHold is present in pipelineState
  return !!state.pipelineState.mergeHold;
}

/**
 * Check if work is provably on the remote: HEAD matches the fetched branch tip
 * and the tree is clean. Refuses before touching the network when the branch
 * name is not git-safe or the step is not a terminal one.
 */
async function isWorkProvablyOnRemote(
  state: WorkState,
  worktreePath: string,
  execFn: ExecFn,
): Promise<boolean> {
  const status = state.pipelineState.currentStep;
  const branchName = state.pipelineState.branchName;
  if (!branchName) return false;
  // Status must be merged, handoff, or aborted
  if (!["merged", "handoff", "aborted"].includes(status)) return false;

  // A branch name that is not git-safe is never fetched: not swept (keep it).
  if (netRefProblem(branchName) !== undefined) return false;
  try {
    // Fetch the branch
    await runNetGit(execFn, "git", {
      cwd: worktreePath,
      maxBuffer: 256 * 1024,
      timeoutMs: 10_000,
      argv: ["fetch", "origin", branchName],
    });
    // Check if HEAD matches FETCH_HEAD
    const { stdout: diffOut } = await execFn("git diff --quiet --submodule=diff FETCH_HEAD", {
      cwd: worktreePath,
      maxBuffer: 256 * 1024,
    });
    // Check if working tree is clean
    const { stdout: statusOut } = await execFn("git status --porcelain", {
      cwd: worktreePath,
      maxBuffer: 256 * 1024,
    });
    return diffOut === "" && statusOut === "";
  } catch (err) {
    trace(`worktree-sweep: remote check failed for ${worktreePath}: ${err}`);
    return false;
  }
}
