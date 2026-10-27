/**
 * work-driver-fix-pass-strays — #1846: preserve the files one fix pass changed
 * outside its fence, then revert just those paths.
 *
 * WHY A SEPARATE PRESERVATION FROM `savePartialWork`. The develop retry saves
 * work that is UNCOMMITTED (`savePartialWork` stages it, then asserts
 * `git diff --cached <base>` is non-empty). A fix pass commits its own work
 * before the post-pass fence reads the tree, so a stray the pass committed has
 * nothing to stage: `git add` is a no-op and the diff-against-HEAD that
 * `savePartialWork` checks comes out empty — the save would refuse every real
 * stray. So this module keeps the two roles apart:
 *
 *   - the INDEX is left exactly as found (a `git reset` of the paths it touched),
 *   - the CONTENT is preserved by a durable ref at the pre-revert HEAD, a binary
 *     patch of `headBefore` against the working tree for those paths, and — for
 *     files in no commit at all — a byte copy beside the patch.
 *
 * The revert itself is PATH-SCOPED: `resetAndClean` is a whole-tree
 * `reset --hard` + `clean -fd`, which would destroy the pass's legitimate commits
 * alongside the strays. Here each path is restored from `headBefore` when it
 * existed there and removed when it did not, and the result is committed as one
 * driver-authored commit so the branch shows one reviewable revert.
 *
 * `headBefore` is the pass's own recorded pre-pass head, positively read at plan
 * time. A missing or unusable head means NO revert: "back to where it was" has no
 * referent, and guessing one (base, HEAD~1) would delete the pass's real work.
 *
 * Every command here is destructive, so the cwd is gated by
 * `assertInsideWorktrees` and the patch name by `retryPatchPath` (which keeps it
 * inside the scratch dir and rejects a workstream id that is not a plain path
 * component) before the first `git` runs.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isPlainRepoRelativePath, plannedPathProblem } from "./plan-path-shape.ts";
import { trace } from "./trace.ts";
import {
  type GitCallOpts,
  type GitExec,
  assertInsideWorktrees,
  errText,
  isValidBaseSha,
} from "./work-develop-git.ts";
import {
  assertFixPassStraysIndexPath,
  commitRevert,
  rollbackRevert,
} from "./work-driver-fix-pass-strays-commit.ts";
import { type StrayState, readStrayState } from "./work-driver-fix-pass-strays-state.ts";
import {
  assertInsideRecordedWorktree,
  assertRemovalInsideWorktree,
  fixPassStraysPatchPath,
  fixPassStraysRef,
  gitWriteTimeoutMs,
  hardenedGitArgv,
  nextStrayAttempt,
  revertGitEnv,
} from "./work-driver-fix-pass-strays-target.ts";

// The record-naming half lives with the other pre-revert decisions in
// `work-driver-fix-pass-strays-target.ts`; it is re-exported here because it is
// part of what a revert PRODUCES (the ref and patch a caller must be able to
// find), so importers of the revert ask the revert for both halves. The argv/env
// hardeners are re-exported for the same reason: they are part of how a revert
// talks to git, and a caller (or a test) that builds its own git call for the
// revert should not have to know the pair.
export {
  fixPassStraysPatchPath,
  fixPassStraysRef,
  gitWriteTimeoutMs,
  hardenedGitArgv,
  nextStrayAttempt,
  revertGitEnv,
};

/** Where the untracked strays' bytes are copied, beside the patch. */
export function fixPassStraysUntrackedDir(scratchDir: string): string {
  return join(scratchDir, "fix-pass-strays-untracked");
}

/** What the revert removed, for the event, the PR body and the park text. */
export interface FixPassReverted {
  paths: string[];
  preservedRef: string;
  patchPath: string;
  /** The untracked strays whose bytes were copied beside the patch. */
  untrackedCopies: string[];
}

/** Why the revert refused. `reason` is the park text; the tree is untouched. */
export interface FixPassRevertRefusal {
  reason: string;
}

