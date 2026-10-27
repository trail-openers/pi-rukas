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
 *   - the CONTENT is preserved by a durable ref at the pre-revert HEAD plus a
 *     binary patch of `headBefore..HEAD` for those paths, and — for files in no
 *     commit at all — a byte copy beside the patch.
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

import { existsSync } from "node:fs";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isPlainRepoRelativePath, plannedPathProblem } from "./plan-path-shape.ts";
import { trace } from "./trace.ts";
import {
  type GitExec,
  assertInsideWorktrees,
  errText,
  isValidBaseSha,
  nextRetryAttempt,
  retryPatchPath,
} from "./work-develop-git.ts";
import { gitReadTimeoutMs } from "./work-driver-adversarial-fix-git.ts";
import {
  assertFixPassStraysIndexPath,
  commitRevert,
} from "./work-driver-fix-pass-strays-commit.ts";
import {
  type StrayState,
  type StrayStateResult,
  readStrayState,
} from "./work-driver-fix-pass-strays-state.ts";

/**
 * The bound on every git call this module makes, reads and writes alike.
 *
 * The fix pass's own git reads are bounded by `gitReadTimeoutMs()` (30s) — the
 * same bound the fence's reads use, so a revert that hangs is diagnosed inside
 * the same budget as the fence that asked for it. A destructive command with no
 * bound is worse than one that times out: it holds `index.lock` while it hangs,
 * which is a second failure the next git call in the worktree inherits.
 */
export function gitWriteTimeoutMs(): number {
  return gitReadTimeoutMs();
}

/** The ref name a revert preserves its pre-revert HEAD under, for attempt `n`. */
function refFor(issue: number, workstreamId: string, attempt: number): string {
  return `refs/pi-rukas/fix-pass-strays/${issue}-${workstreamId}-${attempt}`;
}

/** The durable ref a revert preserves its pre-revert HEAD under.
 *  `attempt` is the NEXT FREE number (see `nextStrayAttempt`), never a literal 1,
 *  so a revert in a later pass of the same cycle cannot overwrite the earlier
 *  pass's ref — which would have destroyed the only git-reachable copy of the
 *  content its own revert deleted. */
export function fixPassStraysRef(issue: number, workstreamId: string, attempt: number): string {
  return refFor(issue, workstreamId, attempt);
}

/** The patch path a revert writes: a fixed name per (issue, workstream, attempt),
 *  so a later record can never clobber an earlier one. */
export function fixPassStraysPatchPath(
  scratchDir: string,
  issue: number,
  workstreamId: string,
  attempt: number,
): string {
  // Reusing `retryPatchPath` (the develop retry's own gate) rather than
  // re-spelling the check is what keeps the two preservation paths from
  // disagreeing about what a safe scratch filename is.
  return retryPatchPath(scratchDir, `fix-pass-strays-${issue}-${workstreamId}`, attempt);
}

/**
 * The attempt number this revert should use: one past the highest record that
 * already exists, so ref and patch always come in a matched pair and a second
 * revert (a later pass on the same issue and workstream) writes `-2`, never
 * `-1` again.
 *
 * Both halves move together deliberately. Deriving the ref from the event log
 * and the patch from the filesystem would let one of them roll back while the
 * other did not, which is a preserved ref whose patch is a different revert's.
 */
/**
 * The attempt number this revert should use: one past the highest record that
 * already exists, so ref and patch always come in a matched pair and a second
 * revert (a later pass on the same issue and workstream) writes `-2`, never
 * `-1` again.
 *
 * BOTH halves move together deliberately. Deriving the ref from the event log and
 * the patch from the filesystem would let one of them roll back while the other
 * did not, which is a preserved ref whose patch is a different revert's. So the
 * number is the max over BOTH namespaces this revert owns — the patches
 * (`fix-pass-strays-<issue>-<id>-N.patch`) AND the refs
 * (`refs/pi-rukas/fix-pass-strays/<issue>-<id>-N`) — because a revert can leave a
 * record in one and not the other: an earlier attempt that created its ref and
 * then failed before the patch write (or, before #1849 reordered the two, after
 * it) has a ref at N with no patch, and a next attempt that read only the patch
 * directory would pick N and collide with that ref, replacing the only git-visible
 * record of what the first revert deleted.
 */
