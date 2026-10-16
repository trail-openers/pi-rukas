/**
 * worktree — git worktree helpers for the always-worktree driver (#287).
 *
 * Rewritten from the P1 stub, which had no importers: it shelled out with
 * `execFile` in `process.cwd()`, always created a `scratch/<name>` branch, and
 * returned a relative path. All three are wrong for the driver, which operates
 * on an absolute repoRoot, wants worktrees DETACHED at a base SHA (a scratch
 * branch per workstream is a second thing to clean up and a second way to
 * confuse `git rev-parse --abbrev-ref HEAD`), and needs absolute paths to hand
 * to subagents as their cwd.
 *
 * Every call takes the driver's `ExecFn` so the same injection seam the verify
 * gates use covers worktree setup too — #287's acceptance criterion is a test
 * that records (command, cwd) pairs and asserts no git command runs with
 * `cwd === repoRoot` between branch and commit-pr, which is only observable if
 * these calls go through that seam.
 *
 * Timeout policy (#1396): every `git worktree list` this module and its
 * branch-holder sibling run carries `WORKTREE_LIST_TIMEOUT_MS`, so a HANG is a
 * rejection — the strict listing turns it into `WorktreeScanError`, and the
 * callers that used to read an unreadable list as "nothing there" distinguish
 * "genuinely absent git" from "could not answer". The branch-holder audit in
 * `work-driver-branch-holder.ts` runs through the same seam and passes the same
 * bound; a listing with no timeout is a bug, not a fast path.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";
import { runCreateGuards } from "./worktree-create-guard.ts";
import {
  DirtyWorktreeError,
  type DirtyWorktreeFinding,
  WorktreeScanError,
  inspectWorktreeForLoss,
} from "./worktree-loss.ts";
import { type ProvisionResult, provisionWorktree } from "./worktree-provision.ts";
export type { ProvisionResult } from "./worktree-provision.ts";
export { DirtyWorktreeError, inspectWorktreeForLoss, WorktreeScanError };
export type { DirtyWorktreeFinding };
export { salvageUncommittedWork, salvageDirtyWorktree } from "./worktree-salvage.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. The optional
 * `argv` form (#1005) runs the command without a shell re-parse: `cmd`
 * is the executable, `argv` its arguments, and a planner-controlled
 * path arrives as ONE argument — never through `sh -c`, where it would
 * be re-parsed and `$(…)`, backticks or `;` inside the data would
 * execute. Implementations that do not honour `argv` are the caller's
 * risk; the driver's production executors (work-driver-verify.ts and
 * exec.ts) both honour it via `execFile`. */
export type ExecFn = (
  cmd: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    shell?: string;
    argv?: string[];
    /** #1095 — network git calls carry the non-interactive env (work-driver-net-git.ts). */
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr?: string }>;

/** Worktrees live under `<repoRoot>/.worktrees/<name>`. */
export function worktreePath(repoRoot: string, name: string): string {
  return path.join(repoRoot, ".worktrees", name);
}

/**
 * #1396 — the bound on every `git worktree list` the worktree helpers run.
 * Lives with the listing itself in `worktree-listing.ts`; re-exported here so
 * every caller keeps one import path. See that module's header for the policy.
 */
export { WORKTREE_LIST_TIMEOUT_MS } from "./worktree-listing.ts";

/**
 * Resolve a path to its canonical form (handles macOS /var → /private/var).
 * No-op for paths that do not exist yet — the worktree target is resolved
 * before `git worktree add` creates it, so this must not throw.
 */
export function resolvePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * #545 — the machine-readable git error behind a failed command.
 *
 * The production `ExecFn` is `promisify(exec)`, whose rejection carries
 * `stderr` (the actual git output, e.g. `fatal: cannot lock ref…` or
 * `fatal: '…' already exists`); its `message` is that stderr wrapped in
 * `Command failed: <cmd>` + a newline. Read stderr first and trim the
 * command wrapper out of the fallback, so a plumb report names the CAUSE
 * instead of a bare `step-failed:branch`.
 */