export interface FixPassStraysRequest {
  /** The git transport, injected by the caller (`runGit(execFn)`). */
  git: GitExec;
  /** The workstream's worktree — the only tree this module touches. */
  worktree: string;
  /**
   * #1849 item 7 — the worktree the DRIVER recorded for this workstream
   * (`pipelineState.worktrees[id]`, written by Step 3 and read by every later
   * step). `worktree` is the value the pass plan carries, which is a
   * caller-/test-filled field; this is the one the cycle itself wrote. They must
   * name the same directory (by realpath) before anything destructive runs —
   * `assertInsideWorktrees` only proves a path is A driver worktree, so a stale
   * or cross-wired plan would otherwise revert a sibling workstream's files
   * while the pass reports a revert of its own strays. Absent means nothing was
   * ever recorded, which is a refusal, not a pass.
   */
  recordedWorktree?: string;
  /** The repo root the worktree hangs under (the `assertInsideWorktrees` gate). */
  repoRoot: string;
  /** The cycle's issue number, for the ref and patch names. */
  issue: number;
  workstreamId: string;
  /** How many reverts this workstream has already done (the `-<n>` suffix). */
  attempt: number;
  /** The pass's positively recorded pre-pass head. Absent means no revert. */
  headBefore?: string;
  /** The strays, exactly as the fence reported them. */
  strays: readonly string[];
  /** The untracked paths in the post-pass tree — decides removal vs checkout. */
  untracked: ReadonlySet<string>;
  /** The cycle's scratch dir: the patch and the untracked copies live here. */
  scratchDir: string;
}

/**
 * The narrowed revert target: `preflight`'s verdict on the recorded head, carried
 * to the rest of the revert so the 40-hex shape is proven ONCE.
 *
 * #1849 — the caller used to re-read `req.headBefore` after `preflight` and cast it
 * (`as string`), which claimed a narrowing nothing had established at that line,
 * and then guarded `=== undefined` again at a point `preflight` had already made
 * unreachable. Both were the same defect: the type did not carry what the gate had
 * decided. Returning the narrowed value here makes the guarantee flow through the
 * type instead of through a cast, and keeps `preflight` the single place that
 * decides what a usable target is.
 */
export interface FixPassRevertTarget {
  headBefore: string;
}

/**
 * The gates that make a revert safe to attempt at all; `undefined` = proceed.
 * Nothing here touches git: every refusal is decided from the request, so a
 * bad target or a bad path never reaches a destructive command.
 */
function preflight(req: FixPassStraysRequest): FixPassRevertTarget | string | undefined {
  if (req.headBefore === undefined || req.headBefore.trim() === "") {
    // #1846 PM decision 2 — with no positively recorded pre-pass head there is
    // no "back to", and inventing one (base, HEAD~1) would delete the pass's own
    // work. This is the park, never a revert with a guessed target.
    return `the fix pass recorded no usable pre-pass HEAD for ${req.workstreamId}, so its out-of-fence files cannot be reverted to a known state — the pass is not reverted`;
  }
  // The target must be a full SHA before a single git call reads it. `cat-file`
  // failing on a garbage rev and failing on an absent path look the same to a
  // caller that treats "unreadable" as "absent", and "absent" means `git rm`.
  // Shape first, so a malformed target is refused without asking git anything.
  // `isValidBaseSha` is a type predicate, so the value returned from here is
  // typed `string` — that is what lets the caller drop its cast.
  if (!isValidBaseSha(req.headBefore)) {
    return `the fix pass's recorded pre-pass HEAD for ${req.workstreamId} is not a full 40-hex SHA (${JSON.stringify(req.headBefore)}), so it cannot be a revert target — the pass is not reverted`;
  }
  const headBefore = req.headBefore;
  // Every stray path is judged before git sees it: these strings become argv
  // elements of `checkout`/`rm`/`add`, and a leading `-` or a glob character
  // turns one file argument into a flag or a pattern that matches other files.
  for (const file of req.strays) {
    const problem = plannedPathProblem(file);
    if (problem !== undefined)
      return `refusing to revert the fix pass's out-of-fence files: ${problem}`;
    if (!isPlainRepoRelativePath(file))
      return `refusing to revert the fix pass's out-of-fence files: '${file}' is not a plain repo-relative path`;
  }
  try {
    // Destructive commands run only in a driver-owned worktree, and the patch
    // name is validated before the first `git`.
    assertInsideWorktrees(req.repoRoot, req.worktree);
    assertInsideRecordedWorktree(req);
    fixPassStraysPatchPath(req.scratchDir, req.issue, req.workstreamId, req.attempt);
    // The temporary index the commit is built from is a path git resolves on its
    // own (`GIT_INDEX_FILE`), so it is judged here rather than at the call: a
    // relative one would resolve against each call's cwd, and one that escapes
    // its own directory is outside every guarantee this module makes. It is
    // gated to the SCRATCH dir, not to `.worktrees/` — the scratch dir lives
    // under the repo root, so the worktree gate cannot be the one that covers it.
    assertFixPassStraysIndexPath(req);
  } catch (err) {
    return `refusing to revert the fix pass's out-of-fence files: ${errText(err)}`;
  }
  return { headBefore };
}

