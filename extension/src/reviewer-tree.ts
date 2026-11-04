/**
 * reviewer-tree — the throwaway tree every reviewer child runs in (#1975).
 *
 * A reviewer has no `edit`/`write` tool, but its `bash` is unfenced: the write
 * fence arms for a reviewer only the #1879 dependency rule, which never judges
 * git. So a lens or adversarial child's experiments reached the reviewed
 * worktree itself — an untracked file at a PR worktree root, a stray branch
 * switch, unrelated files staged in the index that the next developer commit
 * swept in. Prompt-layer instructions ("use a private /tmp copy") are prose,
 * and prose is not enforcement (AGENTS.md §7.7).
 *
 * The mechanism is a directory the reviewer may destroy. One detached worktree
 * is created at the reviewed head before the batch's first spawn, becomes every
 * reviewer child's cwd, and is removed in the caller's `finally`. The reviewed
 * worktree keeps its files, its index, its HEAD and its branch: a child cannot
 * change what it was never given.
 *
 * Three rules the callers must keep:
 *
 *   - **The tree is created at a 40-char SHA, never a ref.** `HEAD` and a branch
 *     name resolve to whatever the reviewed tree holds at the moment of the
 *     creation, and a review must be able to name the commit it read. Callers
 *     resolve the head to an SHA before any spawn; this module refuses anything
 *     else — a ref would also let a leading dash reach git as an option.
 *   - **One tree per review batch, owned by the fan-out site**, not by the
 *     individual child: six lens children share one tree, and the adversarial
 *     loop's reviewer rounds share one. That is the smaller cost (one `worktree
 *     add`, one provisioning) and the shape that survives a mid-batch abort.
 *   - **Every failure falls back to the caller's tree** and says so. A review
 *     that cannot be isolated still gets run, with the reason traced and
 *     returned — the same fail-open-with-a-disclosed-reason rule as
 *     `plan-base-tree.ts`. A reviewer is a gate, and gate plumbing that cannot
 *     start must not cost the gate its answer.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isFullCommitSha } from "./commit-sha.ts";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { provisionWorktree } from "./worktree-provision.ts";

/**
 * The executor seam: the same shape `worktree-provision.ts` takes, so a test
 * drives this module against real temp repos with no model and no Pi child.
 * `argv` is part of the contract (see that module's header) — every git call
 * here passes the path as ONE argument and never through a shell re-parse.
 */
export type ReviewerTreeExecFn = (
  cmd: string,
  opts: { cwd?: string; maxBuffer?: number; timeout?: number; argv?: string[] },
) => Promise<{ stdout: string }>;

/** What {@link openReviewerTree} hands back, or why it did not.
 *
 * Every field is optional and the two shapes are told apart by `cwd`: a tree is
 * the only arm that carries one. That is deliberate — a caller that cannot
 * create the tree still has to run its review, so both arms are usable and
 * `release` is present whenever a tree exists. */
export type ReviewerTree = {
  /** The directory to spawn reviewer children in; absent when none was made. */
  cwd?: string;
  /** The 40-char commit that tree is detached at. */
  headSha?: string;
  /** Remove this tree. Best-effort; never throws. */
  release?: () => Promise<void>;
  /** Why this review runs unisolated (traced, and for the caller to record). */
  fallback?: string;
};

/** git's stderr when the process left some, else the error's message. */
function stderrOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "stderr" in err) {
    const s = (err as { stderr?: unknown }).stderr;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * git's administrative directory for `repoRoot`, as an absolute path.
 *
 * `--git-common-dir` and NOT `--git-dir`: from inside a linked worktree — which
 * is exactly what a reviewed `/work` tree is — `--git-dir` answers with that
 * worktree's own admin dir, so `worktree add` run from a worktree writes its
 * registration where nothing looks for it and the tree comes back detached at
 * the CURRENT head instead of the SHA asked for (observed: the reviewer's tree
 * landed at the reviewed tree's HEAD, with a commit the mutation had made).
 * `--git-common-dir` is the shared dir every worktree registers in, and passing
 * it explicitly makes the creation independent of the caller's own worktree.
 */
async function gitCommonDir(execFn: ReviewerTreeExecFn, repoRoot: string): Promise<string> {
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 8 * 1024,
    timeout: 10_000,
    argv: ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  });
  const commonDir = stdout.trim();
  if (commonDir === "") throw new Error("git printed no common dir");
  return commonDir;
}

/**
 * Open one throwaway tree detached at `headSha`.
 *
 * `repoRoot` is the clone whose object store the tree reads — for a reviewed
 * worktree that is the main checkout, which `rev-parse --git-common-dir`
 * reports from anywhere inside it. The tree itself lands under `$TMPDIR`, never
 * under the repo: a reviewer-created tree inside `.worktrees/` is read by the
 * harness's own sibling scan as an unregistered/dirty tree, which parks a cycle.
 *
 * Provisioning is best-effort (`provisionWorktree` never throws): a bare tree
 * has tracked files only, so a reviewer that runs the project's typecheck in an
 * unprovisioned tree would read a tree with no dependencies. A provisioning
 * problem is traced, not fatal — the reviewed diff arrives in the prompt.
 */
