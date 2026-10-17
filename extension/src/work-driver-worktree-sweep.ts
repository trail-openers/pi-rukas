import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { processAlive } from "./work-driver-resume.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const defaultExecFn: ExecFn = execp;

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
  // Every realpathSync/lstatSync below is GUARDED, because this function's
  // contract is a discriminated result, not a throw. It matters most for
  // `runWorktreeTeardown`, which feeds it paths straight out of
  // `pipelineState.worktrees` — a map written at `branch` and routinely stale by
  // handoff (crash, external `git worktree remove`, operator cleanup). An
  // unguarded realpathSync threw ENOENT there, escaping through `runHandoff`
  // and losing the teardown pass with the `retainedWorktrees` report. A path
  // that is not there is `unresolvable`, which the caller already handles.
  let validationPath: string;
  try {
    validationPath = realpathSync(candidate);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  let validationStats: ReturnType<typeof lstatSync>;
  try {
    validationStats = lstatSync(validationPath);
  } catch (err) {
    console.error(`resolveSweepTarget: lstatSync failed for ${candidate}: ${err}`);
    return { ok: false, reason: "unresolvable" };
  }

  let worktreesDir: string;
  let repoRootPath: string;
  let repoGitPath: string;
  try {
    worktreesDir = realpathSync(resolve(repoRoot, ".worktrees"));
    repoRootPath = realpathSync(repoRoot);
    repoGitPath = realpathSync(resolve(repoRoot, ".git"));
  } catch {
    return { ok: false, reason: "unresolvable" };
  }

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
    gitFileContent = readFileSync(gitFile, "utf8");
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
 * `claimCycle` keys on every issue in the group anyway.
 */
export function parseWorktreeIssue(name: string): number | undefined {
  const m = /^(?:issue|issues)-(\d+)-/.exec(name);
  if (!m) return undefined;
  const issue = Number(m[1]);
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
    case "remove":
      // From the repo root, the path a worktree was registered with — which is
      // what `git worktree remove` matches, and what `worktreeRemove` in
      // worktree.ts already uses for the same operation. Running it from
      // `.worktrees/` instead and handing it a relative path made this
      // dependent on the cwd the sweep happened to scan from.
      return await execFn(`git worktree remove --force ${JSON.stringify(action.target.realPath)}`, {
        cwd: resolve(action.target.realPath, "..", ".."),
        maxBuffer: 256 * 1024,
      });
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
    const entries = readdirSync(worktreesDir);
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

    // The launching cycle's own tree is not a leftover, whatever its state file
    // says. Checked BEFORE the state read so a cycle is never at the mercy of
    // its own (possibly mid-write, possibly corrupt) state file.
    if (isLaunchingCycleOwnWorktree(resolved.name, launchingCycleIssue)) {
      skipped.push({ path: resolved.realPath, reason: "launching-cycle-own" });
      continue;
    }

    // Read the state file this worktree's NAME points at: `issue-<N>-<id>` ->
    // `<N>.json`. A name that encodes no issue has no state file to consult,
    // and a sweep that cannot say what a tree's cycle decided keeps the tree.
    const worktreeIssue = parseWorktreeIssue(resolved.name);
    if (worktreeIssue === undefined) {
      skipped.push({ path: resolved.realPath, reason: "name-has-no-issue" });
      continue;
    }
    const stateFilePath = join(repoRoot, ".pi", "work-state", `${worktreeIssue}.json`);
    let state: WorkState | null = null;
    try {
      const stateContent = readFileSync(stateFilePath, "utf8");
      state = JSON.parse(stateContent) as WorkState;
    } catch {
      // Unreadable state file - skip
      skipped.push({ path: resolved.realPath, reason: "state-unreadable" });
      continue;
    }

    // The state file is keyed by issue, so a stale file for the same issue also
    // answers for a re-run's tree. Require it to name the issue the directory
    // name decodes, or the decision below runs on some other cycle's verdict.
    if (state.issue !== worktreeIssue) {
      skipped.push({
        path: resolved.realPath,
        reason: `state-issue-mismatch ${state.issue}!=${worktreeIssue}`,
      });
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
