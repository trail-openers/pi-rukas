/**
 * work-driver-fix-pass-strays-state — the ONE pre-revert read for a fix-pass
 * stray revert (#1849).
 *
 * Split out of `work-driver-fix-pass-strays.ts`, which is the destructive half:
 * it preserves and reverts, and every line of it is about doing that safely.
 * This file is the read that decides WHAT the revert may touch, and it is gated
 * differently — it never writes, and its failure modes are exactly the ones that
 * turn a revert into a deletion (an unreadable target read as "absent at
 * `headBefore`", which is the `git rm` branch).
 *
 * Two facts are read ONCE here and carried into the destructive steps rather
 * than re-read per step (which is how one path gets checked out and the next
 * deleted): which strays still exist on disk, and which existed at the pass's
 * pre-pass HEAD.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { errText, isValidBaseSha } from "./work-develop-git.ts";
import type { FixPassStraysRequest } from "./work-driver-fix-pass-strays.ts";
import { gitWriteTimeoutMs } from "./work-driver-fix-pass-strays.ts";

/**
 * The one read of the tree, taken before anything is touched.
 *
 * `present` / `trackedAtBefore` are the two facts every later step needs, and
 * reading them once (rather than per step, as the revert deletes files) is what
 * keeps the four stages — preserve, copy, revert, stage — working from one
 * picture.
 *
 * TWO rules the old shape broke, both about how absence is read out of git:
 *
 *   - the target is verified POSITIVELY first (`rev-parse --verify <sha>^{commit}`).
 *     A read that fails because the object, the rev or the repository is
 *     unreadable is indistinguishable from one that fails because the path is
 *     not in the tree — and the second of those routes the file to `git rm`. So
 *     a target that is not provably a commit refuses, and a failing tree read
 *     refuses, rather than arriving at "absent at `headBefore`";
 *   - the membership question is ONE `git ls-tree -r --name-only <sha> --
 *     <paths…>` instead of one `cat-file -e` per path. One call is one answer
 *     about one tree; N calls is N chances to disagree with each other, and N
 *     subprocesses to bound.
 */
export interface StrayState {
  strays: string[];
  /** Which strays still exist on disk right now. */
  present: Set<string>;
  /** Which strays the fence reported as untracked. */
  untracked: Set<string>;
  /** Which strays existed at the pass's pre-pass HEAD. */
  trackedAtBefore: Set<string>;
}

export type StrayStateResult = StrayState | { reason: string };

export async function readStrayState(req: FixPassStraysRequest): Promise<StrayStateResult> {
  const { git, worktree } = req;
  // `preflight` has already refused an absent or malformed target, so the head
  // is a 40-hex SHA by the time any git call reads it — but it is still
  // `string | undefined` on the request type, so the narrowing is named here
  // rather than cast at each call site.
  const headBefore = req.headBefore;
  if (headBefore === undefined || !isValidBaseSha(headBefore))
    return {
      reason: `the fix pass recorded no usable pre-pass HEAD for ${req.workstreamId}, so its out-of-fence files cannot be reverted to a known state — the pass is not reverted`,
    };
  const strays = [...req.strays];
  const present = new Set<string>();
  const untracked = new Set<string>();
  const trackedAtBefore = new Set<string>();
  for (const file of strays) {
    if (existsSync(join(worktree, file))) present.add(file);
    if (req.untracked.has(file)) untracked.add(file);
  }
  try {
    // Ask git that the target IS a commit before asking it what that commit
    // holds. Without this, an unreadable repository and an absent path both look
    // like "not in the tree", and "not in the tree" is the `git rm` branch.
    // `^{commit}` written as a plain string constant and concatenated, never
    // interpolated: inside a template literal git's own `{commit}` suffix reads
    // as a substitution.
    const peel = "^{commit}";
    await git(["rev-parse", "--verify", "--quiet", headBefore + peel], {
      cwd: worktree,
      timeout: gitWriteTimeoutMs(),
    });
  } catch (err) {
    return {
      reason: `the fix pass's recorded pre-pass HEAD ${headBefore} could not be verified as a commit in ${worktree}: ${errText(err)} — nothing was reverted rather than reverting toward a tree the driver cannot read`,
    };
  }
  if (strays.length > 0) {
    let listed: string;
    try {
      // `--name-only` because the mode and hash add nothing, `-r` so a tree
      // entry contributes its files, and the pathspec list bounds the read to
      // the strays. EMPTY output for a path is git's answer "not in this tree";
      // a git FAILURE is the distinct case this call separates out by throwing.
      //
      // #1849 item 9 — `--literal-pathspecs`: this read decides, per stray, whether
      // the revert CHECKS OUT the pre-pass content or `git rm`s the file. Without
      // it a stray whose name is also a glob (`c[1].ts`, `a*b.ts`) matches other
      // files in the tree, so a path that was absent at `headBefore` can be listed
      // as present — and get checked out from a commit that never held it. The same
      // flag is already on the `checkout`/`rm` calls in `revertPaths`; making the
      // READ literal is what keeps the two sides of one decision using one grammar.
      ({ stdout: listed } = await git(
        ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "--", headBefore, ...strays],
        { cwd: worktree, maxBuffer: 4 * 1024 * 1024, timeout: gitWriteTimeoutMs() },
      ));
    } catch (err) {
      return {
        reason: `the pre-pass tree of ${headBefore} could not be read in ${worktree}: ${errText(err)} — an unreadable tree is not proof that a file was absent before the pass, so nothing was reverted`,
      };
    }
    for (const line of listed.split("\n")) {
      if (line !== "" && strays.includes(line)) trackedAtBefore.add(line);
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