export async function openReviewerTree(
  execFn: ReviewerTreeExecFn,
  repoRoot: string,
  headSha: string,
): Promise<ReviewerTree> {
  // The operator's opt-out, the same shape as the destructive-git guard's
  // `PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT`: a review that must see the live tree
  // (an investigation of the worktree's own state) runs unisolated, and the
  // reason is disclosed rather than silent.
  if (process.env.PI_ENSEMBLE_REVIEWER_ISOLATION === "0") {
    return { fallback: "isolation disabled by PI_ENSEMBLE_REVIEWER_ISOLATION=0" };
  }
  if (!isFullCommitSha(headSha)) {
    const reason = `reviewer tree refused: ${JSON.stringify(headSha.slice(0, 40))} is not a 40-char commit SHA`;
    trace(`reviewer-tree: ${reason} — the reviewer runs in the reviewed tree`);
    return { fallback: reason };
  }
  let dir = "";
  try {
    const commonDir = await gitCommonDir(execFn, repoRoot);
    // Registrations whose directory is already gone (a run killed before its
    // `finally`), so a later `worktree add` never trips over them.
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      argv: ["--git-dir", commonDir, "worktree", "prune"],
    }).catch(() => undefined);
    dir = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "pi-rukas-review-")),
      `review-${randomBytes(8).toString("hex")}`,
    );
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
      argv: ["--git-dir", commonDir, "worktree", "add", "--detach", dir, headSha],
    });
  } catch (err) {
    if (dir) await removeReviewerTree(execFn, repoRoot, dir);
    const reason = `reviewer tree at ${headSha.slice(0, 12)} could not be created (${stderrOf(err).slice(0, 200)})`;
    trace(`reviewer-tree: ${reason} — the reviewer runs in the reviewed tree`);
    return { fallback: reason };
  }
  const provisioned = await provisionWorktree(execFn, repoRoot, dir).catch(() => undefined);
  if (provisioned?.problem) {
    trace(`reviewer-tree: provisioning incomplete — ${provisioned.problem}`);
  }
  return { cwd: dir, headSha, release: () => removeReviewerTree(execFn, repoRoot, dir) };
}

/**
 * Remove one throwaway tree, then prune. Best-effort: never throws.
 *
 * `--force` is the only modifier this issues, and the path is one this module
 * created in this call — never a caller-supplied directory, which is what makes
 * forcing safe. `git worktree remove` refuses a tree whose worktree-internal
 * HEAD differs from its registered HEAD, and a reviewer that committed or
 * switched branches has done exactly that, so forcing is not an optimisation
 * here — it is the only way the tree comes back. The `fs.rm` covers a tree whose
 * registration git already lost (a reviewer deleted its own tree from the
 * inside), and the trailing prune keeps the object store's admin list honest.
 */
export async function removeReviewerTree(
  execFn: ReviewerTreeExecFn,
  repoRoot: string,
  dir: string,
): Promise<void> {
  const rm = (argv: string[], timeout: number) =>
    execFn("git", { cwd: repoRoot, maxBuffer: 64 * 1024, timeout, argv }).catch(() => undefined);
  // Resolved here rather than passed in: removal must reach the same admin dir
  // creation did, and a caller that cannot answer that question still has a
  // directory of its own to hand back.
  const commonDir = await gitCommonDir(execFn, repoRoot).catch(() => undefined);
  const admin = commonDir === undefined ? ["-C", repoRoot] : ["--git-dir", commonDir];
  await rm([...admin, "worktree", "remove", "--force", dir], 60_000);
  await fs.rm(path.dirname(dir), { recursive: true, force: true }).catch(() => undefined);
  await rm([...admin, "worktree", "prune"], 10_000);
}

/**
 * Run `fn` with this review batch's isolated tree, releasing the tree however
 * `fn` ends — a spawn throw, an abort, a cap kill.
 *
 * Returns the caller's value, or `{ value, fallback }` naming why no isolation
 * was possible: the review still ran, in `fallbackCwd`.
 */
export async function withReviewerTree<T>(
  execFn: ReviewerTreeExecFn,
  repoRoot: string,
  headSha: string,
  fallbackCwd: string,
  fn: (cwd: string) => Promise<T>,
): Promise<{ value: T; fallback?: string }> {
  const tree = await openReviewerTree(execFn, repoRoot, headSha);
  if (!tree.cwd) return { value: await fn(fallbackCwd), fallback: tree.fallback };
  const cwd = tree.cwd;
  try {
    return { value: await fn(cwd) };
  } finally {
    await tree.release?.();
  }
}
