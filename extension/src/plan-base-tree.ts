/**
 * plan-base-tree — what /plan's investigators read (#1132 addendum, decision 3).
 *
 * The driver fetches the default branch ONCE per run. The inventory and the
 * investigation children then read a detached worktree at origin/<default>,
 * never the local working tree, so a dirty or stale checkout cannot change the
 * drafted spec. The base tree lives under the clone's git common dir (never
 * tracked); a run whose origin SHA differs replaces it, so only the current
 * base is kept.
 *
 * Every failure fails open to the local checkout with a trace: a /plan run is
 * never lost to git plumbing (the same posture as the investigation cache).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

const git = async (cwd: string, args: string[], timeout = 60_000): Promise<string> => {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout });
  return stdout.trim();
};

/**
 * Fetch origin/<default> once and return its SHA. Undefined when the default
 * branch cannot be resolved; a failed fetch falls back to the last fetched ref.
 */
export async function fetchOriginBase(repoRoot: string): Promise<string | undefined> {
  try {
    const ref = await git(
      repoRoot,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      10_000,
    );
    const branch = ref.replace(/^origin\//, "");
    if (!branch) return undefined;
    try {
      await git(repoRoot, ["fetch", "--quiet", "origin", branch]);
    } catch (err) {
      trace(
        `plan-base-tree: fetch origin ${branch} failed — using the last fetched origin/${branch} (${(err as Error).message})`,
      );
    }
    return (
      (await git(
        repoRoot,
        ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`],
        10_000,
      )) || undefined
    );
  } catch (err) {
    trace(
      `plan-base-tree: origin/<default> unresolvable — investigators read the local checkout (${(err as Error).message})`,
    );
    return undefined;
  }
}

/**
 * The tree the inventory and investigators read: the origin/<default> base
 * worktree when the run resolved one, otherwise the local checkout.
 */
export async function planReadRoot(
  repoRoot: string,
  state: { cacheDir: string; baseSha?: string } | undefined,
): Promise<string> {
  if (!state?.baseSha) return repoRoot;
  const baseRoot = path.join(path.dirname(state.cacheDir), "pi-plan-base");
  const dir = path.join(baseRoot, state.baseSha);
  try {
    const current = await git(dir, ["rev-parse", "HEAD"], 10_000).catch(() => "");
    if (current === state.baseSha) return dir;
    // Only the current origin SHA is kept: retire any earlier base tree first.
    for (const old of await fs.readdir(baseRoot).catch(() => [])) {
      await git(repoRoot, ["worktree", "remove", "--force", path.join(baseRoot, old)]).catch(
        () => undefined,
      );
    }
    await fs.rm(baseRoot, { recursive: true, force: true });
    await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
    await fs.mkdir(baseRoot, { recursive: true });
    await git(repoRoot, ["worktree", "add", "--detach", dir, state.baseSha], 120_000);
    return dir;
  } catch (err) {
    trace(
      `plan-base-tree: base tree at ${state.baseSha} unavailable — investigators read the local checkout (${(err as Error).message})`,
    );
    return repoRoot;
  }
}
