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

import path from "node:path";
import { trace } from "./trace.ts";
import { type ProvisionResult, provisionWorktree } from "./worktree-provision.ts";
export type { ProvisionResult } from "./worktree-provision.ts";

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
 * Idempotent by construction: an existing worktree at the same path is removed
 * first. A resumed cycle must not fail because its own previous attempt left a
 * directory behind — that is the class of leftover that wedged whole queues.
 *
 * The pre-remove is guarded (#475): when the leftover holds uncommitted work
 * or local commits, force-removing it would destroy work that is nowhere else
 * (develop diffs are never committed). `worktreeCreate` then throws a
 * `DirtyWorktreeError` naming the absolute path instead, and the caller
 * (`mechanizedBranchSetup`) refuses — no fallback, because the LLM ops path
 * would destroy the same work through the same `--force` — routing the cycle
 * to handoff. A clean leftover is removed as before.
 */
export async function worktreeCreate(
  execFn: ExecFn,
  opts: WorktreeCreateOpts,
): Promise<WorktreeCreateResult> {
  const abs = worktreePath(opts.repoRoot, opts.name);
  // #545 — the mechanism that killed the #540 restart: `worktree add` itself
  // refuses against ANY leftover worktree of the same cycle (e.g. the
  // cycle's OWN dead siblings from a parked run, all named
  // `issue-<N>-<id>`). Inspect what's attached first so a dirty one becomes
  // a refusal WITH salvage instead of a bare `fatal: ... already exists`
  // error. A clean foreign leftover is still handled by `worktree add`'s
  // own path-exists error — unchanged.
  const issuePrefix = opts.name.split("-").slice(0, 2).join("-");
  const siblingDirty = await findDirtySameIssueLeftover(
    execFn,
    opts.repoRoot,
    opts.fromRef,
    issuePrefix,
    opts.name,
  );
  if (siblingDirty) {
    throw new DirtyWorktreeError(siblingDirty);
  }
  const leftover = await inspectWorktreeForLoss(execFn, opts.repoRoot, abs, opts.fromRef);
  if (leftover) {
    throw new DirtyWorktreeError(leftover);
  }
  await worktreeRemove(execFn, opts.repoRoot, opts.name, true).catch(() => undefined);
  // Always detached at baseSha: a named branch in a worktree contradicts
  // #287 (worktrees are the workstream's scratch space; the feature branch
  // only ever exists at repoRoot, where integration happens) and breaks the
  // invariant test-work-driver-always-worktree.ts enforces.
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
 * #545 — `git worktree add` refuses against any leftover worktree of the
 * same cycle (not just the one at the target path). Find attached
 * worktrees with the same issue prefix that hold work a force-remove would
 * destroy. An unreadable `git worktree list` returns undefined: the
 * refusal then happens the pre-#545 way (the raw git error, now plumbed
 * via `gitErrorDetail`), which is the safe degradation.
 */
export async function findDirtySameIssueLeftover(
  execFn: ExecFn,
  repoRoot: string,
  fromRef: string,
  issuePrefix: string,
  selfName: string,
): Promise<DirtyWorktreeFinding | undefined> {
  let list: string;
  try {
    ({ stdout: list } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    return undefined;
  }
  const wtMarker = `.worktrees${path.sep}${issuePrefix}`;
  for (const line of list.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("worktree ")) continue;
    const wtPath = l.slice("worktree ".length);
    if (!wtPath.includes(wtMarker)) continue;
    // Skip the cycle's own target — that's handled by `inspectWorktreeForLoss`
    // below (a clean leftover is removed, a dirty one is a #475 refusal).
    const wtName = path.basename(wtPath);
    if (wtName === selfName) continue;
    const finding = await inspectWorktreeForLoss(execFn, repoRoot, wtPath, fromRef).catch(
      () => undefined,
    );
    if (finding) return finding;
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