/**
 * Preserve the strays, revert them, and commit the result.
 *
 * Returns the disclosure record on success or a refusal whose text becomes the
 * park reason. No refusal leaves the worktree alone: every step that can lose
 * content runs after `preserve`, and the one failure possible after the first
 * destructive call — the commit — restores the strays from that preservation
 * (`rollbackRevert`) instead of parking on a deletion.
 */
export async function revertFixPassStrays(
  req: FixPassStraysRequest,
): Promise<FixPassReverted | FixPassRevertRefusal> {
  const refused = preflight(req);
  if (typeof refused === "string") return { reason: refused };
  if (refused === undefined) {
    // `preflight` returns a target or a refusal; no third answer exists, but a
    // gate whose "pass" reading is the absence of a string is a gate that passes
    // on a bug in itself.
    return {
      reason: "the fix-pass stray revert's preflight produced neither a target nor a refusal",
    };
  }
  const { git, worktree, issue, workstreamId, attempt } = req;
  // The narrowed 40-hex target, established once by `preflight` (see
  // `FixPassRevertTarget`): no cast, and no second `=== undefined` guard for a
  // case the gate above already refused.
  const { headBefore } = refused;
  // The tree is read ONCE, here, and every later decision — preserve, revert,
  // stage, commit — works from that snapshot. Asking git twice about the same
  // path ("is it tracked?", "does it exist?") across a revert that deletes files
  // is how one path gets checked out and the next staged from a stale answer.
  const state = await readStrayState(req);
  if ("reason" in state) return { reason: state.reason };
  const strays = state.strays;
  const preservedRef = fixPassStraysRef(issue, workstreamId, attempt);
  const patchPath = fixPassStraysPatchPath(req.scratchDir, issue, workstreamId, attempt);

  // 1 — preserve, or refuse with the tree untouched.
  const saved = await preserve(req, headBefore, preservedRef, patchPath, state);
  if (!saved.ok) return { reason: saved.reason };
  const copied = copyUntracked(req, state);
  if (!copied.ok) {
    return {
      reason: `refusing to revert the fix pass's untracked out-of-fence files in ${worktree}: ${copied.reason} — an untracked file is in no commit, so without the copy this revert would be the only thing that ever held them`,
    };
  }
  const untrackedCopies = copied.paths;
  // `revertPaths` below is the FIRST call that destroys anything, so every refusal
  // so far leaves the tree exactly as it arrived. Past this line that is no longer
  // automatic, which is why the commit failure has a rollback.

  // 2 — revert the strays in two batched calls: one `checkout` for every path
  // that existed at `headBefore`, one `git rm` for every tracked path the pass
  // created. Untracked ones are unlinked (no git command can stage what git has
  // never been told about).
  const failed = await revertPaths(req, git, state, headBefore);
  if (failed !== undefined) return { reason: failed };

  // 3 — ONE driver commit for the whole revert, built from a temporary index so
  // it can only ever name the revert's own paths. See `work-driver-fix-pass-strays-commit.ts`.
  const commit = await commitRevert(req, state, headBefore);
  if (commit !== undefined) {
    // The destructive calls have already run, so the tree no longer holds what
    // the operator's fixer wrote — and the pass is about to park with a reason
    // that says "not reverted". A park that leaves the strays deleted is the
    // driver destroying work it only meant to move, so the tree is put back from
    // the preservation this module made minutes ago before the refusal is
    // returned. Whether that restore succeeded is stated in the reason: an
    // operator reading "not reverted" while the files are gone is worse than one
    // reading "restore also failed, here is the ref".
    const restored = await rollbackRevert(req, state, preservedRef, patchPath);
    return {
      reason: `${commit}${restored === undefined ? ` — the strays were restored from ${preservedRef}, so the worktree is as it arrived` : ` — RESTORING the strays from ${preservedRef} also failed (${restored}); the preserved ref, the patch${state.untracked.size > 0 ? " and the untracked copies" : ""} are the record of what is in the tree`}`,
    };
  }

  trace(
    `work-driver: fix pass reverted ${state.strays.length} out-of-fence file(s) for ${workstreamId} (preserved ${preservedRef}; patch ${patchPath}${untrackedCopies.length > 0 ? `; untracked copies ${untrackedCopies.length}` : ""})`,
  );
  return { paths: [...state.strays], preservedRef, patchPath, untrackedCopies };
}

