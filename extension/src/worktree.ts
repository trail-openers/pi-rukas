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
 * lens-exec.ts) both honour it via `execFile`. */
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
 * Scan `git worktree list` for attached worktrees whose path contains any of
 * the given path substrings, skipping any name in `exclude`. An unreadable
 * list returns an empty array — the safe direction (no action) for every
 * caller (a #545 refusal degrades to the raw git error; a residue pass
 * degrades to no-op).
 *
 * Shared by `findDirtySameIssueLeftover` (returns the first dirty hit) and
 * `findSameIssueLeftovers` (returns all) so the porcelain parsing and the
 * `inspectWorktreeForLoss` loop live in one place.
 */
export async function scanWorktrees(
  execFn: ExecFn,
  repoRoot: string,
  fromRef: string,
  pathSubstrings: string[],
  exclude?: string,
): Promise<{ path: string; name: string; finding?: DirtyWorktreeFinding }[]> {
  let list: string;
  try {
    list = await listWorktreePorcelain(execFn, repoRoot);
  } catch {
    return []; // fail open: an unreadable listing reads as no siblings
  }
  return inspectListedWorktrees(execFn, repoRoot, list, fromRef, pathSubstrings, exclude);
}

/** The strict listing — an unreadable `git worktree list` throws. */
async function listWorktreePorcelain(execFn: ExecFn, repoRoot: string): Promise<string> {
  const { stdout } = await execFn("git worktree list --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/** Inspect every listed worktree whose path matches a substring. */
async function inspectListedWorktrees(
  execFn: ExecFn,
  repoRoot: string,
  list: string,
  fromRef: string,
  pathSubstrings: string[],
  exclude?: string,
): Promise<{ path: string; name: string; finding?: DirtyWorktreeFinding }[]> {
  const out: { path: string; name: string; finding?: DirtyWorktreeFinding }[] = [];
  for (const line of list.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("worktree ")) continue;
    const wtPath = l.slice("worktree ".length);
    if (!pathSubstrings.some((p) => wtPath.includes(p))) continue;
    const name = path.basename(wtPath);
    if (name === exclude) continue;
    const finding = await inspectWorktreeForLoss(execFn, repoRoot, wtPath, fromRef).catch(
      () => undefined,
    );
    out.push({ path: wtPath, name, finding });
  }
  return out;
}

/**
 * #545 — `git worktree add` refuses against any leftover worktree of the
 * same cycle (not just the one at the target path). Find attached
 * worktrees with the same issue prefix that hold work a force-remove would
 * destroy. `strict` (the branch step, #1170) makes an unreadable
 * `git worktree list` THROW `WorktreeScanError` after one retry: a listing that
 * cannot be read cannot prove the absence of a dirty sibling. Non-strict callers
 * read it as no siblings (the fail-open contract they always had).
 *
 * `excludePaths` — additional worktree paths to skip (in addition to
 * `selfName`). #753: this cycle's own worktrees (created by the branch step
 * or by an earlier dependent) are legitimate in-progress work, not
 * "leftover" — without this exclusion the scan would park the cycle on a
 * false positive.
 */
export async function findDirtySameIssueLeftover(
  execFn: ExecFn,
  repoRoot: string,
  fromRef: string,
  issuePrefix: string,
  selfName: string,
  excludePaths?: string[],
  strict = false,
): Promise<DirtyWorktreeFinding | undefined> {
  const wtMarker = `.worktrees${path.sep}${issuePrefix}`;
  // #1170 — strict: an unreadable listing refuses (WorktreeScanError) so the
  // branch step never reaches the LLM ops fallback unscanned.
  let list: string;
  if (strict) {
    list = await listWorktreeStrict(execFn, repoRoot);
  } else {
    try {
      list = await listWorktreePorcelain(execFn, repoRoot);
    } catch (e) {
      trace(
        `worktree: sibling scan unreadable for ${selfName} — proceeding without it (${gitErrorDetail(e)})`,
      );
      return undefined;
    }
  }
  const hits = await inspectListedWorktrees(execFn, repoRoot, list, fromRef, [wtMarker], selfName);
  // #753 — on macOS, `git worktree list --porcelain` returns symlink-resolved
  // paths (/private/var/...) while our paths are the logical form (/var/...).
  // Resolve both sides before comparing.
  const excludeSet = new Set((excludePaths ?? []).map((p) => resolvePath(p)));
  for (const hit of hits) {
    if (excludeSet.has(resolvePath(hit.path))) continue;
    if (hit.finding) return hit.finding;
  }
  return undefined;
}

/**
 * #1170 — the strict listing for the branch step's sibling scan. A transient
 * `git worktree list` failure is retried once (250ms) before it refuses, so a
 * single flaky read does not park a clean cycle; the refusal names the attempts.
 */
async function listWorktreeStrict(execFn: ExecFn, repoRoot: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await listWorktreePorcelain(execFn, repoRoot);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new WorktreeScanError(`${gitErrorDetail(lastErr)} (after 2 attempts)`);
}

/** Drop administrative records for worktrees whose directories are gone. */
export async function worktreePrune(execFn: ExecFn, repoRoot: string): Promise<void> {
  await execFn("git worktree prune", { cwd: repoRoot, maxBuffer: 256 * 1024 });
}

export async function worktreeList(execFn: ExecFn, repoRoot: string): Promise<string> {
  const { stdout } = await execFn("git worktree list --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * #654 — the target branch for `git checkout <branch>` is held by another
 * worktree. git refuses the checkout outright ("fatal: '<branch>' is
 * already used by worktree at '<path>'") — the census found 2 cycles
 * parking exactly on this string. The worktree machinery already knows how
 * to remove clean holders safely; a DIRTY holder must never be force-removed
 * (the #475 convention) — refuse with the existing `DirtyWorktreeError`.
 *
 * Called from `integrate()` in followup mode, BEFORE the checkout. A cycle
 * whose own worktree map still holds the branch (a parked prior cycle's
 * leftover, or a sibling group that hasn't torn down yet) blocks the
 * checkout; removing the clean holder unblocks it mechanically. A dirty
 * holder holds work that is not in the object database — force-removing it
 * would be exactly the #475 incident, so the refusal carries the absolute
 * path and the operator's salvage instructions.
 *
 * Returns true when the branch was held and is now free (a clean holder was
 * removed); false when no holder exists (the normal case); throws
 * `DirtyWorktreeError` when the holder holds uncommitted work or local
 * commits. An unreadable `git worktree list` is treated as "no holder" —
 * the checkout will then fail with the raw git error (plumbed via the
 * existing catch in `integrate()`), which is the safe degradation: refusing
 * the whole integration on a git error would be a worse failure.
 */
export async function sweepBranchHolders(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const list = await worktreeList(execFn, repoRoot).catch(() => "");
  const lines = list.split("\n");
  let holderPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]?.trim() ?? "";
    if (l.startsWith("worktree ")) {
      // The worktree line is followed by one or more attribute lines
      // (e.g. "HEAD <sha>", "branch refs/heads/<name>", "detached"). The
      // branch we care about is in the `branch` line, not the worktree line
      // itself, so we must walk forward from each worktree marker.
      const start = i;
      let j = i + 1;
      let found: string | undefined;
      while (j < lines.length) {
        const attr = lines[j]?.trim() ?? "";
        if (attr.startsWith("worktree ")) break; // next worktree entry
        if (attr === `branch refs/heads/${branchName}`) {
          found = lines[start]?.slice("worktree ".length).trim();
          break;
        }
        j++;
      }
      if (found !== undefined) {
        holderPath = found;
        break;
      }
    }
  }
  if (!holderPath) return false;
  // The main working tree (repoRoot itself) is not a worktree that can be
  // removed — if it's holding the branch, that's the normal state and there
  // is nothing to sweep. macOS /tmp is a symlink to /private/tmp, so
  // normalise both sides before comparing.
  if (resolvePath(holderPath) === resolvePath(repoRoot)) {
    return false;
  }
  const finding = await inspectWorktreeForLoss(execFn, repoRoot, holderPath, "HEAD");
  if (finding) {
    throw new DirtyWorktreeError(finding);
  }
  // Clean holder — remove it so the checkout can proceed.
  await execFn(`git worktree remove ${JSON.stringify(holderPath)}`, {
    cwd: repoRoot,
    maxBuffer: 256 * 1024,
  });
  trace(`worktree: removed clean holder ${holderPath} for branch ${branchName}`);
  return true;
}
