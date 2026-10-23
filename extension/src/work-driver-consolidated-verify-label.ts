/**
 * work-driver-consolidated-verify-label — #1064: the tree and command a
 * consolidated verify failure names.
 *
 * The consolidated run's *behaviour* lives in `work-driver-consolidated-verify.ts`
 * and its *reporting* in `work-driver-consolidated-verify-report.ts`. This seam
 * owns one narrow thing: the words that say WHERE the run happened and WHICH
 * command fell over, so the three label branches the reporter has (killed at the
 * bound, could not fork, reached a verdict) cannot drift apart, and the rule
 * itself has one home and one test file.
 *
 * The rule, once: the CONSOLIDATED wording is honest only when the probe
 * COMBINED something. With one workstream the probe cherry-picks that
 * workstream's own commits, so its tree is the workstream's tree and the
 * sentence "failed on the CONSOLIDATED tree" describes a combination that never
 * happened — five of nine `verify-failed:develop` cycles on the host this was
 * filed from said it about a single `default` workstream, sending the operator
 * hunting for an interaction between workstreams where there is no second one to
 * be between. At N=1 the label names the workstream's own tree, in the words the
 * per-worktree seam already uses (`verify command … failed in <cwd>`).
 *
 * Two things this deliberately does NOT key on:
 *   · whether the consolidated run EXECUTED — at N=1 it still runs (the
 *     dirty-root refusal must fire even when the combined tree is trivially the
 *     one worktree); only its label changes;
 *   · a tree the caller did not name. A caller with no worktree to point at has
 *     no per-tree claim to make, so it keeps the CONSOLIDATED wording rather
 *     than printing a path nobody supplied.
 */

import type { ConsolidationFailureVerdict } from "./work-driver-consolidation-classify.ts";
import { consolidatedFailureMessage } from "./work-driver-consolidation-classify.ts";

/**
 * The clause that names the tree, readable as `verify … failed <clause>` and as
 * `exceeded its bound <clause>` — both sentences the reporter composes take it
 * verbatim, which is what keeps the timeout, host-exhaustion and classified
 * branches naming one run the same way.
 */
export function consolidatedTreeClause(opts: {
  workstreamCount: number;
  /** The single workstream's own tree: its worktree at develop, the
   * integration checkout at commit-pr. */
  cwd: string;
  /** The repoRoot the probe built the combined tree in (the N>1 wording). */
  at: string;
}): string {
  return opts.workstreamCount <= 1
    ? `in the single workstream's own tree at ${opts.cwd}`
    : `on the CONSOLIDATED tree at ${opts.at}`;
}

export interface ConsolidatedFailureLabel {
  /** The tree clause, shared by all three failure branches below. */
  treeClause: string;
  /** The line for a run that reached a verdict. */
  verdictLine: string;
  /** The `where` for a run killed at its bound. */
  timeoutWhere: string;
  /** The subject of the host-exhaustion sentence for a run that never started. */
  execSubject: string;
}

/**
 * All three label shapes for one consolidated run, composed from one decision.
 *
 * `verdictLine` at N=1 is the classifier's own message with its tree clause
 * swapped and its command reported as the one that actually ran
 * (`reportCmd`): at N=1 the consolidated run and the per-worktree run are the
 * same gate over the same content, so when the fast tier is what fell over the
 * per-worktree line already named it and the consolidated line must not
 * contradict its sibling by naming the full command. Everything else the
 * classifier said — the `[classification]` tag the cap router reads, the
 * specific assertion, the attribution, the reason — stands byte for byte, which
 * is what makes #1064 a label change and nothing else.
 */
export function consolidatedFailureLabel(opts: {
  verdict: ConsolidationFailureVerdict;
  cmd: string;
  /** The command the single workstream's own run executed, when the caller
   * knows it (its fast tier, if that tier failed). Absent → `cmd`. */
  reportCmd?: string;
  /** The single workstream's own tree, when the cycle has one. Absent → the
   * CONSOLIDATED wording, because there is no tree to name. */
  singleWorktree?: string;
  /** How many workstreams the cycle has. */
  workstreamCount: number;
  /** The repoRoot the probe ran in. */
  at: string;
}): ConsolidatedFailureLabel {
  const singleShape = opts.workstreamCount <= 1 && opts.singleWorktree !== undefined;
  // The count fed to the clause is clamped so a caller that has no worktree to
  // name can never land on the N=1 branch — the `at` fallback would otherwise
  // print the probe's checkout as if it were a workstream's tree.
  const treeClause = consolidatedTreeClause({
    workstreamCount: singleShape ? 1 : Math.max(opts.workstreamCount, 2),
    cwd: opts.singleWorktree ?? opts.at,
    at: opts.at,
  });
  // The classifier's default clause is the BARE `on the CONSOLIDATED tree`. The
  // reporter has always qualified it with the checkout the probe built the tree
  // in, and that qualification is load-bearing: #669 case 1 asserts the failure
  // cites the CONSOLIDATED tree, and `consolidatedFailureMessage` only applies a
  // caller-supplied clause when one is passed — so the N>1 branch has to pass one
  // explicitly rather than lean on the default, or the path silently regresses to
  // an unqualified sentence.
  const multiLine = consolidatedFailureMessage(opts.verdict, opts.cmd, treeClause);
  return {
    treeClause,
    verdictLine: singleShape
      ? consolidatedFailureMessage(opts.verdict, opts.reportCmd ?? opts.cmd, treeClause)
      : multiLine,
    timeoutWhere: treeClause,
    execSubject: `verify command \`${opts.reportCmd ?? opts.cmd}\` failed ${treeClause}`,
  };
}
