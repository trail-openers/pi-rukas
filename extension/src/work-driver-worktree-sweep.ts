import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import {
  type DecideOpts,
  type SweepResult,
  decideSweepAction,
  executeSweepAction,
} from "./work-driver-sweep-policy.ts";
import {
  type OwnerIndex,
  buildOwnerIndex,
  claimUnderWorktrees,
} from "./work-driver-worktree-sweep-owners.ts";
import { isLaunchingCycleOwnWorktree } from "./work-driver-sweep-rules.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

export type { DecideOpts, SweepAction, SweepResult } from "./work-driver-sweep-policy.ts";
export { decideSweepAction, executeSweepAction } from "./work-driver-sweep-policy.ts";
export {
  groupClaimedByState,
  hasRealDependencyTree,
  isLaunchingCycleOwnWorktree,
  parseWorktreeIssue,
} from "./work-driver-sweep-rules.ts";
export { PACKAGE_DIR_MARKERS, PROVISIONED_DEP_NAMES } from "./work-driver-sweep-rules.ts";

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
 *
 * r2 — two things the previous version trusted too far:
 *   - it printed its own failures to `console.error`, which in `-p` mode is the
 *     NDJSON channel's neighbour and in the TUI is a panel the operator is not
 *     reading for this; every diagnostic here is `trace` now.
 *   - it accepted a `.git` file whose text merely EQUALLED
 *     `<repoGitPath>/worktrees/<basename>`. That string is free for anyone who
 *     can write under `.worktrees/`. The identity is now proved in BOTH
 *     directions: the `.git` pointer names our admin dir, the admin directory
 *     EXISTS, and its own `gitdir` file points back at the candidate. A
 *     one-sided pointer is not a worktree of this repo.
 */
