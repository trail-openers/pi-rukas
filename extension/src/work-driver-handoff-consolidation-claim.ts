/**
 * work-driver-handoff-consolidation-claim — the one place the handoff decides
 * what to tell the operator about consolidation (#1421), split out of
 * `work-driver-handoff.ts` under AGENTS.md §12.
 *
 * `runHandoff` records the #674 pre-handoff consolidation in two places: the
 * `handoff-consolidated` event (the audit trail) and fields on the
 * `handoff-emitted` event that the chat message, the GitHub body and
 * `/work-status` each render. The rendering rule is not a formatting detail —
 * it is the difference between an operator told "the work is lost on detached
 * HEADs" and one told where the commits actually are.
 *
 * Before #1421 the event carried ONE fixed sentence for every failure, including
 * the case where the only thing in the root was cargo's `target/`: no cause was
 * named and nothing said where the commits were. The real reason is traced by
 * `runHandoffConsolidate` and reaches here as `degradedReason`; the worktrees,
 * their HEADs and their ahead-counts reach here from the snapshot the step
 * captured. This module composes the two into the sentence the operator reads.
 *
 * It is deliberately a pure function of its inputs: the step handler stays the
 * only thing that talks to git, and a claim that depends on a filesystem read is
 * a claim that changes when the tree does.
 */

import type { HandoffCommittedWorkEntry } from "./work-driver-handoff-post.ts";

/** The two carriers the claim is composed from, both already in the step's scope. */
export interface ConsolidationClaimInputs {
  /** The snapshot's committed work — present when worktrees hold commits. */
  committedWork?: HandoffCommittedWorkEntry[];
  /** The driver's own cause, recorded when consolidation was DECLINED. */
  degradedReason?: string;
}

/**
 * The "why did consolidation not happen" sentence, or `undefined` when nothing
 * needs saying: a consolidation that ran has no reason to explain, and a cycle
 * with no committed worktree has no work to locate.
 *
 * The committed-work list is the load-bearing half — it says the work is NOT
 * lost and names each worktree, its path, its HEAD and how far ahead of the base
 * it sits — because the recovery steps below the fold assume the reader already
 * knows the work exists.
 */
export function consolidationClaim(inputs: ConsolidationClaimInputs): string | undefined {
  const work = inputs.committedWork;
  if (!work || work.length === 0) return undefined;
  const where = work
    .map(
      (w) =>
        `worktree ${w.worktreeId} at ${w.path} (HEAD ${w.headSha.slice(0, 8)}, ${w.ahead} commit(s) ahead of the base)`,
    )
    .join("; ");
  return `consolidation did not run — the committed work is NOT lost: ${where}. See the recovery steps below for the cherry-pick commands${
    inputs.degradedReason !== undefined ? `; driver's reason: ${inputs.degradedReason}` : ""
  }`;
}
