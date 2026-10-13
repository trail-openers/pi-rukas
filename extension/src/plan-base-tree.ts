/**
 * plan-base-tree — what /plan's investigators read (#1132 addendum, decision 3).
 *
 * One run, one base. `openPlanBase` fetches origin/<default> ONCE for the run
 * and checks it out as a detached worktree under the clone's git common dir
 * (never tracked). The inventory and the investigation children read that tree,
 * never the working tree, so a dirty or stale checkout cannot change the spec.
 *
 * `withPlanBase` removes the run's tree in its `finally`; `git worktree prune`
 * clears registrations whose directory has already gone. Every failure fails
 * open to the local checkout, and the run records WHY in `baseFallback`
 * (disclosed on the result), so a /plan run is never lost to git plumbing.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

const git = async (cwd: string, args: string[], timeout = 60_000): Promise<string> => {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout });
  return stdout.trim();
};

/** git's stderr when the process left some, else the error's message. */
function stderrOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "stderr" in err) {
    if (typeof err.stderr === "string" && err.stderr.trim()) return err.stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The first non-empty line of git's stderr: the reason, not the "Command failed" header. */
function firstLine(err: unknown): string {
  return (
    stderrOf(err)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "unknown error"
  );
}

/**
 * git's ref-not-found exit for `symbolic-ref`: 128 with "is not a symbolic ref"
 * (the same text a ref that exists but is not symbolic gets).
 */
function refNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === 128 &&
    /is not a symbolic ref/.test(stderrOf(err))
  );
}

/** Base trees older than this belong to a run that crashed before its `finally` (#1132). */
const STALE_BASE_MS = 24 * 60 * 60 * 1000;

/** What one /plan run reads, and how that was resolved. */
export interface PlanBase {
  /** The tree the inventory and investigators read: the base worktree, or the checkout. */
  readRoot: string;
  /** origin/<default> at the run's one fetch. Undefined when none resolved or the run fell back. */
  baseSha?: string;
  /** Why the run reads the local checkout after a failed fetch or base tree (disclosed). */
  baseFallback?: string;
  /** Remove this run's base tree. Never throws. */
  release(): Promise<void>;
}

/**
 * Why a default-branch name may not reach git, or undefined when it may. git
 * exiting non-zero is a rejection of the name; any other failure (a spawn error,
 * a timeout) is a failed check, reported as such rather than as a bad name.
 */
export async function branchNameProblem(
  repoRoot: string,
  name: string,
): Promise<string | undefined> {
  const notUsable = `default branch name ${JSON.stringify(name)} is not a usable branch name`;
  if (!name || name.startsWith("-")) return notUsable;
  try {
    await git(repoRoot, ["check-ref-format", "--branch", name], 10_000);
    return undefined;
  } catch (err) {
    if (typeof (err as { code?: unknown }).code === "number") return notUsable;
    return `branch-name check failed (${firstLine(err)})`;
  }
}

/**
 * Remove base trees a crashed run left in `baseRoot` (#1132). Best-effort and
 * traced: never throws, and never touches `keep`, this run's own tree.
 */
async function sweepStaleBases(repoRoot: string, baseRoot: string, keep: string): Promise<void> {
  const names = await fs.readdir(baseRoot).catch(() => []);
  for (const name of names) {
    const dir = path.join(baseRoot, name);
    if (dir === keep) continue;
    const stat = await fs.stat(dir).catch(() => undefined);
    if (!stat || Date.now() - stat.mtimeMs < STALE_BASE_MS) continue;
    await removeBaseTree(repoRoot, dir);
    trace(`plan-base-tree: swept a base tree left by an earlier run (${name})`);
  }
}

/** Remove one base worktree and its directory. Best-effort: never throws. */
async function removeBaseTree(repoRoot: string, dir: string): Promise<void> {
  await git(repoRoot, ["worktree", "remove", "--force", dir], 60_000).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await git(repoRoot, ["worktree", "prune"], 10_000).catch(() => undefined);
}

/** Run `fn` with this run's base, releasing the base tree however `fn` ends. */
export async function withPlanBase<T>(
  repoRoot: string,
  fn: (base: PlanBase) => Promise<T>,
): Promise<T> {
  const base = await openPlanBase(repoRoot);
  try {
    return await fn(base);
  } finally {
    await base.release();
  }
}

/**
 * Fetch origin/<default> once and build this run's base tree. The default branch
 * name is validated before it reaches git, and the fetch takes `--end-of-options`
 * so a name cannot be read as an option.
 */
export async function openPlanBase(repoRoot: string): Promise<PlanBase> {
  const local = (baseFallback?: string): PlanBase => ({
    readRoot: repoRoot,
    ...(baseFallback ? { baseFallback } : {}),
    release: async () => undefined,
  });
  // PI_ENSEMBLE_PLAN_CACHE=0 (verify-loop): no origin lookup, no fetch, no tree.
  if (process.env.PI_ENSEMBLE_PLAN_CACHE === "0") return local();

  let branch: string;
  try {
    const ref = await git(
      repoRoot,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      10_000,
    );
    branch = ref.replace(/^origin\//, "");
  } catch (err) {
    const reason = refNotFound(err)
      ? "origin/HEAD is not set; investigators read the local checkout"
      : `could not read origin/HEAD: ${firstLine(err)}`;
    trace(`plan-base-tree: ${reason} — reading the checkout`);
    return local(reason);
  }
  const problem = await branchNameProblem(repoRoot, branch);
  if (problem) {
    trace(`plan-base-tree: ${problem} — reading the checkout`);
    return local(problem);
  }

  try {
    await git(repoRoot, ["fetch", "--quiet", "origin", "--end-of-options", branch], 120_000);
  } catch (err) {
    const reason = `fetch origin ${branch} failed (${firstLine(err)})`;
    trace(`plan-base-tree: ${reason} — reading the checkout`);
    return local(reason);
  }

  let sha: string;
  try {
    sha = await git(
      repoRoot,
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`],
      10_000,
    );
  } catch (err) {
    const reason = `origin/${branch} does not resolve after the fetch (${firstLine(err)})`;
    trace(`plan-base-tree: ${reason} — reading the checkout`);
    return local(reason);
  }

  let dir = "";
  try {
    const commonDir = await git(
      repoRoot,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      10_000,
    );
    const baseRoot = path.join(commonDir, "pi-plan-base");
    await fs.mkdir(baseRoot, { recursive: true });
    // Registrations left by a run whose directory is already gone.
    await git(repoRoot, ["worktree", "prune"], 10_000).catch(() => undefined);
    dir = path.join(baseRoot, randomBytes(8).toString("hex"));
    await sweepStaleBases(repoRoot, baseRoot, dir);
    await git(repoRoot, ["worktree", "add", "--detach", dir, sha], 120_000);
  } catch (err) {
    if (dir) await removeBaseTree(repoRoot, dir);
    const reason = `base tree at ${sha.slice(0, 12)} could not be created (${firstLine(err)})`;
    trace(`plan-base-tree: ${reason} — reading the checkout`);
    return local(reason);
  }
  return {
    readRoot: dir,
    baseSha: sha,
    release: () => removeBaseTree(repoRoot, dir),
  };
}
