/**
 * work-driver-handoff-label-state — the label side of Step 7g, in the one
 * place both its producers and its readers can reach without importing the
 * posting machinery.
 *
 * `needs-human-attention` has two questions attached to it and they are easy to
 * conflate: *what did we record* (the per-target verifications, written by
 * `runHandoff` and its legs) and *what does it mean* (the sentence three
 * renderers print). The defect this module exists for (#2173 C4) was exactly the
 * conflation — the in-chat banner asked the aggregate `labelApplied`, the
 * comment line below it asked nothing at all, and one handoff printed both
 * `label applied: [FAILED] NOT applied` and `the label was applied`. An external
 * team saw the same pair in their own handoffs.
 *
 * The fix is one reader, here: `handoffLabelVerdict` is the ONLY function that
 * turns a `handoff-emitted` event's label fields into a verdict, and every label
 * or comment line in every surface is derived from it. Its rule is the one every
 * producer already follows — the per-target fields are the evidence and
 * `labelApplied` is their conjunction — so per-target knowledge wins, and the
 * aggregate is consulted only for an event that carries none (the pre-#798 shape,
 * and every lean path, which applies no label).
 *
 * The DECLINE half lives beside it because the two are the same question. A
 * deliberate decline (#1472's closed issue, #1696's host channel) and a failed
 * apply can both leave a target without the label, and only the marker tells
 * them apart; `declinesAttentionLabel` reads the state's marker and
 * `makeHandoffEmittedEvent` writes it onto the event, so the fact is stated once
 * at the source and no renderer reconstructs it from a boolean.
 */

import type { HandoffEmittedEvent } from "./workflow-state-events-handoff.ts";

/**
 * #1472 — does this handoff deliberately decline `needs-human-attention`?
 * A person CLOSED the issue, so telling them to look at it is noise; every
 * label writer consults this so the decline holds on all four paths, including
 * the @ops prompt. Returns false for any cycle not parked by the closed-issue
 * gate, so normal handoffs are unaffected.
 */
export function declinesAttentionLabel(ps: { handoffLabelSkipped?: boolean }): boolean {
  return ps.handoffLabelSkipped === true;
}

/**
 * #1472 — the initial label state for `runHandoff`. A closed-issue park starts
 * with every target settled, so all four label writers see it; it is a
 * deliberate decline, NOT a failure, so the HANDOFF DISPATCH INCOMPLETE banner
 * stays quiet. Any other handoff starts with nothing applied.
 */
export function declinedLabelSeed(
  ps: { handoffLabelSkipped?: boolean },
  prNumber: number | undefined,
): { labelApplied: boolean; issueLabelApplied?: boolean; prLabelApplied?: boolean } {
  if (!declinesAttentionLabel(ps)) return { labelApplied: false };
  return {
    labelApplied: true,
    issueLabelApplied: true,
    prLabelApplied: prNumber ? true : undefined,
  };
}

/** What every label and comment line is derived from (#2173 C4). */
export interface HandoffLabelVerdict {
  /** The label is DECLINED by contract rather than unapplied: the host channel
   * (#1696) or an issue a human closed (#1472). Nothing asks the operator to
   * apply it, and nothing calls it a failure. */
  declined: boolean;
  /** Why it was declined, for the surface that names the reason. */
  decline: "host-channel" | "issue-closed" | undefined;
  /** The issue is the entry-gate target: the event always has an answer for it,
   * either the per-target verification or (pre-#798) the aggregate. */
  issue: boolean;
  /** The PR's verdict, or absent when the cycle opened no PR / the event predates
   * per-target fields — ABSENT is not `false`, and a renderer must not print a
   * PR line for a PR it has no knowledge of. */
  pr: boolean | undefined;
  /** Whether the event carries any per-target knowledge at all. False for the
   * pre-#798 shape and for every lean path, which apply no label and name no
   * target: those render the single-target line, not a per-target block. */
  perTarget: boolean;
  /** Everything the handoff was owed landed. */
  all: boolean;
  /** A comment exists at `commentUrl`. */
  commentPosted: boolean;
}

/**
 * The ONE reader of a handoff-emitted event's label verdict (#2173 C4).
 *
 * `perTarget` — not the aggregate — is what a renderer branches on, because
 * "the event never said anything about the PR" and "the event said the PR's
 * label is missing" are different answers and only one of them earns a PR line.
 */
export function handoffLabelVerdict(ev: HandoffEmittedEvent): HandoffLabelVerdict {
  const hostDeclined = ev.delivery === "host" || ev.labelSkipped === "host-channel";
  // #2173 (C4) — the closed-issue decline is the MARKER the producer wrote, read
  // with no inference. An earlier shape guessed it from "`labelApplied` is true
  // while no per-target field says otherwise", and that guess is wrong on a
  // genuine dual-ok: a handoff that really did verify the label on both targets
  // has exactly those fields and is not a decline. The ambiguity was never in the
  // event — it was in a producer that recorded a decline as a boolean flag on the
  // STATE and left the reader to reconstruct it. `makeHandoffEmittedEvent` now
  // writes `labelSkipped: "issue-closed"` from the state it is handed, so the
  // fact is stated once at the source and every renderer reads the same answer.
  //
  // An event written before this change carries no marker and therefore renders
  // as its fields say: a closed-issue handoff's own cycle was alive when it wrote
  // the event, so that is a transient of one state file, not a state a later
  // cycle can enter.
  const closedDeclined = ev.labelSkipped === "issue-closed";
  const declined = hostDeclined || closedDeclined;
  const decline: HandoffLabelVerdict["decline"] = hostDeclined
    ? "host-channel"
    : closedDeclined
      ? "issue-closed"
      : undefined;
  const perTarget = ev.issueLabelApplied !== undefined || ev.prLabelApplied !== undefined;
  const issue = perTarget ? ev.issueLabelApplied === true : ev.labelApplied;
  const pr = perTarget ? ev.prLabelApplied : undefined;
  // #2173 (C4) — `all` keeps the PRODUCER's conjunction rather than recombining
  // the per-target fields, because the two are not interchangeable for an
  // issue-only handoff. `labelApplied` is written by the legs that own the
  // question (#1219's both-or-nothing rule and the pre-#798 single aggregate) and
  // is deliberately false whenever ANY target is unverified, while a missing PR
  // is not a target at all for a cycle that opened none. Recombining here would
  // turn "the issue's label landed, there is no PR" into a total-failure banner
  // that asks the operator to apply a label already applied — the opposite of the
  // contradiction this projection was introduced to remove.
  return {
    declined,
    decline,
    issue,
    pr,
    perTarget,
    all: ev.labelApplied,
    commentPosted: ev.commentUrl !== undefined,
  };
}
