/**
 * work-driver-sweep-policy — the dead-worktree decision ladder and its
 * executor. Split out of `work-driver-worktree-sweep.ts` for the 500-line
 * gate (AGENTS.md §12); that module keeps the path gate (`resolveSweepTarget`),
 * the owner lookup and the two loops that call this.
 *
 * The seam is the one the code already had: everything below takes an
 * already-validated `SweepTargetResult` and decides/executes, and nothing here
 * touches the filesystem to decide *whether a path may be swept at all* — that
 * question stays in front of every caller.
 */

import { resolve } from "node:path";
import { trace } from "./trace.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { processAlive } from "./work-driver-resume.ts";
import type { SweepTargetResult } from "./work-driver-worktree-sweep.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";
import type { WorkEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The steps whose work could plausibly be on the remote. `aborted` is NOT a
 * The steps whose work could plausibly be on the remote. `aborted` is NOT a
 * WorkStep — it is a `status`, never a `currentStep` — so the old
 * `["merged","handoff","aborted"].includes(currentStep)` only type-checked
 * because the array inferred as `string[]`. An aborted cycle therefore takes
 * the safe branch here (PURGE, tree kept) unless it had actually reached the
 * merge step before aborting, in which case its work is on the remote and
 * REMOVE is correct. That distinction is what the ladder's remote check exists
 * to make; see `isWorkProvablyOnRemote`.
 */
const REMOTE_PROVABLE_STEPS: readonly WorkStep[] = ["merged", "handoff"];

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
 * Decide what to do with a validated worktree.
 * Implements the 6-rule decision engine.
 */
export async function decideSweepAction(opts: DecideOpts): Promise<SweepAction> {
  const { state, target, selfPid, liveCycles, launchingCycleIssue, execFn } = opts;

  // Rule 1: Already handled by resolveSweepTarget (returns error if invalid)
  // Rule 2: Directory absence - handled by resolveSweepTarget (not-a-directory)

  // Rule 3: Live owner check
  const issueNumber = state.issue;
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

  // Rule 5: Work provably on remote → full removal
  if (await isWorkProvablyOnRemote(state, target.realPath, execFn)) {
    return { type: "remove", target };
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
 * Check if work is provably on the remote.
 */
async function isWorkProvablyOnRemote(
  state: WorkState,
  worktreePath: string,
  execFn: ExecFn,
): Promise<boolean> {
  // DELIBERATELY `currentStep`, NOT the shared `isTerminalState`/
  // `TERMINAL_STATUSES`. That predicate means "finished"; this means "the work
  // is on the remote AND the tree is clean" — only plausible once the driver
  // reached the step that pushes. `status` flips to handoff while unpushed work
  // is still in the tree, so using the status list would turn PURGE (tree kept
  // inspectable) into REMOVE for a cycle whose commits never landed. The two
  // lists share three words but mean different things, so this stays.
  const currentStep = state.pipelineState.currentStep;
  const branchName = state.pipelineState.branchName;
  if (!branchName) return false;
  if (!REMOTE_PROVABLE_STEPS.includes(currentStep)) return false;

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

/**
 * Execute the decided action.
 */
export async function executeSweepAction(
  action: SweepAction,
  execFn: ExecFn,
): Promise<SweepResult> {
  switch (action.type) {
    case "skip":
      return { stdout: "" };
    case "purge":
      return await execFn("git clean -fdX", {
        cwd: action.target.realPath,
        maxBuffer: 256 * 1024,
      });
    case "remove": {
      // We need to run the command from the parent directory of the worktree
      const worktreeDir = action.target.realPath;
      const parentDir = resolve(worktreeDir, "..");
      const relativePath = relative(parentDir, worktreeDir);
      return await execFn(`git worktree remove --force ${JSON.stringify(relativePath)}`, {
        cwd: parentDir,
        maxBuffer: 256 * 1024,
      });
    }
    default:
      return { stdout: "" };
  }
}

// Helper function to compute relative path
function relative(from: string, to: string): string {
  const fromParts = from.split(/[\\/]/);
  const toParts = to.split(/[\\/]/);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }
  const upSteps = fromParts.length - i;
  const downParts = toParts.slice(i);
  const parts = Array(upSteps).fill("..").concat(downParts);
  return parts.length === 0 ? "." : parts.join("/");
}
