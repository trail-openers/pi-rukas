/**
 * work-driver-conflict-evidence — #981: collect conflict-path evidence from
 * repoRoot's index after a cherry-pick conflict, and the two base SHAs for
 * the handoff. Extracted from work-driver-lens-fix-commit.ts to satisfy the
 * 500-line gate (AGENTS.md §12).
 *
 * The cherry-pick runs at repoRoot (not in the fixer's worktree), so the
 * unmerged files live in repoRoot's index. The evidence names the conflicting
 * paths, the fix commit's parent (the fixer's base, where the fix was built —
 * `HEAD~1` in the worktree, NOT the worktree's merge base with the branch),
 * and the branch tip it was being applied to — all in one string the handoff
 * can quote.
 */
import type { ExecFn } from "./worktree.ts";

export interface ConflictEvidence {
  /** The conflicting file paths, or empty when the read failed. */
  paths: string[];
  /** The fix commit's parent SHA (first 8 chars), or undefined when unreadable. */
  fixParent?: string;
  /** The branch tip SHA (first 8 chars), or undefined when unreadable. */
  branchTip?: string;
  /** The formatted evidence string (empty when there is no conflict). */
  note: string;
}

/**
 * Collect conflict evidence from repoRoot after a cherry-pick conflict.
 *
 * Reads `git ls-files -u` in repoRoot (the cherry-pick runs there, not in the
 * fixer's worktree), plus the worktree's base and the branch tip SHAs.
 * Returns an empty note when there is no conflict.
 */
export async function collectConflictEvidence(
  execFn: ExecFn,
  repoRoot: string,
  tree: string,
  isConflict: boolean,
): Promise<ConflictEvidence> {
  if (!isConflict) {
    return { paths: [], note: "" };
  }

  // The conflicting file paths from repoRoot's index.
  let paths: string[] = [];
  try {
    const { stdout: unmerged } = await execFn("git ls-files -u", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    paths = [
      ...new Set(
        unmerged
          .split("\n")
          .map((l) => l.trim().split("\t").pop() ?? l.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    // Could not read unmerged paths — the error text is still useful.
  }

  // The fix commit's parent — `HEAD~1` in the worktree is the parent of the
  // fix commit, i.e. the base the fixer built on. It is NOT the worktree's
  // merge base with the branch (that would be `git merge-base HEAD <branch>`),
  // so the field is named for what it actually reads.
  let fixParent: string | undefined;
  try {
    const { stdout: wtBase } = await execFn("git", {
      cwd: tree,
      maxBuffer: 64 * 1024,
      argv: ["rev-parse", "HEAD~1"],
    });
    fixParent = wtBase.trim().slice(0, 8);
  } catch {
    // Worktree has no parent commit (single-commit worktree).
  }

  // The branch tip it was being applied to.
  let branchTip: string | undefined;
  try {
    const { stdout: tip } = await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      argv: ["rev-parse", "HEAD"],
    });
    branchTip = tip.trim().slice(0, 8);
  } catch {
    // Could not read branch tip.
  }

  const note =
    paths.length > 0
      ? `Conflicting paths: ${paths.join(", ")}. Fix commit's parent: ${fixParent ?? "unreadable"} | Branch tip: ${branchTip ?? "unreadable"}. Run \`git -C ${repoRoot} status\` to see the conflicted files, resolve them, commit, and re-run.`
      : `Conflicting paths: (unreadable — run git ls-files -u in the repository root). Fix commit's parent: ${fixParent ?? "unreadable"} | Branch tip: ${branchTip ?? "unreadable"}. Run \`git -C ${repoRoot} status\` to see the conflicted files, resolve them, commit, and re-run.`;

  return { paths, fixParent, branchTip, note };
}
