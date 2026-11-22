/**
 * develop-branch — puts a developer's worktree on a named branch before the
 * developer is handed it, so the reviews of that tree have a branch to key
 * their merge-ledger row on.
 *
 * A worktree is registered detached (`git worktree add --detach`), and that
 * stays: the registration is not touched here. What breaks attribution is a
 * HEAD that is STILL detached while a developer commits on it, because the
 * review resolves its ledger key from the checkout (review-branch.ts) and a
 * detached head names no branch — the merge guard then has no review on file
 * however many reviews ran. So a PM-dispatched developer (and the adversarial
 * loop's fix developer) gets its tree moved, in the tree itself, onto
 * `wt/<worktree directory name>` first. The name is per tree because git
 * refuses to check one branch out in two worktrees.
 *
 * The /work driver is not routed here: it keys every review on the cycle's
 * branch explicitly, and its integrate step reads the developer trees as
 * detached by design.
 *
 * The move never loses a commit: an existing branch of that name is only
 * fast-forwarded to HEAD, and one that holds commits HEAD lacks is a refusal.
 * The operator's own checkout (a non-linked worktree) is never moved.
 */

import path from "node:path";
import { execp } from "./exec.ts";
import { scrubGitLocation } from "./git-env.ts";
import { hardenedGitArgv } from "./work-driver-fix-pass-strays-target.ts";

export type DevelopBranchOutcome =
  /** Nothing to do: on a branch already, not a linked worktree, or not a repository. */
  | { kind: "unchanged" }
  | { kind: "corrected"; branch: string }
  | { kind: "refused"; reason: string };

/** The branch a detached developing tree is put on, named from its top level. */
export function developBranchName(topLevel: string): string {
  return `wt/${path.basename(topLevel)}`;
}

const errText = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown };
  return String(e?.stderr || e?.message || err).trim();
};

export async function ensureDevelopBranch(cwd: string): Promise<DevelopBranchOutcome> {
  const env: Record<string, string | undefined> = { ...process.env };
  scrubGitLocation(env);
  const git = async (args: string[]) =>
    (await execp("git", { argv: hardenedGitArgv(args), cwd, env, timeout: 30_000 })).stdout.trim();
  let dirs: string[];
  try {
    dirs = (
      await git([
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
        "--show-toplevel",
      ])
    )
      .split("\n")
      .map((d) => d.trim());
  } catch {
    return { kind: "unchanged" };
  }
  if (dirs[0] === dirs[1] || !dirs[2]) return { kind: "unchanged" };
  // The tree's own name, not the cwd's: a subdirectory cwd would otherwise name
  // every tree after the same directory, and git refuses the second checkout.
  const branch = developBranchName(dirs[2]);
  try {
    // Both `-q` probes exit 1 with no output for "no such ref"; any other failure is not an answer.
    const quiet = (args: string[]) =>
      git(args).catch((err: unknown) => {
        const e = err as { code?: unknown; stderr?: unknown };
        if (e.code === 1 && String(e.stderr ?? "").trim() === "") return "";
        throw err;
      });
    if ((await quiet(["symbolic-ref", "--short", "-q", "HEAD"])) !== "")
      return { kind: "unchanged" };
    const existing = await quiet(["rev-parse", "-q", "--verify", `refs/heads/${branch}`]);
    if (existing) {
      const contained = await git(["merge-base", "--is-ancestor", existing, "HEAD"]).then(
        () => true,
        () => false,
      );
      if (!contained) {
        return {
          kind: "refused",
          reason: `${cwd} is on a detached HEAD and branch ${branch} already holds commits that HEAD does not; refusing to move it. Put the worktree on a branch of its own (git -C ${cwd} switch -c <branch>) and dispatch again.`,
        };
      }
    }
    await git(["checkout", "-q", "-B", branch, "HEAD"]);
    const now = await quiet(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (now !== branch) throw new Error(`HEAD is on ${now || "no branch"} after the checkout`);
  } catch (err) {
    return {
      kind: "refused",
      reason: `${cwd} is on a detached HEAD and could not be put on branch ${branch}: ${errText(err).slice(0, 300)}`,
    };
  }
  return { kind: "corrected", branch };
}

/**
 * The developer-dispatch gate: throws on a refusal (the dispatch must not
 * start), returns the line the caller reports when the tree was moved.
 */
export async function prepareDevelopTree(
  role: string,
  cwd: string | undefined,
): Promise<string | undefined> {
  if (role !== "developer" || cwd === undefined) return undefined;
  const outcome = await ensureDevelopBranch(cwd);
  if (outcome.kind === "refused") throw new Error(`Refused: ${outcome.reason}`);
  if (outcome.kind === "unchanged") return undefined;
  return `The worktree ${cwd} was on a detached HEAD; it is now on branch ${outcome.branch}, so the reviews of this tree record against that branch.`;
}
