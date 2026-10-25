/**
 * work-driver-diff-branch-file — reading a single file's content at the branch
 * tip, split from `work-driver-diff.ts` (AGENTS.md §12 file-size limit; #1634's
 * `readWorktreeDiff` gate pushed that module past the cap).
 *
 * The diff reads and the branch-file read answer different questions and have
 * different consumers: `lens-evidence.ts` pulls prose content through here, the
 * review gates pull diffs through `work-driver-diff.ts`. They share only the
 * argv-form git executor and its timeouts.
 */

import { execp } from "./exec.ts";
import { execGit } from "./git-range.ts";

/** A path that is safe to interpolate into a git command. */
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Read a file as it stands ON THE BRANCH, not in the working tree.
 *
 * This distinction is the whole reason the function exists. The reviewed diff
 * is built from `origin/<base>...origin/<branch>` (see `readIntegratedDiff`),
 * but lens children run with `cwd` set to a worktree, and under always-worktree
 * those "stay DETACHED at baseSha" — the invariant recorded at the bottom of
 * `readAllMergedDiffs`. (#1134: that range is three-dot, from the merge base.)
 * A reviewer that opens a changed file from its own cwd
 * therefore reads the version from BEFORE the change.
 *
 * That is not a hypothetical. A real cycle shipped a documentation paragraph
 * contradicting another paragraph 70 lines further down the same file, and no
 * lens reported it: the contradicting line was outside the diff, so it was
 * never in any reviewer's context, and opening the file would have shown the
 * pre-change text anyway.
 *
 * Returns undefined rather than throwing — an unreadable file means the
 * reviewer gets less evidence, never a fabricated finding.
 */
export async function readFileAtBranch(
  repoRoot: string,
  branchName: string,
  filePath: string,
): Promise<string | undefined> {
  if (!SAFE_PATH.test(filePath) || !SAFE_PATH.test(branchName)) return undefined;
  try {
    return await execGit(execp, repoRoot, ["show", `origin/${branchName}:${filePath}`], {
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}