export function resolveSweepTarget(
  repoRoot: string,
  candidate: string,
): SweepTargetResult | SweepTargetError {
  // realpathSync matches how git worktree resolves symlinks. Guarded: the
  // owner index may name a since-removed tree — a nonexistent path is an
  // unresolvable target, not a crash (same shape as the lstat below).
  let validationPath: string;
  try {
    validationPath = realpathSync(candidate);
  } catch (err) {
    trace(`resolveSweepTarget: realpathSync failed for ${candidate}: ${err}`);
    return { ok: false, reason: "unresolvable" };
  }
  let validationStats: ReturnType<typeof lstatSync>;
  try {
    validationStats = lstatSync(validationPath);
  } catch (err) {
    trace(`resolveSweepTarget: lstatSync failed for ${candidate}: ${err}`);
    return { ok: false, reason: "unresolvable" };
  }

  let worktreesDir: string;
  let repoRootPath: string;
  let repoGitPath: string;
  try {
    worktreesDir = realpathSync(resolve(repoRoot, ".worktrees"));
    repoRootPath = realpathSync(repoRoot);
    repoGitPath = realpathSync(resolve(repoRoot, ".git"));
  } catch (err) {
    trace(`resolveSweepTarget: could not resolve repository paths: ${err}`);
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
  const adminDir = join(repoGitPath, "worktrees", basename(validationPath));
  const expected = `gitdir: ${adminDir}`;
  if (gitFileContent.trim() !== expected) {
    return { ok: false, reason: "not-our-worktree" };
  }
  // r2 — the reverse half of the identity. The forward pointer alone is a
  // string; git's own admin directory is the record. Both must agree.
  if (!isOurWorktreeAdminDir(adminDir, validationPath)) {
    return { ok: false, reason: "not-our-worktree" };
  }

  const name = basename(validationPath);
  return { ok: true, realPath: resultPath, name };
}

/**
 * True when `<repoGitPath>/worktrees/<name>` exists AND its `gitdir` file
 * points back at `worktreePath/.git`.
 *
 * git writes the pair when it creates a worktree, so a directory merely
 * carrying a plausible `.git` file — hand-made, or left by some other tool —
 * fails here while a real linked worktree of this repo passes. Absent admin dir
 * or an unmatched back-pointer are the same refusal: it is not ours to sweep.
 */
function isOurWorktreeAdminDir(adminDir: string, worktreePath: string): boolean {
  try {
    if (!lstatSync(adminDir).isDirectory()) return false;
    const backPointer = readFileSync(join(adminDir, "gitdir"), "utf8").trim();
    return backPointer === join(worktreePath, ".git");
  } catch (err) {
    trace(`resolveSweepTarget: no matching gitdir back-pointer for ${adminDir}: ${err}`);
    return false;
  }
}

/**
 * #1454 — find the state file of the cycle a worktree belongs to, through
 * `pipelineState.worktrees` (the id→path map the branch step records). The old
 * code guessed `.pi/work-state/<basename>.json`, which never matches a
 * multi-workstream tree. An unclaimed tree, or the launching cycle's own tree,
 * returns null — the sweep never touches the cycle running it. The index is
 * built once per sweep by the caller and passed in; see `buildOwnerIndex`.
 */
export function findOwningCycleState(
  repoRoot: string,
  worktreePath: string,
  launchingCycleIssue: number,
  // r2 — required. Optional-with-a-default meant a caller that forgot to pass
  // the index re-read and re-parsed `.pi/work-state/` once per worktree, which
  // is exactly the cost the index was introduced to remove, and did it
  // invisibly. Every caller builds the index once per sweep.
  index: OwnerIndex,
): { state: WorkState | null; ownerIssue?: number } {
  // Cheap, I/O-free containment backstop: a state file is operator-editable and
  // cannot name a path outside .worktrees/ for the sweep to `git clean`. The
  // full git-worktree gate stays in resolveSweepTarget, where purge/remove fires
  // (the sweep loop runs it on the candidate before calling here).
  const resolved = claimUnderWorktrees(repoRoot, worktreePath);
  if (resolved === null) return { state: null };
  const owner = index.byPath.get(resolved);
  if (owner === undefined) return { state: null };
  if (owner.state.issue === launchingCycleIssue) return { state: null };
  return { state: owner.state, ownerIssue: owner.state.issue };
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
  /** Maximum number of remote proofs attempted during the launch sweep. */
  netProofLimit?: number;
  /** Disable remote proofs while retaining local-only purge behavior. */
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
  const netProofBudget = { remaining: Math.max(0, opts.netProofLimit ?? 5) };
  // ONE read of `.pi/work-state/` for the whole sweep — findOwningCycleState
  // used to reopen and reparse it once per worktree.
  const ownerIndex = buildOwnerIndex(repoRoot);
  if (ownerIndex.corrupt.length > 0) {
    trace(
      `worktree-sweep: skipped ${ownerIndex.corrupt.length} corrupt state file(s): ${ownerIndex.corrupt.join(", ")}`,
    );
  }
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

    if (isLaunchingCycleOwnWorktree(resolved.name, launchingCycleIssue)) {
      skipped.push({ path: resolved.realPath, reason: "launching-cycle-own" });
      continue;
    }

    // #1454 — the owner is resolved by WORKTREE PATH, not a basename guess
    // (see findOwningCycleState). An unclaimed tree is skipped: no owner whose
    // liveness could be judged.
    const owner = findOwningCycleState(
      repoRoot,
      resolved.realPath,
      launchingCycleIssue,
      ownerIndex,
    );
    if (!owner.state) {
      skipped.push({ path: resolved.realPath, reason: "state-unreadable" });
      continue;
    }
    const state = owner.state;

    const decideOpts: DecideOpts = {
      state,
      target: resolved,
      selfPid: process.pid,
      liveCycles,
      launchingCycleIssue: opts.launchingCycleIssue,
      execFn,
      netProofBudget,
      allowNetworkProof: opts.allowNetworkProof,
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
      if (result.purgeSkipped) {
        skipped.push({ path: resolved.realPath, reason: "purge-skipped:real-deps" });
        trace(`worktree-sweep: purge skipped for ${resolved.realPath}: real dependency tree`);
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
  const netProofBudget = { remaining: Object.keys(worktrees).length };

  for (const [worktreeName, worktreePath] of Object.entries(worktrees)) {
    // r2 — the same containment gate `buildOwnerIndex` applies to every
    // `pipelineState.worktrees` value. `integrateWorktree` is the one path the
    // driver records OUTSIDE that map, so without this line it was the only
    // state-file path the teardown loop could act on without the gate: a
    // hand-edited `integrateWorktree` reached `git clean -fdX` in a directory
    // the sweep should never have entered.
    const claimed = claimUnderWorktrees(repoRoot, worktreePath);
    if (claimed === null) {
      trace(`worktree-teardown: invalid worktree path ${worktreePath}: outside-worktrees`);
      continue;
    }
    const resolved = resolveSweepTarget(repoRoot, claimed);
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
      netProofBudget,
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
      if (result.purgeSkipped) {
        trace(`worktree-teardown: purge skipped for ${resolved.realPath}: real dependency tree`);
      }
    } else if (action.type === "remove") {
      // Worktree removed, not retained
    } else if (action.type === "skip") {
      // Worktree skipped, retained
      retained.push(resolved.realPath);
    }
  }

  return retained;
}