/**
 * Write the durable ref and the patch BEFORE touching a single path.
 *
 * The ref points at the current HEAD, so a TRACKED stray that the pass COMMITTED
 * stays reachable as `git show <ref>:<path>` after the revert. The patch is the
 * record of `headBefore` against the WORKING TREE, which is the only form that
 * also holds a stray the developer left UNCOMMITTED — the ref cannot, because no
 * commit contains it. Each form covers what the other cannot, and the guard below
 * is what proves at least one of them actually did — per present path, not on the
 * patch's size alone. The ref is created AFTER the patch write, so a failed
 * preservation never strands a ref; the index is left as found: what this module
 * preserves is content, never a staged index the develop gate might otherwise read.
 */
async function preserve(
  req: FixPassStraysRequest,
  headBefore: string,
  preservedRef: string,
  patchPath: string,
  state: StrayState,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { worktree } = req;
  // One argv/env shape for every call this half makes, from the single hardened
  // pair in `work-driver-fix-pass-strays-target.ts`.
  const call = (args: string[], extra: Partial<GitCallOpts> = {}) =>
    req.git(hardenedGitArgv(args), {
      cwd: worktree,
      timeout: gitWriteTimeoutMs(),
      env: revertGitEnv(),
      ...extra,
    });
  // Whether the ref was created, so a failure AFTER it can delete it again: an
  // orphan ref pointing at a tree the driver never reverted is one somebody will
  // later trust as the record of a revert that did not happen.
  let refCreated: string | undefined;
  try {
    const head = (await call(["rev-parse", "HEAD"])).stdout.trim();
    if (head === "") throw new Error("the worktree's HEAD could not be read");
    const diff = await readStraysPatch(req, state, headBefore);
    // The guard asks what was ACTUALLY PRESERVED, not how big the patch is
    // (#1849). An empty patch means the diff saw no change — committed or not — for
    // any path; the only record that can then hold a present stray is the byte copy
    // `copyUntracked` makes, and it exists for exactly the untracked files. So every
    // present stray must be covered by a non-empty patch OR by being an untracked
    // file in the tree; one covered by neither is a request that fails to describe
    // the tree, which is how content gets deleted with no record of it.
    const preservedByPatch = diff.trim() !== "";
    const uncovered = [...state.present].filter(
      (f) => !preservedByPatch && !state.untracked.has(f),
    );
    if (uncovered.length > 0) {
      throw new Error(
        `nothing to preserve — none of ${state.strays.join(", ")} differs from the pre-pass HEAD in the tree or the commits, and ${uncovered.map((f) => JSON.stringify(f)).join(", ")} is present but untracked-copyless`,
      );
    }
    // `wx`: never clobber an earlier revert's record.
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, diff, { flag: "wx" });
    // Only now is the content reachable through a ref too.
    await call(["update-ref", preservedRef, head]);
    refCreated = preservedRef;
    // Neither write touches the tree, so preservation leaves the worktree
    // byte-identical, and it deliberately does NOT reset the index: the revert
    // commit stages exactly the paths it owns.
    return { ok: true };
  } catch (err) {
    // Undo the ref if it got created before something else failed, so a refused
    // preservation never leaves a ref behind that looks like a revert's record.
    if (refCreated !== undefined) {
      await call(["update-ref", "-d", refCreated]).catch(() => undefined);
    }
    // Nothing has been reverted yet, so the tree is exactly as it arrived. The
    // park says so: a preservation failure is the driver DECLINING the revert,
    // not a half-done one.
    return {
      ok: false,
      reason: `refusing to revert the fix pass's out-of-fence files in ${worktree}: they could not be preserved first — ${errText(err)}`,
    };
  }
}

/**
 * The revert's patch: `git diff --binary <headBefore> -- <strays>`.
 *
 * Against the WORKING TREE, not `headBefore..HEAD`: a fix pass ends with the
 * developer's edits still uncommitted, and a HEAD-to-HEAD diff silently omits every
 * uncommitted line the revert is about to delete. Diffing against the tree captures
 * both kinds in one record — the same blob `rollbackRevert` applies to put them
 * back, which is why nothing here parses it.
 */
