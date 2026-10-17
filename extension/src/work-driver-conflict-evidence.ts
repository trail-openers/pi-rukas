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
 *
 * Also the operator-facing failure CAUSE for a lens-fix integration failure
 * (`lensFixConflictCause` + `CAUSE_BUDGET` + `MANUAL_REPAIR_HINT`): the
 * message and its budget live beside the evidence they render, so the budget
 * is derived from the bounded clause lengths rather than sized for one test
 * fixture.
 */
import { restoreClaimCeiling } from "./work-driver-restore-claim-budget.ts";
import { type VerifiedRestoreResult, restoreClaim } from "./work-driver-restore.ts";
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
  /**
   * Why `paths` is what it is — the discriminator `collectConflictEvidence`
   * already knows when it builds `note`, and callers branch on THIS rather
   * than matching the rendered note's prefix. A string-compare against a
   * rendered sentence breaks the moment the wording is edited; this field
   * cannot disagree with the note because both come from one branch. The
   * empty-note result (no conflict) is `"empty"`.
   */
  pathsRead: "paths" | "unreadable" | "empty";
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
    return { paths: [], pathsRead: "empty", note: "" };
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
  // unrendered for programmatic consumers; the clause renderer does the
  // length bound.

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
  const pathsRead: ConflictEvidence["pathsRead"] =
    paths.length > 0 ? "paths" : lsFilesFailed ? "unreadable" : "empty";
  const pathsClause = conflictPathsClause({ paths, pathsRead });
  const note = `${pathsClause} Fix commit's parent: ${fixParent ?? "unreadable"} | Branch tip: ${branchTip ?? "unreadable"}. Run \`git -C ${safeRepoRoot} status\` to see the conflicted files, resolve them, commit, and re-run.`;

  return { paths, pathsRead, fixParent, branchTip, note };
}

/** How many conflicting paths one clause names before it counts the rest. */
const PATHS_SHOWN = 10;
/** How long one raw path gets before it is cut with an ellipsis. */
const PATH_CHARS = 120;
/** Why git's own stderr is cut this short — see `applyReasonText`. */
const APPLY_REASON_CHARS = 160;
/** How much of the worktree path the cause message keeps. */
const TREE_PATH_CHARS = 200;

/** Cut one raw path to {@link PATH_CHARS} chars before it is code-spanned. */
function truncatePath(p: string): string {
  return p.length > PATH_CHARS ? `${p.slice(0, PATH_CHARS - 1)}…` : p;
}

/**
 * #981 — the ONE renderer for the conflicting-paths clause, bounded by
 * construction: each path is cut at {@link PATH_CHARS} characters and the
 * list names at most {@link PATHS_SHOWN} entries with a `(+K more)` tail, so
 * the clause has a fixed ceiling no index contents can exceed. That ceiling
 * is what makes {@link CAUSE_BUDGET} derivable rather than a number sized
 * for one fixture. Both consumers call this: the `note` above (which the
 * debug trace carries) and {@link lensFixConflictCause} below (the operator-
 * facing message). The three-way branch reads `pathsRead`, never the
 * rendered text.
 */
export function conflictPathsClause(e: Pick<ConflictEvidence, "paths" | "pathsRead">): string {
  if (e.pathsRead === "unreadable")
    return "Conflicting paths: (unreadable — git ls-files -u failed; run it in the repository root to see which files are in conflict).";
  if (e.paths.length === 0)
    return "Conflicting paths: (no unmerged paths in the index — the conflict may already be resolved; run git status to confirm).";
  const shown = e.paths.slice(0, PATHS_SHOWN).map((p) => renderConflictPath(truncatePath(p)));
  const more = e.paths.length > PATHS_SHOWN ? ` (+${e.paths.length - PATHS_SHOWN} more)` : "";
  return `Conflicting paths: ${shown.join(", ")}${more}.`;
}

/**
 * Why a patch-apply failure says what it says, bounded: the reason is
 * untrusted git stderr of unbounded length (`git apply` dumps every rejecting
 * hunk). Cut at {@link APPLY_REASON_CHARS} so the clauses that must survive —
 * the restore claim and the conflicting paths — are never pushed out.
 */
function applyReasonText(reason: string | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return "unknown";
  return trimmed.length > APPLY_REASON_CHARS
    ? `${trimmed.slice(0, APPLY_REASON_CHARS - 1)}…`
    : trimmed;
}