export async function nextStrayAttempt(
  scratchDir: string,
  issue: number,
  workstreamId: string,
  git?: GitExec,
  worktree?: string,
): Promise<number> {
  // `retryPatchPath`'s id grammar is what the patch name embeds, so the same
  // gate decides the number and the name — `nextRetryAttempt` refuses an id it
  // cannot spell into a file, and `-<n>` is appended by that spell.
  const fromPatch = await nextRetryAttempt(scratchDir, `fix-pass-strays-${issue}-${workstreamId}`);
  if (git === undefined || worktree === undefined) return fromPatch;
  const refPrefix = `refs/pi-rukas/fix-pass-strays/${issue}-${workstreamId}-`;
  let fromRef = fromPatch;
  try {
    const { stdout } = await git(
      ["for-each-ref", "--format=%(refname)", "refs/pi-rukas/fix-pass-strays/"],
      { cwd: worktree, timeout: gitWriteTimeoutMs(), maxBuffer: 4 * 1024 * 1024 },
    );
    for (const line of stdout.split("\n")) {
      const name = line.trim();
      if (!name.startsWith(refPrefix)) continue;
      const n = Number(name.slice(refPrefix.length));
      if (Number.isInteger(n) && n >= 1) fromRef = Math.max(fromRef, n + 1);
    }
  } catch {
    // The ref namespace could not be read. The patch directory still bounds the
    // number, and a collision with an unreadable namespace then fails on `wx`
    // (a refusal) rather than on a silent overwrite — the safe direction.
  }
  return fromRef;
}

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
 * Preserve the strays, revert them, and commit the result.
 *
 * Returns the disclosure record on success or a refusal whose text becomes the
 * park reason. It NEVER reverts on a failed save: every step that can lose
 * content runs before a single path is touched, so a refusal always leaves the
 * worktree exactly as it arrived.
 */
export async function revertFixPassStrays(
  req: FixPassStraysRequest,
): Promise<FixPassReverted | FixPassRevertRefusal> {
  const refused = preflight(req);
  if (refused !== undefined) return { reason: refused };
  const { git, worktree, headBefore, issue, workstreamId, attempt } = req;
  // The tree is read ONCE, here, and every later decision — preserve, revert,
  // stage, commit — works from that snapshot. Asking git twice about the same
  // path ("is it tracked?", "does it exist?") across a revert that deletes files
  // is how one path gets checked out and the next staged from a stale answer.
  const state = await readStrayState(req);
  if ("reason" in state) return { reason: state.reason };
  if (headBefore === undefined)
    return { reason: "the fix pass recorded no usable pre-pass HEAD — nothing was reverted" };
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

  // 2 — revert the strays in two batched calls: one `checkout` for every path
  // that existed at `headBefore`, one `git rm` for every tracked path the pass
  // created. Untracked ones are unlinked (no git command can stage what git has
  // never been told about).
  const failed = await revertPaths(req, git, state);
  if (failed !== undefined) return { reason: failed };

  // 3 — ONE driver commit for the whole revert, built from a temporary index so
  // it can only ever name the revert's own paths. See `work-driver-fix-pass-strays-commit.ts`.
  const commit = await commitRevert(req, state);
  if (commit !== undefined) return { reason: commit };

  trace(
    `work-driver: fix pass reverted ${state.strays.length} out-of-fence file(s) for ${workstreamId} (preserved ${preservedRef}; patch ${patchPath}${untrackedCopies.length > 0 ? `; untracked copies ${untrackedCopies.length}` : ""})`,
  );
  return { paths: [...state.strays], preservedRef, patchPath, untrackedCopies };
}

/** The gates that make a revert safe to attempt at all; `undefined` = proceed.
 *  Nothing here touches git: every refusal is decided from the request, so a
 *  bad target or a bad path never reaches a destructive command. */