async function readStraysPatch(
  req: FixPassStraysRequest,
  state: StrayState,
  headBefore: string,
): Promise<string> {
  const { stdout } = await req.git(
    hardenedGitArgv(["diff", "--binary", headBefore, "--", ...state.strays]),
    {
      cwd: req.worktree,
      maxBuffer: 64 * 1024 * 1024,
      timeout: gitWriteTimeoutMs(),
      env: revertGitEnv(),
    },
  );
  return stdout;
}

/**
 * Copy each untracked stray beside the patch, keeping its path relative to the
 * worktree, and VERIFY each copy before the caller is allowed to remove the
 * source. An untracked file exists in no commit, so a copy that silently came
 * out short is the revert destroying the only copy that ever held it; the
 * reason names WHICH file failed and how, because a refusal that cannot be
 * acted on is a park the operator cannot diagnose.
 */
function copyUntracked(
  req: FixPassStraysRequest,
  state: StrayState,
): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const copied: string[] = [];
  for (const file of state.strays) {
    if (!state.untracked.has(file) || !state.present.has(file)) continue;
    const source = join(req.worktree, file);
    const dest = join(fixPassStraysUntrackedDir(req.scratchDir), relative(req.worktree, source));
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    } catch (err) {
      return {
        ok: false,
        reason: `${JSON.stringify(file)} could not be copied to ${dest}: ${errText(err)}`,
      };
    }
    // The copy is the only record an untracked file has, so it is confirmed
    // against the source rather than trusted: same size, then same bytes.
    try {
      const src = readFileSync(source);
      const dst = readFileSync(dest);
      if (src.length !== dst.length || !src.equals(dst))
        return {
          ok: false,
          reason: `${JSON.stringify(file)} copied to ${dest} does not match the source (${dst.length} byte(s) against ${src.length})`,
        };
    } catch (err) {
      return {
        ok: false,
        reason: `${JSON.stringify(file)} could not be read back from ${dest} to confirm the copy: ${errText(err)}`,
      };
    }
    copied.push(file);
  }
  return { ok: true, paths: copied };
}

/**
 * Restore from `headBefore` every stray that existed there, and remove every
 * tracked stray the pass created — each in ONE batched call, so the number of
 * destructive git invocations does not grow with the stray list and one path
 * cannot be checked out while a sibling is removed by a half-applied loop.
 *
 * `--literal-pathspecs` makes a stray named like a glob (`c[1].ts`) one file
 * rather than a pattern over others. Tracked-vs-untracked comes from the
 * fence's own read (`treeChanges` merges `ls-files --others`), never from a
 * second question to git about the same file — two answers to "was this file
 * here" is how one path gets checked out and the next deleted.
 *
 * Returns `undefined` on success, the refusal text on the first failure. A
 * part-way failure is disclosed as such: the preserved ref and the patch are
 * already written, so the content survives either way.
 */
async function revertPaths(
  req: FixPassStraysRequest,
  git: GitExec,
  state: StrayState,
  headBefore: string,
): Promise<string | undefined> {
  const { worktree } = req;
  const call = (args: string[]) =>
    git(hardenedGitArgv(args), {
      cwd: worktree,
      timeout: gitWriteTimeoutMs(),
      env: revertGitEnv(),
    });
  const untrackedFiles = state.strays.filter((f) => state.untracked.has(f));
  const restored = state.strays.filter(
    (f) => !state.untracked.has(f) && state.trackedAtBefore.has(f),
  );
  const created = state.strays.filter(
    (f) => !state.untracked.has(f) && !state.trackedAtBefore.has(f),
  );
  try {
    for (const file of untrackedFiles) {
      // In no index at all: the unlink IS the removal, and no git command can
      // stage or restore something git has never been told about. The removal
      // target is checked back inside this worktree first — `rmSync` with
      // `force` deletes an absolute or `..`-carrying path and reports success,
      // and these path strings came from a `git status` read rather than the
      // plan, so containment is verified here and not assumed (#1849 item 9).
      assertRemovalInsideWorktree(req, file);
      rmSync(join(worktree, file), { force: true });
    }
    if (restored.length > 0) {
      await call(["--literal-pathspecs", "checkout", headBefore, "--", ...restored]);
    }
    if (created.length > 0) {
      await call(["--literal-pathspecs", "rm", "-q", "--force", "--", ...created]);
    }
    return undefined;
  } catch (err) {
    return `reverting the fix pass's out-of-fence files in ${worktree} failed part-way: ${errText(err)} — the preserved ref and patch are intact, and nothing further was changed`;
  }
}