/**
 * The handoff text appended to every lens-fix integration failure claim.
 * The verified-restore claim alone ("repoRoot was restored …") leaves an
 * operator with no next step, and the not-restored variant must carry the
 * repair commands the issue's acceptance criteria require: a failed restore
 * is a more serious condition than the integration failure and names the
 * exact commands that return repoRoot to a usable state. Exported so the
 * cause builder and the test that sizes the budget read the SAME string.
 */
export const MANUAL_REPAIR_HINT =
  "If repoRoot is not usable, repair it with: git reset --hard && git checkout --force <the ref the cycle started from> (run `git status` and `git branch --show-current` to see the current state)";

/**
 * The worst-case length of `restoreClaim(r, { trailing: MANUAL_REPAIR_HINT })`
 * over any `VerifiedRestoreResult` whose fields came from the real producers.
 * Derived in work-driver-restore-claim-budget.ts from `restoreClaim`'s own
 * constants; a documented component of {@link CAUSE_BUDGET}.
 */
export const RESTORE_CLAIM_BUDGET = restoreClaimCeiling(MANUAL_REPAIR_HINT.length);

/**
 * #981 — how much of a lens-fix integration failure the caller keeps. It is
 * the SUM OF THE BOUNDED PARTS (each clause's ceiling is a constant in this
 * file or in work-driver-restore-claim-budget.ts), plus slack for the fixed
 * wording — not a number picked to fit one fixture. Each part is its own
 * `const` so the expression reads as its own derivation.
 * `test-work-driver-lens-fix-cause-budget.ts` asserts every shape the real
 * producers emit fits inside it, including the #1258 save-failure restore
 * with a 160-char git error and a long repoRoot.
 */
const APPLY_HEAD_MAX = 46 + APPLY_REASON_CHARS + 2;
const PATHS_CLAUSE_MAX = 19 + PATHS_SHOWN * (PATH_CHARS + 2) + 12;
const WORKTREE_CLAUSE_MAX = 44 + TREE_PATH_CHARS;
const SHAS_CLAUSE_MAX = 40 + 2 * 8;
const CAUSE_SPACES = 3;
const CAUSE_WORDING_SLACK = 96;
export const CAUSE_BUDGET =
  APPLY_HEAD_MAX +
  RESTORE_CLAIM_BUDGET +
  CAUSE_SPACES +
  PATHS_CLAUSE_MAX +
  WORKTREE_CLAUSE_MAX +
  SHAS_CLAUSE_MAX +
  CAUSE_WORDING_SLACK;

/**
 * #981 — the operator-facing cause of a lens-fix integration failure,
 * composed in the order the operator reads it: what failed, whether repoRoot
 * needs repair, WHICH FILES CONFLICT, then where the fix still lives and the
 * two SHAs to diff against. The conflicting-paths clause comes BEFORE the
 * long tail in BOTH arms — the patch-apply arm used to end with it, which is
 * exactly where a budget cut lands. The two short SHAs ride the message
 * (they were previously only in the debug-gated trace line, so an operator
 * reading the park evidence had neither). Exported so the test calls the
 * REAL builder for each restore shape instead of restating this template.
 */
export function lensFixConflictCause(opts: {
  kind: "conflict" | "apply";
  restore: VerifiedRestoreResult | undefined;
  evidence: Pick<ConflictEvidence, "paths" | "pathsRead">;
  tree: string;
  applyReason?: string;
  fixParent?: string;
  branchTip?: string;
}): string {
  const head =
    opts.kind === "conflict"
      ? "cherry-pick conflict — the batch was aborted."
      : `patch-apply failed for the lens-fix worktree: ${applyReasonText(opts.applyReason)}.`;
  const tree =
    opts.tree.length > TREE_PATH_CHARS ? `${opts.tree.slice(0, TREE_PATH_CHARS - 1)}…` : opts.tree;
  const shas = ` Fix commit's parent: ${opts.fixParent ?? "unreadable"} | Branch tip: ${opts.branchTip ?? "unreadable"}.`;
  return `${head} ${restoreClaim(opts.restore, { trailing: MANUAL_REPAIR_HINT })} ${conflictPathsClause(opts.evidence)} The fix's commits remain in the worktree ${tree}.${shas}`;
}
