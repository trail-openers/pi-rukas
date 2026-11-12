/**
 * write-fence-deletion-tokens — the reasons and the log tokens the child deletion
 * rule (#2200) reports with.
 *
 * Split out of write-fence-deletion.ts because the reader
 * (write-fence-deletion-positions.ts) and the hook both name them, and a reason
 * string that lives on one side of that seam and gets copied to the other is a
 * refusal text that drifts.
 *
 * Two invariants hold for everything here:
 *
 *   - a refusal names the RULE and never the TARGET — a target is an operator path
 *     and the cycle handoff is public;
 *   - the log's `path` field carries a fixed non-path token, so the driver's
 *     refusal count can tell the deletion rule's refusals apart without the log
 *     echoing where the child tried to delete.
 */

/** The log line's `path` field for a deletion. Never the target: the handoff is public. */
export const DELETION_LOG_TOKEN = "(deletion)";
/** The log line's `path` field for a `git clean` outside the child's roots. */
export const GIT_CLEAN_LOG_TOKEN = "(git clean)";
/** The log line's `path` field for a call the rule could not judge at all. */
export const NOT_JUDGED_LOG_TOKEN = "(not judged)";

/** Why a target inside no allowed root is refused. Names the rule, never the target. */
export const OUTSIDE_REASON =
  "it deletes outside your worktree, your scratch dir and your own temp dir. A shared temp root is never a delete target: report a quota or ENOSPC/EDQUOT failure instead of clearing it";

/** Why a command that does not lex is refused whole. */
export const UNREADABLE_REASON =
  "the command does not lex, so what it deletes cannot be judged. Run the deletion as its own command with literal paths";

/** Why a target that cannot be resolved is refused. */
export const UNRESOLVED_REASON =
  "its path could not be resolved (a symbolic link loop, or a parent this child cannot read), so the target cannot be judged";

/** Why a glob or brace list at a delete position is refused. */
export const GLOB_TARGET_REASON =
  "its path has a glob or a brace list, which expands to files this rule cannot check. Name each path literally";

/** Why an expansion at a delete position is refused. */
export const DYNAMIC_TARGET_REASON =
  "its path comes from a variable, a substitution or ~user, so the target cannot be judged. Name the path literally";
