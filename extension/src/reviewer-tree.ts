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
 * The mechanism is a directory the reviewer may destroy, and it sits at ONE
 * choke point: every reviewer child — the six lens passes and the adversarial
 * reviewer — reaches git through `spawnSpecialist`, so that one call opens the
 * tree, points the child's `cwd` at it, and removes it in a `finally`. Nothing
 * in `lens-review*.ts` or `adversarial.ts` knows the tree exists.
 *
 * Three rules this module keeps:
 *
 *   - **A tree is created only for a caller-named cwd that is a git worktree.**
 *     No cwd, or a plain directory, is not ours to relocate.
 *   - **The tree is created at a 40-char SHA, never a ref.** `HEAD` answers with
 *     whatever the tree holds at the moment of creation, and a review must be
 *     able to name the commit it read.
 *   - **Every failure falls back to the caller's cwd** and says so (the same
 *     fail-open-with-a-disclosed-reason rule as `plan-base-tree.ts`). A reviewer
 *     is a gate; gate plumbing that cannot start must not cost the gate its
 *     answer. `PI_ENSEMBLE_REVIEWER_ISOLATION=0` is the operator's opt-out.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isFullCommitSha } from "./commit-sha.ts";
import { NO_HOOKS } from "./lean/specify-reset.ts";
import { trace, traceWarn } from "./trace.ts";
import { linkShareableDeps } from "./worktree-provision.ts";

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
 * The `kind` discriminant is the whole answer: a `tree` carries the directory
 * to spawn in and the one `release` that removes it; an `unisolated` carries
 * why, and a caller that reads `reason` makes the fail-open visible rather than
 * silent. */
export type ReviewerTree =
  | {
      kind: "tree";
      /** The directory to spawn reviewer children in. */
      cwd: string;
      /** Remove this tree. Best-effort; never throws. */
      release: () => Promise<void>;
    }
  | { kind: "unisolated"; reason: string };

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
 * the CURRENT head instead of the SHA asked for. `--git-common-dir` is the
 * shared dir every worktree registers in, and passing it explicitly makes the
 * creation independent of the caller's own worktree.
 */
