/**
 * work-driver-fix-pass-strays-target — #1846/#1849: the gates that decide
 * WHETHER a stray revert may run at all, kept apart from the revert itself so
 * each can be read (and tested) without a repo.
 *
 * `work-driver-fix-pass-strays.ts` is the destructive half: it preserves,
 * reverts and commits. Everything in this file answers the question that has to
 * be answered BEFORE any of that — is this the tree the driver owns for this
 * workstream, and is every path in it a path the driver may remove? Each gate
 * here is absolute: a refusal is a park with the tree untouched, never a partial
 * revert. They live together because a caller must not be able to reach the
 * destructive half while skipping one of them, and `preflight` in the strays
 * module is the only caller.
 *
 * The size split is the AGENTS.md §12 reason, not a design preference: the two
 * modules answer different questions and are gated differently — nothing here
 * destroys anything, and the record-naming half needs no repo at all.
 *
 * The RECORD NAMING (`fixPassStraysRef`, `fixPassStraysPatchPath`,
 * `nextStrayAttempt`) lives here too rather than in the destructive half, because
 * it is the other half of the same question — WHICH attempt's ref and patch this
 * revert may write, and into WHICH tree — and because the naming rules are pure
 * and testable without a repo. ONE literal spells the ref namespace
 * (`STRAY_REF_NAMESPACE`): the counter lists it and the ref writer builds it, so a
 * second copy that drifts makes the counter blind to the refs it exists to avoid.
 */

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { type GitExec, nextRetryAttempt, retryPatchPath } from "./work-develop-git.ts";
import { gitReadTimeoutMs } from "./work-driver-adversarial-fix-git.ts";
import type { FixPassStraysRequest } from "./work-driver-fix-pass-strays.ts";

/** The bound on every git call the revert makes, reads and writes alike: the
 *  fence's own read bound, so a hung revert is diagnosed inside the same budget as
 *  the fence that asked for it. An unbounded destructive call is worse than one
 *  that times out — it holds `index.lock` while it hangs, a second failure every
 *  later git call in the worktree inherits.
 *
 *  Declared here (next to its only git-reading caller) and re-exported by
 *  `work-driver-fix-pass-strays.ts`, which uses it for its own calls: one number,
 *  one definition, no import cycle between the two halves.
 */
export function gitWriteTimeoutMs(): number {
  return gitReadTimeoutMs();
}

/**
 * The worktree the revert was ASKED for must be the one the driver RECORDED for
 * this workstream — `pipelineState.worktrees[id]`, the value Step 3 wrote and
 * every later step reads — compared by realpath so a symlinked or differently
 * spelled root is not read as a different tree.
 *
 * WHY the recorded tree and not just any driver worktree: `assertInsideWorktrees`
 * proves a path lives under `.worktrees/`, which is a statement about the
 * namespace, not about ownership. `PassPlan.worktree` is a caller- and test-filled
 * field, and it is the one whose value decides which files `rm` and `checkout`
 * name. A plan built from a stale or cross-wired state therefore reverts a SIBLING
 * workstream's files while the pass reports a revert of its own strays — a
 * deletion in a tree that never produced them, with a `fix-pass-strays-reverted`
 * event that says otherwise.
 *
 * Throws (which `preflight` turns into the park reason) when either side cannot be
 * resolved: the lexical form of a path that does not exist is exactly what a wrong
 * tree looks like, so "could not tell" must not read as "fine".
 *
 * Exported for the test that builds a sibling worktree under `.worktrees/` and
 * asserts the refusal; the only production caller is `preflight`.
 */
export function assertInsideRecordedWorktree(req: FixPassStraysRequest): void {
  const recorded = req.recordedWorktree;
  if (recorded === undefined || recorded.trim() === "") {
    throw new Error(
      `no worktree is recorded for ${req.workstreamId}, so its out-of-fence files cannot be reverted (the fix pass never falls back to repoRoot)`,
    );
  }
  if (realOrThrow(req.worktree) !== realOrThrow(recorded)) {
    throw new Error(
      `the pass plan names ${req.worktree} but the driver records ${recorded} for ${req.workstreamId}`,
    );
  }
}

/**
 * The directory the untracked strays are unlinked from must resolve inside the
 * worktree this revert is gated to.
 *
 * `rmSync(…, { force: true })` does not care what its argument is: an absolute
 * path or one carrying `..` deletes outside the tree and reports success. The
 * strays reach it as fence-provided strings — a path shape that came from a
 * `git status` read, not from the plan — so the containment check is made here,
 * on the realpath of the parent directory, rather than assumed from the caller.
 * The path itself is already judged for shape by `plannedPathProblem`; this is
 * the containment half, which a shape check cannot express.
 */
export function assertRemovalInsideWorktree(req: FixPassStraysRequest, file: string): void {
  const worktree = realOrThrow(req.worktree);
  const target = resolve(req.worktree, file);
  // The FILE may not exist yet as a real path for its parent to resolve, so the
  // containment is judged on the parent directory — which is what gets deleted
  // anyway, and which always exists when there is something to unlink. A stray at
  // the worktree ROOT has the worktree itself as its parent, so equality counts:
  // requiring a strict prefix here refuses every root-level stray, which is the
  // common shape (the `scratch-notes.md` of every fixture in this suite).
  const parent = target.slice(0, target.lastIndexOf("/")) || worktree;
  const real = realOrSelf(resolve(parent));
  if (real !== worktree && !real.startsWith(`${worktree.replace(/\/$/, "")}/`)) {
    throw new Error(`refusing to remove ${file}: resolves outside ${worktree}`);
  }
}

/** `realpathSync` on a resolved path, throwing — a path nobody can point at is a
 *  refusal, never a pass. */
function realOrThrow(p: string): string {
  return realpathSync(resolve(p));
}

/** `realpathSync` when the path exists, its resolved lexical form otherwise — the
 *  same rule `assertInsideWorktrees` uses, so the two containment gates cannot
 *  disagree about a directory that has not been created yet. */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
/** The namespace every stray preservation lives in. ONE literal, because
 *  `nextStrayAttempt` lists it and `fixPassStraysRef` writes it: a second copy
 *  that drifts makes the counter blind to the refs it is meant to avoid. */
export const STRAY_REF_NAMESPACE = "refs/pi-rukas/fix-pass-strays";

/** The durable ref a revert preserves its pre-revert HEAD under. `attempt` is the
 *  NEXT FREE number (see `nextStrayAttempt`), never a literal 1, so a revert in a
 *  later pass cannot overwrite the earlier pass's ref — the only git-reachable copy
 *  of the content that revert deleted. */
export function fixPassStraysRef(issue: number, workstreamId: string, attempt: number): string {
  return `${STRAY_REF_NAMESPACE}/${issue}-${workstreamId}-${attempt}`;
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
 * BOTH halves move together deliberately. Deriving the ref from the event log and
 * the patch from the filesystem would let one of them roll back while the other
 * did not, which is a preserved ref whose patch is a different revert's. So the
 * number is the max over BOTH namespaces this revert owns — the patch files AND
 * the refs under `STRAY_REF_NAMESPACE` — because an attempt can leave a record in
 * one and not the other (it creates the patch first, then the ref, and either can
 * fail). An attempt that read only the patch directory would pick an N whose ref
 * already exists and overwrite it, destroying the only git-visible record of what
 * the first revert deleted.
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
  const refPrefix = `${STRAY_REF_NAMESPACE}/${issue}-${workstreamId}-`;
  let fromRef = fromPatch;
  try {
    const { stdout } = await git(
      ["for-each-ref", "--format=%(refname)", `${STRAY_REF_NAMESPACE}/`],
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
