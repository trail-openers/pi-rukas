import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import {
  type DecideOpts,
  type SweepAction,
  type SweepResult,
  type SweepTargetError,
  type SweepTargetResult,
  decideSweepAction,
  groupClaimedByState,
  hasRealDependencyTree,
  isLaunchingCycleOwnWorktree,
  parseWorktreeIssue,
} from "./work-driver-sweep-rules.ts";
import { WORK_STATE_SCHEMA_VERSION } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

// The read-only decision surface lives in `work-driver-sweep-rules.ts` (§12
// cap, split at the read-vs-execute seam). Re-exported so every existing
// importer of this module — and the sweep tests — keep one import path. The
// target types are declared THERE, not here, so the rules module never imports
// its own consumer; the re-export is what keeps that move invisible to callers.
export {
  decideSweepAction,
  groupClaimedByState,
  hasRealDependencyTree,
  isLaunchingCycleOwnWorktree,
  parseWorktreeIssue,
} from "./work-driver-sweep-rules.ts";
export { PACKAGE_DIR_MARKERS, PROVISIONED_DEP_NAMES } from "./work-driver-sweep-rules.ts";
export type {
  DecideOpts,
  StateClaim,
  SweepAction,
  SweepResult,
  SweepTargetError,
  SweepTargetResult,
} from "./work-driver-sweep-rules.ts";

const defaultExecFn: ExecFn = execp;

/**
 * Parse one sweep-readable state file, rejecting a wrong schema LOUDLY rather
 * than reading it as this build's `WorkState`.
 *
 * The sweep used to `JSON.parse(…) as WorkState`, which is an assertion, not a
 * check: a v2 file (or a v0 left by an older driver) would be handed to the
 * rules engine wearing this build's types, and Rules 4–6 would decide a tree's
 * fate from fields that mean something else. Same version rule `workflow-state.ts`
 * `readState` applies — kept as the small sync sibling because the sweep reads
 * many files in a loop and must not await, and because every failure here is
 * the SAME answer the sweep already gives for a missing or corrupt file: skip
 * the tree, keep it, move on.
 */
function readSweepState(raw: string, file: string): WorkState {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`worktree-sweep: ${file} is not an object`);
  }
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (version !== WORK_STATE_SCHEMA_VERSION) {
    throw new Error(
      `worktree-sweep: ${file} has schemaVersion=${String(version)}, expected ${WORK_STATE_SCHEMA_VERSION}`,
    );
  }
  return parsed as WorkState;
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
 * Execute the decided action.
 *
 * The purge arm reports whether it ACTUALLY cleaned: a tree holding a real
 * dependency directory is left alone, and that outcome is returned as
 * `purgeSkipped` rather than being folded into "purged" — a caller that puts a
 * suppressed tree in its `purged` list is telling the operator it cleaned
 * something it did not touch.
 */
export async function executeSweepAction(
  action: SweepAction,
  execFn: ExecFn,
): Promise<SweepResult> {
  switch (action.type) {
    case "skip":
      return { stdout: "" };
    case "purge":
      // `-X` removes only *ignored* files — which is exactly the dependency
      // tree `worktree-provision.ts` links or installs into every worktree. The
      // removal is free for symlinks/absent and expensive for a real install,
      // so only a real dependency directory suppresses it. See the rule.
      if (!hasRealDependencyTree(action.target.realPath)) {
        return await execFn("git clean -fdX", {
          cwd: action.target.realPath,
          maxBuffer: 256 * 1024,
        });
      }
      return {
        stdout: "",
        stderr: "purge skipped: real dependency tree present",
        purgeSkipped: true,
      };
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
  /**
   * Ceiling on the per-tree network `git fetch` the Rule 5 remote proof issues,
   * for the whole sweep. Each tree that reaches Rule 5 spends one, so the launch
   * path stays bounded even on a host with dozens of leftovers. Defaults to a
   * small number; 0 keeps the local-only purge and skips the fetch storm.
   */
  netProofLimit?: number;
  /** Set to false to keep the whole sweep local (no Rule 5 fetch at all). */
  allowNetworkProof?: boolean;
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
  // The bound on the Rule 5 network proof: one `git fetch` per candidate is
  // unbounded by tree count otherwise, and the launch sweep is awaited on every
  // cycle's startup path. Default small (5); 0 disables the fetch entirely.
  const netProofBudget = {
    remaining: Math.max(0, opts.netProofLimit ?? 5),
  };
  const allowNetworkProof = opts.allowNetworkProof !== false;
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
    // its own (possibly mid-write, possibly corrupt) state file. A pure-name
    // check, so it fires even when the file cannot be parsed.
    if (isLaunchingCycleOwnWorktree(resolved.name, launchingCycleIssue)) {
      skipped.push({ path: resolved.realPath, reason: "launching-cycle-own" });
      continue;
    }

    const worktreeIssue = parseWorktreeIssue(resolved.name);
    if (worktreeIssue === undefined) {
      skipped.push({ path: resolved.realPath, reason: "name-has-no-issue" });
      continue;
    }

    // Read the state file this worktree's NAME points at: `issue-<N>-<id>` ->
    // `<N>.json`. A name that encodes no issue has no state file to consult,
    // and a sweep that cannot say what a tree's cycle decided keeps the tree.
    const stateFilePath = join(repoRoot, ".pi", "work-state", `${worktreeIssue}.json`);
    let state: WorkState | null = null;
    try {
      const stateContent = readFileSync(stateFilePath, "utf8");
      state = readSweepState(stateContent, stateFilePath);
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
      netProofBudget,
      allowNetworkProof,
    };

    const action = await decideSweepAction(decideOpts);
    let outcome: SweepResult;
    try {
      outcome = await executeSweepAction(action, execFn);
    } catch (err) {
      trace(`worktree-sweep: action execution failed for ${resolved.realPath}: ${err}`);
      skipped.push({ path: resolved.realPath, reason: "action-failed" });
      continue;
    }

    if (action.type === "purge") {
      // A purge the executor suppressed is NOT a purge: it goes to `skipped`
      // with the reason, never to `purged`. The list is what the operator reads
      // as "these trees were cleaned", so it says so only when `git clean` ran.
      if (outcome.purgeSkipped === true) {
        trace(`worktree-sweep: purge skipped for ${resolved.realPath}: real dependency tree`);
        skipped.push({ path: resolved.realPath, reason: "purge-skipped:real-deps" });
      } else {
        purged.push(resolved.realPath);
      }
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
      // Teardown runs on the handoff path, not the launch path, so it may prove
      // the work on the remote; one fetch per recorded worktree, bounded here too
      // so a stale worktrees map cannot fan out.
      netProofBudget: { remaining: Object.keys(worktrees).length },
      allowNetworkProof: true,
    };

    const action = await decideSweepAction(decideOpts);
    let outcome: SweepResult;
    try {
      outcome = await executeSweepAction(action, execFn);
    } catch (err) {
      trace(`worktree-teardown: action execution failed for ${resolved.realPath}: ${err}`);
      // On error, assume we retain the worktree (safer than removing it)
      retained.push(resolved.realPath);
      continue;
    }

    if (action.type === "purge") {
      // We still retain the worktree, but a purge that actually ran is a
      // different fact from one the dependency guard suppressed — both retain
      // the tree, only one cleaned it, and the trace is where an operator looks.
      if (outcome.purgeSkipped === true) {
        trace(`worktree-teardown: purge skipped for ${resolved.realPath}: real dependency tree`);
      }
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
