import { exec } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import { processAlive } from "./work-driver-resume.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const defaultExecFn: ExecFn = promisify(exec) as unknown as ExecFn;

/**
 * Result of resolving a sweep target.
 */
export interface SweepTargetResult {
  ok: true;
  /** Absolute path to the worktree directory. */
  realPath: string;
  /** Basename of the worktree (e.g., "issue-477-default"). */
  name: string;
}

/**
 * Error result from resolving a sweep target.
 */
export interface SweepTargetError {
  ok: false;
  /** Reason for failure. */
  reason:
    | "unresolvable"
    | "candidate-is-repo-root"
    | "outside-worktrees"
    | "not-a-directory"
    | "not-our-worktree";
}

/**
 * Validate a candidate path is safe to operate on.
 */
export function resolveSweepTarget(
  repoRoot: string,
  candidate: string,
): SweepTargetResult | SweepTargetError {
  // Use realpathSync for validation to match how git worktree resolves symlinks
  const validationPath = realpathSync(candidate);
  let validationStats: ReturnType<typeof lstatSync>;
  try {
    validationStats = lstatSync(validationPath);
  } catch (err) {
    console.error(`resolveSweepTarget: lstatSync failed for ${candidate}: ${err}`);
    return { ok: false, reason: "unresolvable" };
  }

  // Use realpathSync for repo paths to match how git worktree resolves symlinks
  const worktreesDir = realpathSync(resolve(repoRoot, ".worktrees"));
  let worktreesStats: ReturnType<typeof lstatSync>;
  try {
    worktreesStats = lstatSync(worktreesDir);
  } catch (err) {
    console.error(`resolveSweepTarget: lstatSync failed for ${worktreesDir}: ${err}`);
    return { ok: false, reason: "unresolvable" };
  }

  const repoRootPath = realpathSync(repoRoot);
  const repoGitPath = realpathSync(resolve(repoRoot, ".git"));

  // For the returned realPath, use resolve() to match test expectations
  const resultPath = resolve(candidate);

  // Ensure candidate is under .worktrees
  if (!validationPath.startsWith(`${worktreesDir}/`)) {
    // Check if it's exactly the repo root
    if (validationPath === repoRootPath) {
      return { ok: false, reason: "candidate-is-repo-root" };
    }
    return { ok: false, reason: "outside-worktrees" };
  }

  // Ensure it's a directory
  if (!validationStats.isDirectory()) {
    return { ok: false, reason: "not-a-directory" };
  }

  // Check that it's a valid worktree for this repo
  const gitFile = join(validationPath, ".git");
  let gitFileContent: string;
  try {
    gitFileContent = require("node:fs").readFileSync(gitFile, "utf8");
  } catch {
    return { ok: false, reason: "not-our-worktree" };
  }
  const expected = `gitdir: ${repoGitPath}/worktrees/${basename(validationPath)}`;
  if (gitFileContent.trim() !== expected) {
    return { ok: false, reason: "not-our-worktree" };
  }

  const name = basename(validationPath);
  return { ok: true, realPath: resultPath, name };
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
  const status = state.pipelineState.currentStep;
  const branchName = state.pipelineState.branchName;
  if (!branchName) return false;
  // Status must be merged, handoff, or aborted
  if (!["merged", "handoff", "aborted"].includes(status)) return false;

  try {
    // Fetch the branch
    await execFn(`git fetch origin ${branchName}`, {
      cwd: worktreePath,
      maxBuffer: 256 * 1024,
      timeout: 10000, // 10s
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

/**
 * Top-level: scan .worktrees/, read state files, sweep other cycles' leftovers
 */
export async function runWorktreeSweep(opts: {
  repoRoot: string;
  launchingCycleIssue: number;
  liveCycles: Set<number>;
  execFn?: ExecFn;
  /** Set to false to disable the sweep (for testing/env var). */
  enabled?: boolean;
}): Promise<{
  ran: boolean;
  checked: number;
  purged: string[];
  removed: string[];
  skipped: { path: string; reason: string }[];
}> {
  if (opts.enabled === false) {
    return { ran: false, checked: 0, purged: [], removed: [], skipped: [] };
  }

  const { repoRoot, launchingCycleIssue, liveCycles, execFn = defaultExecFn } = opts;
  const worktreesDir = join(repoRoot, ".worktrees");
  let dirs: string[];
  try {
    const entries = require("node:fs").readdirSync(worktreesDir) as string[];
    dirs = entries.filter((entry) => {
      const full = join(worktreesDir, entry);
      return lstatSync(full).isDirectory();
    });
  } catch {
    // No .worktrees directory
    return { ran: true, checked: 0, purged: [], removed: [], skipped: [] };
  }

  const checked: string[] = [];
  const purged: string[] = [];
  const removed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const dirName of dirs) {
    const candidate = join(worktreesDir, dirName);
    const resolved = resolveSweepTarget(repoRoot, candidate);
    if (!resolved.ok) {
      skipped.push({ path: candidate, reason: resolved.reason });
      continue;
    }
    checked.push(resolved.realPath);

    // Read the state file for this worktree
    const stateFilePath = join(repoRoot, ".pi", "work-state", `${resolved.name}.json`);
    let state: WorkState | null = null;
    try {
      const stateContent = require("node:fs").readFileSync(stateFilePath, "utf8");
      state = JSON.parse(stateContent) as WorkState;
    } catch {
      // Unreadable state file - skip
      skipped.push({ path: resolved.realPath, reason: "state-unreadable" });
      continue;
    }

    // Exclude the launching cycle's own state file
    if (resolved.name === `${opts.launchingCycleIssue}-default`) {
      // Note: the spec says the launch sweep excludes the launching cycle's own state file by path.
      // We'll skip it here.
      skipped.push({ path: resolved.realPath, reason: "launching-cycle-own" });
      continue;
    }

    const decideOpts: DecideOpts = {
      state,
      target: resolved,
      selfPid: process.pid,
      liveCycles,
      launchingCycleIssue: opts.launchingCycleIssue,
      execFn,
    };

    const action = await decideSweepAction(decideOpts);
    let result: SweepResult;
    try {
      result = await executeSweepAction(action, execFn);
    } catch (err) {
      trace(`worktree-sweep: action execution failed for ${resolved.realPath}: ${err}`);
      skipped.push({ path: resolved.realPath, reason: "action-failed" });
      continue;
    }

    if (action.type === "purge") {
      purged.push(resolved.realPath);
    } else if (action.type === "remove") {
      removed.push(resolved.realPath);
    } else if (action.type === "skip") {
      skipped.push({ path: resolved.realPath, reason: action.reason });
    }
  }

  return {
    ran: true,
    checked: checked.length,
    purged,
    removed,
    skipped,
  };
}

/**
 * In-cycle: teardown this cycle's own worktrees at handoff
 */
export async function runWorktreeTeardown(opts: {
  repoRoot: string;
  state: WorkState;
  execFn?: ExecFn;
  /** Set to false to disable the teardown (for testing/env var). */
  enabled?: boolean;
}): Promise<string[]> {
  if (opts.enabled === false) {
    return [];
  }

  const { repoRoot, state, execFn = defaultExecFn } = opts;
  const worktrees = state.pipelineState.worktrees;
  if (!worktrees || Object.keys(worktrees).length === 0) {
    return [];
  }

  const retained: string[] = [];

  for (const [worktreeName, worktreePath] of Object.entries(worktrees)) {
    const resolved = resolveSweepTarget(repoRoot, worktreePath);
    if (!resolved.ok) {
      trace(`worktree-teardown: invalid worktree path ${worktreePath}: ${resolved.reason}`);
      continue;
    }

    // For in-cycle teardown, we consider the current cycle as the launching cycle
    const decideOpts: DecideOpts = {
      state,
      target: resolved,
      selfPid: process.pid,
      liveCycles: new Set([state.issue]), // Only this cycle is live for teardown purposes
      launchingCycleIssue: state.issue, // Exclude self from live check
      execFn,
    };

    const action = await decideSweepAction(decideOpts);
    let result: SweepResult;
    try {
      result = await executeSweepAction(action, execFn);
    } catch (err) {
      trace(`worktree-teardown: action execution failed for ${resolved.realPath}: ${err}`);
      // On error, assume we retain the worktree (safer than removing it)
      retained.push(resolved.realPath);
      continue;
    }

    if (action.type === "purge") {
      // We still retain the worktree, but we've purged artifacts
      retained.push(resolved.realPath);
    } else if (action.type === "remove") {
      // Worktree removed, not retained
    } else if (action.type === "skip") {
      // Worktree skipped, retained
      retained.push(resolved.realPath);
    }
  }

  return retained;
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