function preflight(req: FixPassStraysRequest): string | undefined {
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
  if (!isValidBaseSha(req.headBefore)) {
    return `the fix pass's recorded pre-pass HEAD for ${req.workstreamId} is not a full 40-hex SHA (${JSON.stringify(req.headBefore)}), so it cannot be a revert target — the pass is not reverted`;
  }
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
  return undefined;
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
  const { git, worktree } = req;
  const strays = state.strays;
  // Whether the ref was created, so a failure AFTER it can delete it again: an
  // orphan `refs/pi-rukas/fix-pass-strays/...` that points at a tree the driver
  // never reverted is a ref somebody will later trust as the record of a revert
  // that did not happen.
  let refCreated: string | undefined;
  try {
    const head = (
      await git(["rev-parse", "HEAD"], { cwd: worktree, timeout: gitWriteTimeoutMs() })
    ).stdout.trim();
    if (head === "") throw new Error("the worktree's HEAD could not be read");
    // The patch is written BEFORE the ref exists (#1849). Both writes are
    // non-destructive — neither touches the tree or the index — so the only thing
    // the order can cost is a record, and the order that costs nothing is the one
    // where a failure leaves nothing behind: the `wx` patch write is the step with
    // a real way to fail (an existing file, an unwritable scratch dir, an ENOSPC
    // mid-write), and it now runs while there is no ref to clean up. The previous
    // order created the ref first, so every patch-write failure stranded a ref.
    //
    // The patch is `headBefore` → the WORKING TREE, not `headBefore..HEAD`: a fix
    // pass ends with the developer's edits still uncommitted, and a HEAD-to-HEAD
    // diff would write a patch that silently omits every uncommitted line the
    // revert is about to delete. Diffing against the tree (no second rev) captures
    // the committed strays and the uncommitted ones in one record.
    const { stdout: diff } = await git(["diff", "--binary", headBefore, "--", ...strays], {
      cwd: worktree,
      maxBuffer: 64 * 1024 * 1024,
      timeout: gitWriteTimeoutMs(),
    });
    // The guard is based on what was ACTUALLY PRESERVED, not on the size of the
    // patch alone (#1849). A tracked stray is nothing but an addition or a
    // modification relative to `headBefore`, so an empty patch means the diff saw
    // no committed or uncommitted change for any path in a commit; the only form
    // that record can take then is a byte copy beside the patch, and there is one
    // per present untracked stray. So: every present stray must be covered by a
    // non-empty patch OR by being an untracked file sitting in the tree, and a
    // present stray covered by neither is the request failing to describe the tree
    // — which is how content gets deleted with no record of it.
    const preservedByPatch = diff.trim() !== "";
    const uncovered = [...state.present].filter(
      (f) => !preservedByPatch && !(state.untracked.has(f) && state.present.has(f)),
    );
    if (uncovered.length > 0) {
      throw new Error(
        `nothing to preserve — none of ${strays.join(", ")} differs from the pre-pass HEAD in the tree or the commits, and ${uncovered.map((f) => JSON.stringify(f)).join(", ")} is present but untracked-copyless`,
      );
    }
    // `wx`: never clobber an earlier revert's record.
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, diff, { flag: "wx" });
    // The patch is on disk; only now is the content reachable through a ref too.
    await git(["update-ref", preservedRef, head], {
      cwd: worktree,
      timeout: gitWriteTimeoutMs(),
    });
    refCreated = preservedRef;
    // The patch read above touched no index and `update-ref` touches no tree, so
    // the preserve step leaves the worktree byte-identical. It deliberately does
    // NOT reset the index: the revert commit stages exactly the paths it owns, and
    // a reset here would race the next git call for `index.lock`.
    return { ok: true };
  } catch (err) {
    // Undo the ref if it got created before something else failed, so a refused
    // preservation never leaves a ref behind that looks like a revert's record.
    if (refCreated !== undefined) {
      await git(["update-ref", "-d", refCreated], { cwd: worktree }).catch(() => undefined);
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
): Promise<string | undefined> {
  const { worktree } = req;
  const headBefore = req.headBefore ?? "";
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
      // stage or restore something git has never been told about.
      rmSync(join(worktree, file), { force: true });
    }
    if (restored.length > 0) {
      await git(["--literal-pathspecs", "checkout", headBefore, "--", ...restored], {
        cwd: worktree,
        timeout: gitWriteTimeoutMs(),
      });
    }
    if (created.length > 0) {
      await git(["--literal-pathspecs", "rm", "-q", "--force", "--", ...created], {
        cwd: worktree,
        timeout: gitWriteTimeoutMs(),
      });
    }
    return undefined;
  } catch (err) {
    return `reverting the fix pass's out-of-fence files in ${worktree} failed part-way: ${errText(err)} — the preserved ref and patch are intact, and nothing further was changed`;
  }
}
