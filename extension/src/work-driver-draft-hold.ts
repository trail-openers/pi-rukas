/**
 * work-driver-draft-hold — why the driver must NOT mark the cycle's PR ready
 * (#1292, and the #1398 fix to how the disclosure is judged).
 *
 * Split from work-driver-draft-pr.ts for the 500-line cap (AGENTS.md §12). The
 * predicates here are pure functions of the event log plus the disclosure facts,
 * so they are the part of the draft gate a test can drive without a forge, and
 * the part a reviewer can read to learn the rule.
 *
 * ## The #1398 fix, in one paragraph
 *
 * `readyHoldReason` used to ask which cap NAME had appeared after the verdict
 * (`round-cap` / `wall-clock` with `nextStep: "handoff"`, the one route that
 * does not disclose) and held only in that shape. An `ISSUES_FOUND` followed by
 * anything ELSE that stopped the cycle before the disclosure — `dispatch-failed`,
 * `verify-failed:*`, a kill cause, `ci-retry` — looked like "nothing to hold
 * for", and `markDraftPrReady` marked the PR ready over findings nobody ever
 * posted. The rule is now stated positively: an `ISSUES_FOUND` may be marked
 * ready only when a `lens-residuals-posted` fact for the CURRENT patch says the
 * findings reached the PR. Keyed on the patch identity, because a disclosed
 * finding is not a fix — pushing a fix produces a new patch the old fact does
 * not describe, and must not inherit a licence to go ready.
 */

import { lensResidualsMarker } from "./merge-guard-round-cap.ts";
import type { PrDraftFindingsFact } from "./workflow-state-schema-pr-draft.ts";
import type { WorkEvent } from "./workflow-state.ts";

/** The hold text — one string, so the trace, the state and the handoff agree. */
export const DISCLOSED_HOLD =
  "the review's remaining findings were never posted to the PR, so it was not marked ready";

/** The CRITICAL hold text. */
export const CRITICAL_HOLD =
  "a CRITICAL finding is open, and the driver does not mark a PR ready over one";

/** Inputs the disclosure comparison needs, all optional (each degrades, none passes). */
export type ReadyHoldOpts = {
  /**
   * The identity of the patch being marked ready (`currentPatchIdentity`). When
   * absent the disclosure check falls back to the pre-#1398 cap-name shape — an
   * identity the driver cannot establish is not evidence that a disclosure
   * matched it, and is not a reason to block either.
   */
  patchId?: string;
  /** The `prDraft.findingsPosted` mirror, checked alongside the event log. */
  findingsPosted?: PrDraftFindingsFact[];
  /** The cycle's branch — a disclosure fact is per-branch. */
  branch?: string;
};

/**
 * Why the driver must NOT mark the PR ready, or `undefined` when it may:
 *  - a CRITICAL verdict is never marked ready over (the cap only routes it);
 *  - an `ISSUES_FOUND` verdict whose residual findings are not disclosed on the
 *    PR for the patch being marked ready — the findings would travel unseen.
 */
export function readyHoldReason(
  eventLog: readonly WorkEvent[],
  opts: ReadyHoldOpts = {},
): string | undefined {
  let verdictIdx = -1;
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const k = eventLog[i]?.kind;
    if (k === "lens-issues-found" || k === "lens-approved" || k === "lens-skipped-empty-diff") {
      verdictIdx = i;
      break;
    }
  }
  const verdict = eventLog[verdictIdx];
  if (verdict?.kind === "lens-issues-found" && verdict.verdict === "CRITICAL_ISSUES_FOUND") {
    return CRITICAL_HOLD;
  }
  if (verdict?.kind !== "lens-issues-found") return undefined;
  if (opts.patchId !== undefined) {
    return disclosedFor(eventLog, opts, opts.patchId) ? undefined : DISCLOSED_HOLD;
  }
  // No patch identity to key on: keep the shape that shipped (#1292) — the
  // round/wall-clock route to handoff is the one known non-disclosing route, so
  // hold on it and let everything else through. This is the conservative
  // direction for a driver that cannot compute an identity: it does not block a
  // review it cannot examine, and it still refuses the one case it CAN prove.
  const capped = eventLog
    .slice(verdictIdx + 1)
    .some(
      (e) =>
        e.kind === "cap-hit" &&
        (e.cap === "round-cap" || e.cap === "wall-clock") &&
        e.nextStep === "handoff",
    );
  return capped ? DISCLOSED_HOLD : undefined;
}

/**
 * Did a disclosure of THIS patch reach the PR? Both records are consulted: the
 * event log (what survives a resume and what `/work-status` renders) and the
 * `prDraft` mirror (what the handoff renders) — they are written together but
 * read by different callers.
 */
function disclosedFor(
  eventLog: readonly WorkEvent[],
  opts: ReadyHoldOpts,
  patchId: string,
): boolean {
  if ((opts.findingsPosted ?? []).some((fact) => fact.patchId === patchId)) return true;
  return eventLog.some(
    (e) =>
      e.kind === "lens-residuals-posted" &&
      e.target === "pr" &&
      e.patchId === patchId &&
      (opts.branch === undefined || e.branch === opts.branch),
  );
}

/**
 * The disclosure marker the PR itself must carry: the same substring the merge
 * guard's round-cap condition 5 compares (`lensResidualsMarker`, keyed on the
 * branch and the CURRENT patch), read from the same seam (`prComments`). This
 * is why the check is not a state-file assertion: the state can claim a
 * disclosure the PR does not have, and the guard would refuse the merge the
 * driver just licensed. Here the two read the same bytes.
 *
 * A comment body is untrusted content, so this is a substring test on the
 * renderer's own marker line — never a parse of anything the comment says.
 */
export function prCarriesDisclosure(
  bodies: readonly string[],
  branch: string | undefined,
  patchId: string,
): boolean {
  // The marker is only meaningful with a branch (the guard compares the PR's
  // headRefName); without one there is nothing to match, and a missing
  // disclosure is a hold, not a pass.
  if (!branch) return false;
  const marker = lensResidualsMarker(branch, patchId);
  return bodies.some((body) => body.includes(marker));
}
