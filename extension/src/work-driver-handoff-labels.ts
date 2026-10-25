/**
 * work-driver-handoff-labels — the `needs-human-attention` label legs of Step
 * 7g, split out of `work-driver-handoff.ts` under AGENTS.md §12.
 *
 * Three facts, all about the label and none about the comment, live here. They
 * were split out rather than left inline because the step handler is at the size
 * cap and the label rules — which target to write, when a write is owed, and
 * what a `false` means on each channel — are a contract of their own that
 * changes for reasons the routing around it does not.
 *
 * ## The label is not the comment's appendage (#1820 round 3)
 *
 * `runHandoff` gates every COMMENT on the hygiene seam's verdict, and a body the
 * publish guard refused posts nothing. The label still has to be applied, because
 * the label is the only carrier the pre-loop repeat-park gate
 * (`work-driver-attention.ts`) reads: a park that could not publish its comment
 * and also carried no label left no trace, so `/work N` on the same unchanged
 * issue re-ran the whole pipeline, refused again, and produced another handoff no
 * human had been asked to look at. A label is a name the forge already has, so it
 * travels where refused text cannot.
 *
 * ## Read, never trust the write
 *
 * Every leg records a FRESH `verifyHandoffLabel` read, not the apply helper's own
 * read-back: `gh --add-label` is idempotent and a 202-accepted-but-pending write
 * reads as absent (#775, #1219). "Both targets or nothing" is the rule the dual
 * leg enforces — an issue label alone must never report the PR as labelled.
 */

import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import {
  applyAttentionLabel,
  applyIssueLabelDualTarget,
  verifyHandoffLabel,
} from "./work-driver-handoff-post.ts";

/** What the PR label leg ended up recording, for the handoff-emitted event. */
export interface PrLabelOutcome {
  prLabelApplied: boolean;
  /** Both targets or nothing (#1219): the issue label alone is not "applied". */
  labelApplied: boolean;
}

/**
 * The comment target's label, for a handoff whose COMMENT was refused.
 *
 * The PR is the object the refused comment would have carried, so it is the
 * object the attention label belongs on. The apply swallows its own failures
 * (an attention label is a request for a human and must never be the thing that
 * stops a handoff from finishing), and the recorded state is a fresh read.
 *
 * Called only when the body was refused and no comment posted — the normal path
 * labels the PR inside `deliverHandoff`'s retry, right after the post.
 */
export async function labelPrAfterBodyRefusal(
  forge: Forge,
  prNumber: number,
  issueLabelApplied: boolean | undefined,
): Promise<PrLabelOutcome> {
  await applyAttentionLabel(forge, "pr", prNumber, "handoff PR label (#1820 refused body)");
  const prLabelApplied = await verifyHandoffLabel(forge, "pr", prNumber);
  return { prLabelApplied, labelApplied: prLabelApplied && issueLabelApplied === true };
}

/**
 * The #798 dual-target ISSUE label leg: the comment target (PR) got its label
 * from the retry, and the issue is the entry-gate target, so it needs its own.
 *
 * EXPORTED for the step handler to call OUTSIDE its swallow-all try/catch — a
 * forge write here must be able to surface rather than be traced away with the
 * rest of the fallback, and a host-owned channel never labels.
 */
export async function applyIssueLabelAndVerify(
  forge: Forge,
  issue: number,
  prLabelApplied: boolean | undefined,
): Promise<{ issueLabelApplied: boolean; labelApplied: boolean }> {
  const ok = await applyIssueLabelDualTarget(forge, issue);
  const issueLabelApplied = ok || (await verifyHandoffLabel(forge, "issue", issue));
  return { issueLabelApplied, labelApplied: issueLabelApplied && prLabelApplied === true };
}

/** A label write that must not stop a handoff, traced rather than thrown. */
export function traceLabelFailure(where: string, err: unknown): void {
  trace(
    `work-driver: handoff ${where} failed (non-fatal): ${(err as Error).message?.slice(0, 160)}`,
  );
}
