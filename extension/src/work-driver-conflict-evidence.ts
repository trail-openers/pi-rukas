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

/**
 * #981 — neutralise a path for inline interpolation into a code span in
 * operator-facing text (a PR body, handoff, or park evidence). Strips
 * backticks (a backtick in the data would close the span and re-open
 * markdown interpretation of the remainder) and replaces CR/LF with a
 * visible marker (a newline would truncate a one-line string). Paths are
 * untrusted data (`git ls-files -u` output, `git rev-parse`-derived worktree
 * paths); the same helper serves both the rendered conflict path and the
 * repoRoot / worktree path interpolated into the `git -C <path> …` command
 * spans that tell the operator which command to run.
 */
export function inlineCodeSafe(p: string): string {
  return p.replace(/`/g, "").replace(/[\r\n]+/g, "⏎");
}

/**
 * #981 — render one operator-facing conflict path safely: in a code span
 * (the note lands in markdown — PR body, handoff, park evidence), with the
 * literal path's backticks stripped (a backtick in the data would close the
 * span and re-open markdown interpretation of the remainder) and CR/LF
 * replaced with a visible marker (a newline in the path would truncate a
 * one-line evidence string). `git ls-files -u` path data is untrusted.
 */
export function renderConflictPath(p: string): string {
  return `\`${inlineCodeSafe(p)}\``;
}

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

  // The conflicting file paths from repoRoot's index. Distinguish a read
  // FAILURE (ls-files errored — the index may be corrupt or git unavailable)
  // from an EMPTY result (the command succeeded and reported nothing — the
  // unmerged state may already be resolved, so the operator confirms with
  // `git status` instead of assuming a conflict to resolve).
  let paths: string[];
  let lsFilesFailed = false;
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
    lsFilesFailed = true;
    paths = [];
  }
  // Render each path safely for the operator-facing note (backtick / CR /
  // LF neutralised — see renderConflictPath). The raw paths array stays
  // unrendered for programmatic consumers.
  const rendered = paths.map(renderConflictPath).join(", ");

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

  // #981 — repoRoot is interpolated into a backtick command span below; a
  // backtick or newline in the path would break the span, so it is
  // sanitised via inlineCodeSafe.
  const safeRepoRoot = inlineCodeSafe(repoRoot);
  const pathsClause =
    paths.length > 0
      ? `Conflicting paths: ${rendered}.`
      : lsFilesFailed
        ? "Conflicting paths: (unreadable — git ls-files -u failed; run it in the repository root to see which files are in conflict)."
        : "Conflicting paths: (no unmerged paths in the index — the conflict may already be resolved; run git status to confirm).";
  const note = `${pathsClause} Fix commit's parent: ${fixParent ?? "unreadable"} | Branch tip: ${branchTip ?? "unreadable"}. Run \`git -C ${safeRepoRoot} status\` to see the conflicted files, resolve them, commit, and re-run.`;

  return { paths, fixParent, branchTip, note };
}
