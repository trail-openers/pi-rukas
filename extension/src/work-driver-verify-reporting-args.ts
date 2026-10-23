/**
 * work-driver-verify-reporting-args — the #1064 / #1324 arguments the develop
 * gate hands to the consolidated failure reporter.
 *
 * `reportConsolidatedVerifyOutcome` composes the operator-facing lines; this seam
 * decides the two arguments that say WHERE the consolidated run happened and
 * WHICH command fell over, and keeps them consistent with the per-worktree lines
 * the same gate call already pushed. It is a separate module for the reason §12
 * states: the gate body is a long linear narrative and these arguments are a
 * self-contained decision with two issue citations attached, so a reader of the
 * gate does not need either to follow the flow.
 *
 * The rule, and why each half reads what it reads:
 *
 *  · **The tree.** A cycle with ONE workstream has no combination to report, so
 *    the line names that workstream's own worktree in the words the per-worktree
 *    seam uses. The path comes from the caller's `worktrees` map — never from
 *    `repoRoot` as a fallback — because a label that invents a path is the same
 *    class of misdirection #1064 removes. With no worktree to name the caller
 *    passes nothing and the reporter keeps the CONSOLIDATED wording.
 *
 *  · **The command.** For one workstream the consolidated run and the
 *    per-worktree run are the same gate over the same content, so when the fast
 *    tier is what failed, the per-worktree line already named it and the
 *    consolidated line must not name the *full* command beside it. The tier's
 *    identity survives only on the line the per-worktree seam composed, so
 *    `ranVerifyCmdOf` reads it back from there; with no single per-worktree
 *    failure to read, the configured command stands.
 */

import { ranVerifyCmdOf } from "./work-driver-verify-develop-helpers.ts";

/** The subset of the reporter's argument object this seam decides. */
export interface ConsolidatedReportArgs {
  singleWorktree?: string;
  reportCmd?: string;
}

/**
 * #750 — does this pass have anything to consolidate?
 *
 * The develop gate reads the CONSOLIDATED tree, not the isolated worktrees: a
 * per-worktree verify cannot see a file a sibling's commit supplies (or deletes),
 * and the #750 regression proved the combined state is the only state worth
 * testing. The combined tree is built from every worktree with commits ahead of
 * baseSha, so the consolidated run happens whenever any committed worktree
 * exists and the root is not itself the only worktree (N=1 with the root as the
 * worktree IS the combined tree). Kept as a named predicate rather than an inline
 * length test because the two #750 comments that justified it read as one rule.
 */
export function consolidationNeeded(changedWorktrees: readonly string[]): boolean {
  return changedWorktrees.length > 0;
}

/** The two #1064/#1324 arguments, for a develop gate call. Empty at N>1 (the
 * CONSOLIDATED wording is correct there and needs no input), and at N=1 without
 * a single failed per-worktree line to read the command off.
 */
export function consolidatedReportArgs(opts: {
  /** The gate's worktree map (the caller's, not the state's — same content). */
  worktrees: Record<string, string>;
  /** The per-worktree failure texts this gate call produced, in order. */
  perWorktreeVerifyFailures: string[];
  /** The configured verify command — the fallback when no leg names a tier. */
  cmd: string;
}): ConsolidatedReportArgs {
  if (Object.keys(opts.worktrees).length !== 1) return {};
  const singleWorktree = Object.values(opts.worktrees)[0];
  if (singleWorktree === undefined) return {};
  if (opts.perWorktreeVerifyFailures.length !== 1) return { singleWorktree };
  return {
    singleWorktree,
    reportCmd: ranVerifyCmdOf(opts.perWorktreeVerifyFailures[0] ?? "", opts.cmd),
  };
}
