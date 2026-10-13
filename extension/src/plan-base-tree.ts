/**
 * plan-base-tree — what /plan's investigators read (#1132 addendum, decision 3).
 *
 * One run, one base. `openPlanBase` fetches origin/<default> ONCE for the run
 * and checks it out as a detached worktree under the clone's git common dir
 * (never tracked). The inventory and the investigation children read that tree,
 * never the working tree, so a dirty or stale checkout cannot change the spec.
 *
 * The tree is per run (`<sha>.<pid>.<rand>`) and removed by `release()` when the
 * run ends. Other runs' trees are never retired; only trees whose owning pid is
 * dead are pruned. Every failure fails open to the local checkout, and the run
 * records WHY in `baseFallback` (disclosed on the result), so a /plan run is
 * never lost to git plumbing.
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

/** The first line of a git failure, for a one-line disclosure. */
const firstLine = (err: unknown): string => (err as Error).message.split("\n")[0] ?? "";

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

/** A default-branch name the fetch may take: no option-like prefix, a valid branch name. */
async function isUsableBranchName(repoRoot: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  try {
    await git(repoRoot, ["check-ref-format", "--branch", name], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Remove one base worktree and its directory. Best-effort: never throws. */
async function removeBaseTree(repoRoot: string, dir: string): Promise<void> {
  await git(repoRoot, ["worktree", "remove", "--force", dir], 60_000).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await git(repoRoot, ["worktree", "prune"], 10_000).catch(() => undefined);
}

/** A process that exists, or one we may not signal (EPERM), is alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Prune base trees whose owning process is gone. A tree named for this process
 * (or a live one) is left alone: another run may be reading it.
 */
async function pruneDeadBaseTrees(repoRoot: string, baseRoot: string): Promise<void> {
  for (const name of await fs.readdir(baseRoot).catch(() => [] as string[])) {
    const pid = Number(name.split(".")[1]);
    if (!Number.isInteger(pid) || pid === process.pid || pidAlive(pid)) continue;
    await removeBaseTree(repoRoot, path.join(baseRoot, name));
  }
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
    // No origin/HEAD: the default branch is unresolved, which is normal, not a failure.
    trace(
      `plan-base-tree: origin/<default> unresolvable — reading the checkout (${firstLine(err)})`,
    );
    return local();
  }
  if (!(await isUsableBranchName(repoRoot, branch))) {
    const reason = `default branch name ${JSON.stringify(branch)} is not a usable branch name`;
    trace(`plan-base-tree: ${reason} — reading the checkout`);
    return local(reason);
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
    await pruneDeadBaseTrees(repoRoot, baseRoot);
    dir = path.join(baseRoot, `${sha}.${process.pid}.${randomBytes(4).toString("hex")}`);
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
