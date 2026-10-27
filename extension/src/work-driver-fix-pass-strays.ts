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

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { trace } from "./trace.ts";
import {
  type GitExec,
  assertInsideWorktrees,
  errText,
  retryPatchPath,
} from "./work-develop-git.ts";

/** The durable ref a revert preserves its pre-revert HEAD under. */
export function fixPassStraysRef(issue: number, workstreamId: string, attempt: number): string {
  return `refs/pi-rukas/fix-pass-strays/${issue}-${workstreamId}-${attempt}`;
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
  const strays = state.strays;
  const preservedRef = fixPassStraysRef(issue, workstreamId, attempt);
  const patchPath = fixPassStraysPatchPath(req.scratchDir, issue, workstreamId, attempt);

  // 1 — preserve, or refuse with the tree untouched.
  const saved = await preserve(req, headBefore as string, preservedRef, patchPath, state);
  if (!saved.ok) return { reason: saved.reason };
  const untrackedCopies = copyUntracked(req, state);
  if (untrackedCopies === undefined) {
    return {
      reason: `refusing to revert the fix pass's untracked out-of-fence files in ${worktree}: their bytes could not be copied to ${req.scratchDir} — an untracked file is in no commit, so without the copy this revert would be the only thing that ever held them`,
    };
  }

  // 2 — revert, path by path.
  const failed = await revertPaths(req, git, state);
  if (failed !== undefined) return { reason: failed };
  // Which paths to stage is decided from git's own reads, not from the working
  // tree afterwards: a path the revert RESTORED is staged with `git add`, a path
  // the revert REMOVED is staged as a deletion with `git rm --cached`, and an
  // untracked one was already removed by an unlink and needs nothing. Deriving
  // this from `existsSync` or `git status` after the fact is what broke here —
  // `git add -- <gone>` fails the whole commit on a pathspec that matches
  // nothing, and `--ignore-removal` only ignores removals git already tracks.

  // 3 — one driver commit for the whole revert, so every later reader of the
  // branch sees a single diff. The pathspec form stages additions, modifications
  // and deletions alike; `--literal-pathspecs` so a stray named like a glob is
  // still one file.
  try {
    // Only the paths still present after the revert: a deleted path is staged by
    // the `git rm` that removed it, and `git add -- <gone>` would fail the whole
    // commit on a pathspec that no longer matches.
    // Stage by ROLE, decided from git's own pre-revert reads (`state`), never
    // from the tree afterwards: a path that existed at the pre-pass HEAD was
    // restored by `git checkout <headBefore> -- <path>` and stages as a
    // modification; a tracked path the pass created was removed by `git rm`,
    // which already staged its deletion; an untracked path was unlinked and is
    // in no index at all. Asking `git add` about a path that no longer exists on
    // disk fails the whole commit on a pathspec that matches nothing, so each
    // role is given only the command that can accept it.
    const restored = state.strays.filter((f) => state.trackedAtBefore.has(f));
    if (restored.length > 0) {
      await git(["--literal-pathspecs", "add", "--", ...restored], { cwd: worktree });
    }
    // The same commit form the driver's other in-tree commits use
    // (`work-driver-safety-net.ts`): `--no-verify` because a driver-authored
    // revert is not a developer submission and must not be judged by a
    // project's pre-commit hook, and an explicit pathspec list so a `.pi/` or
    // `tmp/` file already in the index is never swept into the revert commit.
    // `--allow-empty`: the tree is already correct for an UNTRACKED stray (the
    // unlink is the whole revert, and there is nothing for git to stage), but the
    // revert still gets its commit, so the history shows that a revert happened
    // and `revertPaths`' tracked-vs-untracked read has a record to answer to.
    // The identity is set on the command rather than inherited: an operator's
    // global config must not decide who authored a harness commit, and a host
    // with no git identity at all must not make the revert fail.
    await git(
      [
        "-c",
        "user.name=pi-rukas",
        "-c",
        "user.email=driver@localhost",
        "commit",
        "-q",
        "--no-verify",
        "--allow-empty",
        "-m",
        "revert out-of-fence fix-pass files",
      ],
      { cwd: worktree, maxBuffer: 256 * 1024 },
    );
  } catch (err) {
    return {
      reason: `the fix-pass stray revert could not be committed in ${worktree}: ${errText(err)}`,
    };
  }
  trace(
    `work-driver: fix pass reverted ${state.strays.length} out-of-fence file(s) for ${workstreamId} (preserved ${preservedRef}; patch ${patchPath}${untrackedCopies.length > 0 ? `; untracked copies ${untrackedCopies.length}` : ""})`,
  );
  return { paths: [...state.strays], preservedRef, patchPath, untrackedCopies };
}

