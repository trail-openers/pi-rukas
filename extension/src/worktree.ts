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
import { type ProvisionResult, provisionWorktree } from "./worktree-provision.ts";
export type { ProvisionResult } from "./worktree-provision.ts";
export { salvageUncommittedWork, salvageDirtyWorktree } from "./worktree-salvage.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
export type ExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
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
}

/**
 * A leftover worktree holds work we would otherwise destroy.
 *
 * `worktreeCreate` pre-removes an existing worktree at the same path so a
 * resumed cycle is not wedged by its own leftover — but a `git worktree remove
 * --force` does not check what it is removing. The develop step instructs
 * developers not to commit, so a cycle that died mid-develop leaves its diff
 * uncommitted in the worktree: not in the object database, unrecoverable
 * (#475). The force-remove destroyed it with no warning, and deleting
 * unrecoverable work must never be the silent default.
 */
export class DirtyWorktreeError extends Error {
  /** The absolute worktree path and what it holds — the plumb report and the
   * #545 same-issue salvage use this instead of re-scanning the name. */
  readonly finding: DirtyWorktreeFinding;

  constructor(finding: DirtyWorktreeFinding) {
    super(DirtyWorktreeError.messageFor(finding));
    this.name = "DirtyWorktreeError";
    this.finding = finding;
  }

  static messageFor(finding: DirtyWorktreeFinding): string {
    // If the worktree is being retained, return a retention message.
    if (finding.retained === true) {
      return `refusing to pre-remove retained worktree ${finding.path} — it is in the retained names set`;
    }
    const fromRef =
      finding.unpushedCommitCount > 0 ? ` (unpushed commits: ${finding.unpushedCommitCount})` : "";
    const parts = [
      `refusing to force-remove existing worktree ${finding.path} — it holds unrecoverable work:`,
      finding.uncommittedFiles.length > 0
        ? `${finding.uncommittedFiles.length} uncommitted file(s): ${finding.uncommittedFiles
            .slice(0, 8)
            .join(", ")}${finding.uncommittedFiles.length > 8 ? ", …" : ""}`
        : "",
      fromRef,
    ].filter(Boolean);
    parts.push(
      "Inspect the worktree (`git status`, `git diff`), salvage the work (e.g. `git diff > patch` or commit it to a branch), then remove it (`git worktree remove --force -- <path>`) and re-run.",
    );
    return parts.join(" ");
  }
}

export interface DirtyWorktreeFinding {
  path: string;
  uncommittedFiles: string[];
  unpushedCommitCount: number;
  /** True when the worktree is being retained (not removed) due to being in the retained names set. */
  retained?: boolean;
}

/**
 * Inspect an existing worktree for work a force-remove would destroy.
 *
 * Two signals: uncommitted files (`git status --porcelain` in the worktree)
 * and local commits ahead of `fromRef` (`rev-list --count` — a worktree that
 * committed past its base, e.g. cherry-pick integration, would lose those).
 * The check itself must never fail the create: an unreadable worktree is
 * removed as today, because refusing on a git error would reintroduce the
 * wedged-queue leftover class the pre-remove exists to prevent.
 */
export async function inspectWorktreeForLoss(
  execFn: ExecFn,
  repoRoot: string,
  worktreeAbs: string,
  fromRef: string,
): Promise<DirtyWorktreeFinding | undefined> {
  let exists = false;
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify("HEAD")}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
    exists = true;
  } catch {
    return undefined; // no live worktree here — nothing to inspect
  }
  if (!exists) return undefined;
  let porcelain = "";
  try {
    ({ stdout: porcelain } = await execFn("git status --porcelain", {
      cwd: worktreeAbs,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    porcelain = "";
  }
  let ahead = 0;
  try {
    const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(`${fromRef}..HEAD`)}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
    ahead = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead < 0) ahead = 0;
  } catch {
    ahead = 0;
  }
  const files = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (files.length === 0 && ahead === 0) return undefined;
  return { path: worktreeAbs, uncommittedFiles: files, unpushedCommitCount: ahead };
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
    { repoRoot: opts.repoRoot, name: opts.name, fromRef: opts.fromRef },
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
    // `git worktree add` — the exact detail #753 exists to capture.
    // Re-expose it so the one extractor (`gitErrorDetail`) works on the
    // wrapper, and the numeric exit status survives for `failure.exitStatus`.
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
    ({ stdout: list } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    return [];
  }
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
 * destroy. An unreadable `git worktree list` returns undefined: the
 * refusal then happens the pre-#545 way (the raw git error, now plumbed
 * via `gitErrorDetail`), which is the safe degradation.
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
): Promise<DirtyWorktreeFinding | undefined> {
  const wtMarker = `.worktrees${path.sep}${issuePrefix}`;
  const hits = await scanWorktrees(execFn, repoRoot, fromRef, [wtMarker], selfName);
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