async function gitCommonDir(execFn: ReviewerTreeExecFn, repoRoot: string): Promise<string> {
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 8 * 1024,
    // The same bound as `worktree remove`: this read sits on both the creation
    // path and the release path, and a git that hangs on a lock must not be the
    // one thing in the spawn's `finally` with no wall clock on it.
    timeout: 60_000,
    argv: [...NO_HOOKS, "-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  });
  const commonDir = stdout.trim();
  if (commonDir === "") throw new Error("git printed no common dir");
  return commonDir;
}

/**
 * Open one throwaway tree detached at `headSha`.
 *
 * `repoRoot` is the tree the reviewer would otherwise have run in; its object
 * store is the one the new tree reads. The tree itself lands under `$TMPDIR`,
 * never under the repo: a reviewer-created tree inside `.worktrees/` is read by
 * the harness's own sibling scan as an unregistered/dirty tree, which parks a
 * cycle.
 *
 * Provisioning is **symlinks only** (`linkShareableDeps`, not
 * `provisionWorktree`): a reviewer child runs the project's targeted checks, so
 * it needs `node_modules`, but the project's `.pi/worktree-setup` hook is
 * arbitrary code that must never run against a throwaway directory this module
 * created and the reviewer's bash can reach. A provisioning problem is traced,
 * not fatal — the reviewed diff arrives in the prompt.
 */
export async function openReviewerTree(
  execFn: ReviewerTreeExecFn,
  repoRoot: string,
  headSha: string,
): Promise<ReviewerTree> {
  // A tree this module cannot hand back is a fail-open, and a fail-open nobody
  // can see is a gate that quietly stopped being one: every arm below is
  // `traceWarn`-ed at the point the reviewer is put back in the reviewed tree.
  const unisolated = (reason: string): ReviewerTree => {
    traceWarn(`reviewer-tree: unisolated — ${reason}`);
    return { kind: "unisolated", reason };
  };
  // The operator's opt-out, the same shape as the destructive-git guard's
  // `PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT`: a review that must see the live tree
  // (an investigation of the worktree's own state) runs unisolated, and the
  // reason is disclosed rather than silent.
  if (process.env.PI_ENSEMBLE_REVIEWER_ISOLATION === "0") {
    return unisolated("isolation disabled by PI_ENSEMBLE_REVIEWER_ISOLATION=0");
  }
  if (!isFullCommitSha(headSha)) {
    return unisolated(
      `reviewer tree refused: ${JSON.stringify(headSha.slice(0, 40))} is not a 40-char commit SHA`,
    );
  }
  let dir = "";
  let commonDir = "";
  try {
    commonDir = await gitCommonDir(execFn, repoRoot);
    // Registrations whose directory is already gone (a run killed before its
    // `finally`), so a later `worktree add` never trips over them.
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      argv: [...NO_HOOKS, "--git-dir", commonDir, "worktree", "prune"],
    }).catch(() => undefined);
    // mkdtemp's directory IS the tree — git accepts an empty directory — so the
    // only path this module creates is the one `release` removes, and it is
    // created 0700: a throwaway tree that holds a checkout of the reviewed
    // project is not world-readable.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rukas-review-"));
    // Set explicitly rather than through a `mode` option: `fsPromises.mkdtemp`'
    // option bag is typed encoding-only, while the sync form takes a mode.
    await fs.chmod(dir, 0o700);
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
      argv: [...NO_HOOKS, "--git-dir", commonDir, "worktree", "add", "--detach", dir, headSha],
    });
  } catch (err) {
    if (dir) await removeReviewerTree(execFn, repoRoot, dir, commonDir);
    return unisolated(
      `reviewer tree at ${headSha.slice(0, 12)} could not be created (${stderrOf(err).slice(0, 200)})`,
    );
  }
  // `release` runs inside the spawn's `finally`, where a throw would replace
  // the child's own result (or its own error) with this module's. The whole
  // body — including the call that builds the removal's argv — sits in one
  // try/catch, so the guarantee does not outsource anything to
  // `removeReviewerTree`'s own discipline: an executor that THROWS rather than
  // rejects is a caught failure here, and a survivor is still named.
  const release = async (): Promise<void> => {
    try {
      await removeReviewerTree(execFn, repoRoot, dir, commonDir);
    } catch (err) {
      traceWarn(`reviewer-tree: release failed — ${stderrOf(err).slice(0, 200)}`);
    }
  };
  const provisioned = await linkShareableDeps(execFn, repoRoot, dir).catch(() => undefined);
  if (provisioned?.problem) {
    // An incomplete provision is a fail-open of the same kind as every other
    // arm here — the child that cannot run `bun test` is not a review that
    // verified anything — so it is WARN-visible, not DEBUG-gated.
    traceWarn(`reviewer-tree: provisioning incomplete — ${provisioned.problem}`);
  }
  return { kind: "tree", cwd: dir, release };
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
 * When `worktree remove` fails AND the directory is still there, the survivor is
 * traced by path: a leak nobody can see is a leak nobody fixes.
 *
 * `commonDir` is the admin dir {@link openReviewerTree} created the tree in, and
 * it is REQUIRED: an empty value means the caller could not resolve it, and
 * guessing the location of a registration is how a removal deletes the wrong
 * tree. The refusal still has to be visible, so it is traced and the directory
 * is left standing rather than half-removed.
 */
export async function removeReviewerTree(
  execFn: ReviewerTreeExecFn,
  repoRoot: string,
  dir: string,
  commonDir: string,
): Promise<void> {
  const rm = (argv: string[], timeout: number) =>
    execFn("git", { cwd: repoRoot, maxBuffer: 64 * 1024, timeout, argv }).catch(() => undefined);
  if (commonDir === "") {
    traceWarn(`reviewer-tree: git could not remove the throwaway tree at ${dir}`);
    return;
  }
  const admin = ["--git-dir", commonDir];
  // The removal's identity is what the branch below reads: a removal git
  // performed and reported (`{ stdout }`) is not the same answer as one that
  // threw, and only the second may leave a tree standing. The prune is issued
  // only by the path that removed the tree — a prune of a registration git
  // still holds would be dishonest about what is there, and the refused tree
  // must survive this function for the WARN to name it rather than be taken
  // away by the `fs.rm` that follows.
  const removed = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 64 * 1024,
    timeout: 60_000,
    argv: [...NO_HOOKS, ...admin, "worktree", "remove", "--force", dir],
  }).then(
    () => true,
    () => false,
  );
  if (!removed && (await exists(dir))) {
    traceWarn(`reviewer-tree: git could not remove the throwaway tree at ${dir}`);
    return;
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await rm([...NO_HOOKS, ...admin, "worktree", "prune"], 10_000);
}

/** Does this path still exist? A probe that failing too answers "gone". */
async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}