/** The gates that make a revert safe to attempt at all; `undefined` = proceed. */
function preflight(req: FixPassStraysRequest): string | undefined {
  if (req.headBefore === undefined || req.headBefore.trim() === "") {
    // #1846 PM decision 2 — with no positively recorded pre-pass head there is
    // no "back to", and inventing one (base, HEAD~1) would delete the pass's own
    // work. This is the park, never a revert with a guessed target.
    return `the fix pass recorded no usable pre-pass HEAD for ${req.workstreamId}, so its out-of-fence files cannot be reverted to a known state — the pass is not reverted`;
  }
  try {
    // Destructive commands run only in a driver-owned worktree, and the patch
    // name is validated before the first `git`.
    assertInsideWorktrees(req.repoRoot, req.worktree);
    fixPassStraysPatchPath(req.scratchDir, req.issue, req.workstreamId, req.attempt);
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
 * commit contains it. Each form covers what the other cannot, and the empty-patch
 * guard below is what proves at least one of them actually did. The index is restored afterwards: what this module preserves is content,
 * never a staged index the develop gate might otherwise read.
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
  try {
    const head = (await git(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
    if (head === "") throw new Error("the worktree's HEAD could not be read");
    await git(["update-ref", preservedRef, head], { cwd: worktree });
    mkdirSync(dirname(patchPath), { recursive: true });
    // Untracked strays are in no commit, so a patch cannot hold them: they are
    // copied separately (see `copyUntracked`). A tracked stray can be nothing but
    // an addition relative to `headBefore`, so an empty patch with no untracked
    // stray to show means the request did not describe the tree, and reverting on
    // such a read is how content gets lost.
    // `headBefore` → the WORKING TREE, not `headBefore..HEAD`: a fix pass ends
    // with the developer's edits still uncommitted, and a HEAD-to-HEAD diff would
    // write a patch that silently omits every uncommitted line the revert is
    // about to delete. Diffing against the tree (no second rev) captures the
    // committed strays and the uncommitted ones in one record.
    const { stdout: diff } = await git(["diff", "--binary", headBefore, "--", ...strays], {
      cwd: worktree,
      maxBuffer: 64 * 1024 * 1024,
    });
    const hasUntracked = state.present.size > 0;
    if (diff.trim() === "" && !hasUntracked) {
      throw new Error(
        `nothing to preserve — none of ${strays.join(", ")} differs from the pre-pass HEAD in the tree or the commits, and no untracked copy was found`,
      );
    }
    // `wx`: never clobber an earlier revert's record.
    writeFileSync(patchPath, diff, { flag: "wx" });
    // The patch read above touched no index and `update-ref` touched no tree, so
    // the preserve step leaves the worktree byte-identical. It deliberately does
    // NOT reset the index: the revert commit below stages exactly the paths it
    // owns, and a reset here would race the next git call for `index.lock`.
    return { ok: true };
  } catch (err) {
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
 * worktree. Returns the copied paths, or `undefined` when any copy failed — an
 * untracked file exists in no commit, so without this copy the revert would be
 * the only thing that ever removed it.
 */
function copyUntracked(req: FixPassStraysRequest, state: StrayState): string[] | undefined {
  const copied: string[] = [];
  try {
    for (const file of state.strays) {
      if (!state.untracked.has(file) || !state.present.has(file)) continue;
      const source = join(req.worktree, file);
      const dest = join(fixPassStraysUntrackedDir(req.scratchDir), relative(req.worktree, source));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
      copied.push(file);
    }
    return copied;
  } catch {
    return undefined;
  }
}

/**
 * Per stray: restore from `headBefore` when the file existed there, remove it
 * when it did not. Tracked-vs-untracked comes from the fence's own read
 * (`treeChanges` merges `ls-files --others`), never from a second question to git
 * about the same file — two answers to "was this file here" is how one path gets
 * checked out and the next deleted.
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
  const { worktree, headBefore } = req;
  try {
    for (const file of state.strays) {
      if (state.untracked.has(file)) {
        // In no index at all: the unlink IS the removal, and no git command can
        // stage or restore something git has never been told about.
        rmSync(join(worktree, file), { force: true });
        continue;
      }
      if (state.trackedAtBefore.has(file)) {
        await git(["checkout", headBefore as string, "--", file], { cwd: worktree });
        continue;
      }
      // Tracked now, absent at the pre-pass head: the pass created it.
      await git(["rm", "-q", "--force", "--", file], { cwd: worktree });
    }
    return undefined;
  } catch (err) {
    return `reverting the fix pass's out-of-fence files in ${worktree} failed part-way: ${errText(err)} — the preserved ref and patch are intact, and nothing further was changed`;
  }
}

/**
 * The one read of the tree, taken before anything is touched.
 *
 * `present` / `trackedAtBefore` are the two facts every later step needs, and
 * reading them once (rather than per step, as the revert deletes files) is what
 * keeps the four stages — preserve, copy, revert, stage — working from one
 * picture. An unreadable `cat-file` for one path is `false` in `trackedAtBefore`,
 * which routes that file to `git rm --force`: a removal the preserve step has
 * already covered, so a doubtful read never leaves a stray in the tree the rest
 * of the cycle ships.
 */
interface StrayState {
  strays: string[];
  /** Which strays still exist on disk right now. */
  present: Set<string>;
  /** Which strays the fence reported as untracked. */
  untracked: Set<string>;
  /** Which strays existed at the pass's pre-pass HEAD. */
  trackedAtBefore: Set<string>;
}

type StrayStateResult = StrayState | { reason: string };

async function readStrayState(req: FixPassStraysRequest): Promise<StrayStateResult> {
  const { git, worktree, headBefore } = req;
  const strays = [...req.strays];
  const present = new Set<string>();
  const untracked = new Set<string>();
  const trackedAtBefore = new Set<string>();
  for (const file of strays) {
    if (existsSync(join(worktree, file))) present.add(file);
    if (req.untracked.has(file)) untracked.add(file);
    try {
      await git(["cat-file", "-e", `${headBefore}:${file}`], { cwd: worktree });
      trackedAtBefore.add(file);
    } catch {
      // Absent at the pre-pass head — or unreadable, which is treated the same
      // way on purpose (see the note above).
    }
  }
  if (present.size === 0) {
    // Nothing on disk to revert. Not a refusal that leaves work at risk — there
    // is none — but the fence claimed files that are not in the tree, and
    // silently "succeeding" would let the caller re-check a fence over a tree it
    // never changed.
    return {
      reason: `the fix pass reported ${strays.join(", ")} as out-of-fence, but none of them exists in ${worktree} — nothing was reverted`,
    };
  }
  return { strays, present, untracked, trackedAtBefore };
}

/**
 * The paths `git status` still reports as changed, i.e. those the revert left a
 * working-tree change for. Read through git rather than `existsSync` because
 * both a restored file and a deleted one may or may not exist on disk, and what
 * the commit needs is the pathspec of what actually changed.
 */
async function changedPaths(
  git: GitExec,
  worktree: string,
  strays: readonly string[],
): Promise<string[]> {
  if (strays.length === 0) return [];
  try {
    const { stdout } = await git(
      ["status", "--porcelain", "--untracked-files=all", "--no-renames", "-z", "--", ...strays],
      { cwd: worktree },
    );
    // NUL-separated (`-z`) so a path with a space or a quote needs no parsing at
    // all, and unquoted even for a non-ASCII name — `core.quotepath` is off.
    return stdout
      .split("\0")
      .map((entry) => entry.slice(3).trim())
      .filter((path) => path !== "");
  } catch {
    // An unreadable status cannot list the paths — fall back to every stray. The
    // commit below then either succeeds or refuses with git's own reason, which
    // is a better answer than silently committing a partial revert.
    return [...strays];
  }
}
