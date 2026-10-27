/**
 * work-driver-fix-pass-strays-commit — the revert's COMMIT, built from a
 * temporary index so it can only ever name the revert's own paths (#1849).
 *
 * Split from `work-driver-fix-pass-strays.ts`, which is the destructive half,
 * for the same reason `work-driver-fix-pass-strays-state.ts` was split: this is
 * the step whose whole job is "commit exactly this set and nothing else", and
 * that question has its own failure modes, its own bound, and its own tests.
 *
 * THE BUG THIS CLOSES. The revert used to end in a bare `git commit` with no
 * pathspec, which commits **whatever is in the index**. The index is not the
 * revert's property: a develop gate, a corrective round or an earlier step can
 * leave content staged, and then it ships inside a commit whose subject says
 * "revert out-of-fence fix-pass files" — a driver commit that quietly lands
 * somebody else's work under a message that says the opposite. Reproduced
 * before this change: with one foreign file pre-staged, the revert commit's
 * `--name-only` list came back as
 * `[helper.ts, pre-staged-by-somebody-else.ts]`.
 *
 * THE TWO WAYS OUT, and why only the second works:
 *
 *   - **refuse if the index names anything outside the strays** (a preflight read
 *     of `git diff --cached --name-only`). Wrong in both directions. It refuses a
 *     pass for staging something the driver itself staged; and it cannot see the
 *     case that matters, because a stray whose deletion is already staged makes
 *     `diff --cached` report the *stray* — which IS inside the allowed set — while
 *     the rest of the index rides along unnoticed. A read of the index cannot
 *     bound a commit of the index.
 *   - **build the commit from an index that is the revert's alone** (what this
 *     does; the shape `savePartialWork` uses for the same reason): `read-tree HEAD`
 *     into a file nobody else uses, stage ONLY the revert's paths into it,
 *     `write-tree`, `commit-tree`, `update-ref`. The real index is never opened
 *     for writing, so whatever it holds cannot enter the commit — bounded by
 *     construction rather than by a check that might miss something. Measured: the
 *     commit lists `[helper.ts]` while the real index still reports the foreign
 *     file staged, untouched.
 *
 * `GIT_INDEX_FILE` goes through the executor's `env` option, never a shell
 * prefix: this transport is argv (`GitExec`) and a prefix would be the first
 * shell string the revert ever builds. The path is absolute before git sees it —
 * a relative one resolves against each call's cwd, so the five calls below would
 * get five different "indexes".
 *
 * THE TEMP INDEX IS SEEDED FROM **HEAD**, not from `headBefore` and not from the
 * real index. From `headBefore` it drops every entry the cycle added between the
 * two, and `read-tree` from an unrelated commit silently DELETES those paths from
 * the index — so the "revert" would delete the pass's own fix, the exact loss
 * this module exists to prevent (measured: seeding from `headBefore` produced a
 * commit whose `--name-only` list was `[a.txt, helper.ts]`). The real index is no
 * seed either: it holds the foreign content this commit must not carry, and
 * "copy it and subtract" is a list of everything the author forgot.
 */

import { copyFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { WORKSTREAM_ID_RE, errText } from "./work-develop-git.ts";
import type { StrayState } from "./work-driver-fix-pass-strays-state.ts";
import type { FixPassStraysRequest } from "./work-driver-fix-pass-strays.ts";
import { fixPassStraysUntrackedDir, gitWriteTimeoutMs } from "./work-driver-fix-pass-strays.ts";

/** Resolve symlinks when the path exists; a path that does not exist keeps its
 *  lexical form. Same rule `assertInsideWorktrees` uses, so the two containment
 *  gates cannot disagree about a path that is not created yet (the temp index is
 *  judged before it exists). */
const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Throws unless `path` resolves (symlinks included) strictly inside `dir`. */
function assertInsideDir(dir: string, path: string): void {
  const root = realOrSelf(resolve(dir)) + sep;
  if (!realOrSelf(resolve(path)).startsWith(root)) {
    throw new Error(`refusing temp index ${path}: not inside ${root}`);
  }
}

/**
 * The temporary index the revert's commit is built from: the cycle's scratch dir,
 * beside the patch (never the repo root, never a `tmp/` a build might sweep), and
 * removed afterwards whether the commit landed or not.
 *
 * Absolute by construction, for the reason in the module header. The workstream
 * id is checked against the same grammar `retryPatchPath` enforces for the patch,
 * so an id that cannot be spelled into a file name cannot be spelled into an index
 * name either — and `..` cannot ride in on it.
 *
 * Exported because `preflight` has to gate it and a test has to point at it;
 * neither should re-spell the name and get to disagree with the writer.
 */
export function fixPassStraysIndexPath(
  scratchDir: string,
  issue: number,
  workstreamId: string,
  attempt: number,
): string {
  if (!WORKSTREAM_ID_RE.test(workstreamId)) {
    throw new Error(
      `refusing temp index path: workstream id ${JSON.stringify(workstreamId)} is not a plain name`,
    );
  }
  return join(resolve(scratchDir), `fix-pass-strays-index-${issue}-${workstreamId}-${attempt}`);
}

/**
 * Gate the temp index path before any git call sees it. Called from the revert's
 * preflight, so a bad scratch path is a refusal that touches nothing. The path is
 * judged against its own directory (the scratch dir), because the scratch dir
 * lives under the repo ROOT — the `.worktrees/` gate cannot be the one that covers
 * a file inside it.
 */
export function assertFixPassStraysIndexPath(req: FixPassStraysRequest): void {
  const path = fixPassStraysIndexPath(req.scratchDir, req.issue, req.workstreamId, req.attempt);
  assertInsideDir(dirname(path), path);
}

/**
 * Build and install the revert's single commit. Returns `undefined` on success or
 * the refusal text; on refusal nothing about the commit happened (the preserved
 * ref and patch are already written, so the content survives either way).
 *
 * An all-untracked stray set changes no tree, and the commit is still written —
 * that is what `--allow-empty` was for on the old form: the history shows a revert
 * happened, and `revertPaths`' tracked-vs-untracked read has a record to answer to.
 */
export async function commitRevert(
  req: FixPassStraysRequest,
  state: StrayState,
  headBefore: string,
): Promise<string | undefined> {
  const { git, worktree, issue, workstreamId, attempt } = req;
  // Which paths the commit may name, decided from git's OWN pre-revert reads
  // (`state`) and never from what happens to be staged. Three roles:
  const restored = state.strays.filter(
    (f) => !state.untracked.has(f) && state.trackedAtBefore.has(f),
  );
  const created = state.strays.filter(
    (f) => !state.untracked.has(f) && !state.trackedAtBefore.has(f),
  );
  // An untracked stray was in no index at all: it is simply absent from a
  // HEAD-seeded index, which IS its revert. `rm` on it would fail the pathspec and
  // take the whole commit with it, so it is deliberately not passed to any command.
  const tmpIndex = fixPassStraysIndexPath(req.scratchDir, issue, workstreamId, attempt);
  // A stale temp index from an earlier attempt would seed this commit with that
  // attempt's staging, so it is cleared before `read-tree` and again at the end.
  rmSync(tmpIndex, { force: true });
  const opts = { cwd: worktree, timeout: gitWriteTimeoutMs(), env: { GIT_INDEX_FILE: tmpIndex } };
  try {
    // Seed from the commit being reverted from — nothing else (see the header).
    await git(["read-tree", "HEAD"], opts);
    // Restored paths: the working tree holds their `headBefore` content (the
    // `checkout` in `revertPaths` put it there), so `add` stages exactly that.
    if (restored.length > 0) await git(["--literal-pathspecs", "add", "--", ...restored], opts);
    // Paths the pass created and the revert deleted: `git rm` removed them from the
    // REAL index and the tree, but this index was seeded from HEAD where they exist,
    // so their deletion has to be staged here too.
    if (created.length > 0)
      await git(["--literal-pathspecs", "rm", "-q", "--force", "--", ...created], opts);
    const { stdout: treeOut } = await git(["write-tree"], opts);
    const tree = treeOut.trim();
    if (!/^[0-9a-f]{40}$/.test(tree))
      throw new Error(`write-tree returned ${JSON.stringify(tree.slice(0, 40))}`);
    // The identity is set on the command rather than inherited: an operator's
    // global config must not decide who authored a harness commit, and a host with
    // no git identity at all must not make the revert fail. `commit-tree` runs no
    // hook, so the old `--no-verify` is not needed — a project's pre-commit hook
    // cannot judge a driver-authored revert.
    const { stdout: commitOut } = await git(
      [
        "-c",
        "user.name=pi-rukas",
        "-c",
        "user.email=driver@localhost",
        "commit-tree",
        tree,
        "-p",
        "HEAD",
        "-m",
        "revert out-of-fence fix-pass files",
      ],
      opts,
    );
    const commit = commitOut.trim();
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new Error(`commit-tree returned ${JSON.stringify(commit.slice(0, 40))}`);
    // Move the checked-out branch to it WITHOUT touching the working tree — which
    // is what makes this safe beside a concurrent step, and why the tree needs no
    // reconciliation: `revertPaths` already restored or deleted every path, and
    // nothing outside them was touched.
    await git(["update-ref", "HEAD", commit], opts);
    return undefined;
  } catch (err) {
    return `the fix-pass stray revert could not be committed in ${worktree}: ${errText(err)} — target ${headBefore.slice(0, 12)}; the preserved ref and patch are intact`;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

/**
 * Put the tree back after a failure that happened AFTER the destructive calls.
 *
 * `revertPaths` deletes and restores; `commitRevert` runs after it. If the commit
 * cannot be built the pass parks — and a park whose reason says "not reverted"
 * while the driver has already deleted the files is the harness destroying work on
 * the way to telling the operator nothing happened. So the strays are put back
 * before the refusal is returned, in the order git itself can attest to:
 *
 *   1. every stray path back to its `headBefore` state (a `checkout` for the ones
 *      that existed there, a removal for the ones that did not) — the same baseline
 *      the patch was written against, so the next step is a clean apply;
 *   2. `git apply --binary <patchPath>` — the patch is exactly
 *      `git diff --binary <headBefore> -- <strays>` against the working tree, so
 *      applying it to the `headBefore` state reproduces the tree the revert found,
 *      committed lines and uncommitted ones alike. No hand-parsing of the patch:
 *      git wrote it, git reads it, and `--binary` keeps a binary stray's bytes;
 *   3. the untracked strays re-copied from the byte-verified copies beside the
 *      patch — they are in no commit and in no diff, so nothing else holds them;
 *   4. `git reset -q -- <strays>` to drop the staging `revertPaths` and the failed
 *      commit attempt left behind, so the index is as the pass handed it over.
 *
 * Returns `undefined` when the restore is complete, or the failure text. It never
 * throws: the revert already refused itself, and a rollback that cannot finish is
 * disclosed in the reason ("tree NOT restored; recover from …") rather than
 * turning one failure into two.
 */
export async function rollbackRevert(
  req: FixPassStraysRequest,
  state: StrayState,
  preservedRef: string,
  patchPath: string,
): Promise<string | undefined> {
  const { git, worktree } = req;
  const headBefore = req.headBefore;
  if (headBefore === undefined)
    return "no pre-pass HEAD was recorded, so the paths could not be put back";
  const tracked = state.strays.filter((f) => !state.untracked.has(f));
  // Paths absent at `headBefore` have nothing to check out: the revert deleted
  // them, so putting them back means leaving them deleted until step 2 recreates
  // them from the patch.
  const created = tracked.filter((f) => !state.trackedAtBefore.has(f));
  try {
    const toRestore = tracked.filter((f) => state.trackedAtBefore.has(f));
    if (toRestore.length > 0)
      await git(["--literal-pathspecs", "checkout", headBefore, "--", ...toRestore], {
        cwd: worktree,
        timeout: gitWriteTimeoutMs(),
      });
    if (created.length > 0)
      await git(
        ["--literal-pathspecs", "rm", "-q", "--force", "--ignore-unmatch", "--", ...created],
        { cwd: worktree, timeout: gitWriteTimeoutMs() },
      );
    await git(["apply", "--binary", patchPath], {
      cwd: worktree,
      timeout: gitWriteTimeoutMs(),
      maxBuffer: 64 * 1024 * 1024,
    });
    // The untracked strays were unlinked and live in no commit and no diff, so the
    // copies made beside the patch are the only thing that can put them back.
    for (const file of state.strays.filter((f) => state.untracked.has(f))) {
      if (!state.present.has(file)) continue;
      const src = join(
        fixPassStraysUntrackedDir(req.scratchDir),
        relative(worktree, join(worktree, file)),
      );
      const dest = join(worktree, file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    if (tracked.length > 0)
      await git(["--literal-pathspecs", "reset", "-q", "--", ...tracked], {
        cwd: worktree,
        timeout: gitWriteTimeoutMs(),
      });
    return undefined;
  } catch (err) {
    return `${errText(err)} — tree NOT restored; recover with \`git checkout ${preservedRef} -- <path>\` or by applying ${patchPath}`;
  }
}
