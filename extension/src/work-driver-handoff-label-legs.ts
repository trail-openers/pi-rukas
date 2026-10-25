/**
 * work-driver-handoff-label-legs — the two post-delivery label legs of a handoff
 * (#798, #1219, #1820), split out of `work-driver-handoff.ts` under §12.
 *
 * A handoff can carry two objects, and each needs its own write of the single
 * `needs-human-attention` label:
 *
 *   - the COMMENT target (the PR when one exists), whose comment may have failed
 *     to post for a reason that says nothing about the label — including the body
 *     being refused by the public-hygiene seam; and
 *   - the ISSUE, which is the object the repeat-park guard
 *     (`work-driver-attention.ts`) actually reads before a cycle starts.
 *
 * ## Why the issue leg may not be gated on a PR existing
 *
 * It used to be: the reasoning was that the comment target's retry had already
 * applied the label. That held while the retry was the only writer. It stopped
 * holding the moment the retry could reach the issue too — with no PR in the cycle
 * the read-back records "not applied", the gate evaluated false, and an
 * issue-target park finished with NO label at all: the same failure #1820 fixed
 * for a refused body, a park the guard cannot see re-running the whole pipeline
 * against an unchanged issue. Each leg is now gated on the label state of the
 * object it writes.
 *
 * ## Why both stay outside the fallback's try/catch
 *
 * `runHandoff`'s in-process fallback swallows every forge error, so a write that
 * belongs to the handoff's recorded state must not sit inside it — it would be
 * traced away with the comment post. Both legs are also `!host`: on the host
 * channel the host owns the label and the event records the decline (#1696).
 */

import type { Forge } from "./forge.ts";
import { applyIssueLabelAndVerify, labelPrAfterBodyRefusal } from "./work-driver-handoff-labels.ts";

/** The label state the two legs can still change. */
export interface HandoffLabelState {
  issueLabelApplied?: boolean;
  prLabelApplied?: boolean;
  labelApplied: boolean;
}

/**
 * The comment target's label, for a handoff whose BODY the hygiene seam refused.
 *
 * Gated on `prNumber` deliberately: the PR is the object the refused comment would
 * have carried, so with no PR there is nothing here to do and the issue leg below
 * covers the park.
 */
export async function labelCommentTargetAfterRefusal(
  forge: Forge | undefined,
  state: HandoffLabelState,
  prNumber: number | undefined,
): Promise<HandoffLabelState> {
  if (!forge || !prNumber || state.prLabelApplied) return state;
  const outcome = await labelPrAfterBodyRefusal(forge, prNumber, state.issueLabelApplied);
  return { ...state, prLabelApplied: outcome.prLabelApplied, labelApplied: outcome.labelApplied };
}

/**
 * The entry-gate target's label: the ISSUE, gated on the issue's own state.
 *
 * `applyIssueLabelDualTarget` (behind `applyIssueLabelAndVerify`) applies the
 * label itself and then reads it back, so it is correct whether or not a PR
 * exists and whether or not the comment leg already asked for the same label —
 * `gh --add-label` is idempotent server-side.
 */
export async function labelIssueTarget(
  forge: Forge | undefined,
  state: HandoffLabelState,
  issue: number,
): Promise<HandoffLabelState> {
  if (!forge || state.issueLabelApplied) return state;
  const outcome = await applyIssueLabelAndVerify(forge, issue, state.prLabelApplied);
  return {
    ...state,
    issueLabelApplied: outcome.issueLabelApplied,
    labelApplied: outcome.labelApplied,
  };
}