export function gitErrorDetail(err: unknown): string {
  const e = err as Error & { stderr?: string };
  const raw = (e.stderr ?? e.message ?? "unknown error").toString();
  return raw.replace(/^\s*Command failed:\s*.*\n?/s, "").trim();
}

export interface WorktreeCreateOpts {
  repoRoot: string;
  /** Directory name under `.worktrees/`, e.g. `issue-287-default`. */
  name: string;
  /** Commit-ish the worktree starts at — the driver passes the resolved baseSha. */
  fromRef: string;
  /** Worktree names that should be retained (not pre-removed) during creation. */
  retainedNames?: string[];
  /**
   * #1170 — the branch step's seam: an unreadable `git worktree list` REFUSES
   * (WorktreeScanError, after one retry) instead of reading as no siblings.
   * Every other caller keeps the fail-open sibling scan it always had.
   */
  strictSiblingListing?: boolean;
}

/**
 * The resolved path and provisioning outcome from `worktreeCreate`.
 *
 * Split out so callers can record the provision state in the event log
 * (for machine-readable diagnostics) without coupling the low-level
 * worktree helper to the state machine.
 */
export interface WorktreeCreateResult {
  path: string;
  provision: ProvisionResult;
}

/**
 * Create a worktree, returning its absolute path and provisioning outcome.
 *
 * `inCycleWorktrees` — optional list of worktree PATHS that belong to the
 * current cycle (this workstream set, e.g. created by the branch step or by
 * an earlier dependent in the dependent phase). The #545 same-issue dirty
 * scan (`findDirtySameIssueLeftover`) is unbounded within a cycle: without
 * this exclusion an earlier workstream's legitimate in-progress dirt would be
 * misread as a "leftover" and park the cycle. In-cycle paths are excluded
 * from the scan; a genuinely foreign leftover is still caught.
 */
export async function worktreeCreate(
  execFn: ExecFn,
  opts: WorktreeCreateOpts,
  inCycleWorktrees?: string[],
): Promise<WorktreeCreateResult> {
  const abs = worktreePath(opts.repoRoot, opts.name);
  // If the worktree name is in the retainedNames set, refuse to pre-remove.
  if (opts.retainedNames?.includes(opts.name)) {
    trace(`worktree: ${opts.name} is in retainedNames, skipping pre-remove`);
    // Check if the worktree exists and is dirty to provide a proper error.
    const leftover = await inspectWorktreeForLoss(execFn, opts.repoRoot, abs, opts.fromRef);
    if (leftover) {
      // If it's dirty, throw the existing error.
      throw new DirtyWorktreeError(leftover);
    }
    // If it's clean, we still refuse to remove, but we need to throw an error
    // to signal that the worktree should not be removed. We'll create a
    // DirtyWorktreeError with retained set to true.
    throw new DirtyWorktreeError({
      path: abs,
      uncommittedFiles: [],
      unpushedCommitCount: 0,
      retained: true,
    });
  }
  // #545 / #753 — the pre-add guards (sibling scan + target-path dirty
  // guard) live in worktree-create-guard.ts (split for the 500-line cap).
  // The target-path #475 guard runs UNCONDITIONALLY there; in-cycle
  // membership only waives the sibling scan and the pre-remove, never the
  // dirty guard.
  await runCreateGuards(
    execFn,
    {
      repoRoot: opts.repoRoot,
      name: opts.name,
      fromRef: opts.fromRef,
      strictSiblingListing: opts.strictSiblingListing,
    },
    inCycleWorktrees,
  );
  // Always detached at baseSha: a named branch in a worktree contradicts
  // #287 (worktrees are the workstream's scratch space; the feature branch
  // only ever exists at repoRoot, where integration happens) and breaks
  // the invariant test-work-driver-always-worktree.ts enforces.
  const add = async () =>
    execFn(`git worktree add --detach ${JSON.stringify(abs)} ${JSON.stringify(opts.fromRef)}`, {
      cwd: opts.repoRoot,
      maxBuffer: 1024 * 1024,
    });
  try {
    await add();
  } catch (err) {
    // #545 — the raw git error is the one thing the operator needs to see
    // (which path already exists, which lock held). `git worktree add`
    // prints its reason to stderr; the `ExecFn` contract carries it as
    // `stderr` when the executor captured it. Wrap in a fresh Error so
    // downstream consumers (the plumb-report's `gitErrorDetail`) can read
    // the detail even if the original was a non-Error (a number, a string,
    // a process exit code — `promisify(exec)` is one of the legitimate
    // rejection shapes and doesn't carry `.message` the same way).
    const e = err as Error & { stderr?: string };
    const detail = (e.stderr ?? "").toString().trim();
    const originalMsg = e.message ?? String(err);
    const msg = detail && !originalMsg.includes(detail) ? `${originalMsg}\n${detail}` : originalMsg;
    const wrapped = new Error(`worktreeCreate: ${opts.name} failed: ${msg}`);
    wrapped.cause = err;
    // #753 (six-lens FIX 1) — the wrapped Error drops the rejection's
    // `code`/`stderr`, so the deferred-creation catch (which can only read
    // the wrapper) would record `stderr: undefined` for a failing
    // `git worktree add` — the exact detail #753 exists to capture. Re-expose
    // both on the wrapper: `stderr` so the one extractor (`gitErrorDetail`)
    // works on the wrapper, and the numeric `code` so the deferred-creation
    // catch reads the real exit status off `wrapped.code` for
    // `failure.exitStatus` (a failing `git worktree add` via
    // `promisify(exec)` rejects with `code: 128`).
    (wrapped as Error & { stderr?: string; code?: number }).stderr = detail;
    const causeCode = (err as { code?: unknown })?.code;
    if (typeof causeCode === "number") (wrapped as Error & { code?: number }).code = causeCode;
    throw wrapped;
  }
  // A worktree with only tracked files cannot run the project's own commands:
  // every gitignored dependency directory is absent, and the develop step runs
  // the verify command in here. Never throws — a bare worktree is what shipped
  // before this, so a provisioning failure is the status quo, not a regression.
  const provisioned = await provisionWorktree(execFn, opts.repoRoot, abs);
  if (provisioned.problem) {
    trace(`worktree: ${opts.name} provisioning incomplete — ${provisioned.problem}`);
  }
  return { path: abs, provision: provisioned };
}

export async function worktreeRemove(
  execFn: ExecFn,
  repoRoot: string,
  name: string,
  force = false,
): Promise<void> {
  const abs = worktreePath(repoRoot, name);
  await execFn(`git worktree remove ${force ? "--force " : ""}${JSON.stringify(abs)}`, {
    cwd: repoRoot,
    maxBuffer: 256 * 1024,
  });
}

/**
 * #1396 — the one rejection shape that means "there is no git here": `ENOENT`
 * from `execFile`/`exec` (no binary, directory gone). Everything else — a
 * timeout, a kill, a signal, a lock — is "could not answer", and a caller that
 * reads that as an absence is the fail-open this discriminates against.
 *
 * "Genuinely absent git" is decided on the CODE, never on the message: a test
 * fake (or a wrapper that folds stderr into `message`) can put the words
 * "not a git repository" in a rejection that is otherwise unremarkable, and an
 * error-text match would then degrade a real refusal to silence.
 */
export function isMissingGit(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "enoent";
}

/** Drop administrative records for worktrees whose directories are gone. */
export async function worktreePrune(execFn: ExecFn, repoRoot: string): Promise<void> {
  await execFn("git worktree prune", { cwd: repoRoot, maxBuffer: 256 * 1024 });
}

/**
 * #1396 (round 3) — the read side of `git worktree list` lives in
 * `worktree-listing.ts` (split for the AGENTS.md §12 line cap). Re-exported here
 * so every caller — production and smoke test — keeps importing from this module:
 * the split is a file-seam, not an API change.
 */
export {
  findDirtySameIssueLeftover,
  listWorktreeStrict,
  scanWorktrees,
  sweepBranchHolders,
  worktreeList,
} from "./worktree-listing.ts";
