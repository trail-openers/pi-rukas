/** work-driver-handoff-deliver — Step 7g's delivery half: the comment/label
 * verification and the in-process forge fallback, plus the pure URL helpers.
 * Split out of `work-driver-handoff.ts` for the §12 500-line gate; that module
 * keeps the step handler and re-exports these so no consumer's import path
 * changes. Everything here talks to the forge and none of it touches the
 * worktree, which is the seam the split follows. */
import fs from "node:fs/promises";
import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import { postHandoffWithRetry } from "./work-driver-handoff-post-retry.ts";
import { verifyHandoffLabel } from "./work-driver-handoff-post.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * Outcome of the delivery leg: what the comment/label ended up as, and where
 * the driver's record of each came from.
 */
export interface DeliveryOutcome {
  commentUrl?: string;
  labelApplied: boolean;
  issueLabelApplied?: boolean;
  prLabelApplied?: boolean;
  delivery?: "dispatch" | "fallback";
}

/**
 * Verify (and, where needed, apply) the handoff comment + `needs-human-attention`
 * label, in-process. Covers the three shapes the ops dispatch can leave behind:
 * nothing posted, posted with an unparseable reply, and posted-but-unlabelled.
 *
 * `dispatchFailed` gates the provenance record: the fallback's own writes count
 * as "fallback" only when the dispatch itself did not deliver.
 *
 * SCOPE: this is the fallback's own leg only. The #798 issue-label write
 * (`applyIssueLabelDualTarget` + fresh read-back) deliberately does NOT live
 * here — it sits in the step handler, OUTSIDE the swallow-all try/catch below,
 * and is guarded by `!host`. A forge write there must be able to surface
 * rather than be traced away, and a host-owned channel never labels.
 */
export async function deliverHandoff(args: {
  issue: number;
  prNumber?: number;
  forge: Forge | undefined;
  handoffBodyPath: string;
  commentUrl?: string;
  labelApplied: boolean;
  issueLabelApplied?: boolean;
  prLabelApplied?: boolean;
  delivery?: "dispatch" | "fallback";
  dispatchFailed: boolean;
}): Promise<DeliveryOutcome> {
  const { issue, prNumber, forge, handoffBodyPath, dispatchFailed } = args;
  let { commentUrl, labelApplied, issueLabelApplied, prLabelApplied, delivery } = args;
  if (forge) {
    const objType = prNumber ? "pr" : "issue";
    const targetId = prNumber ?? issue;
    const body = !commentUrl ? await fs.readFile(handoffBodyPath, "utf8").catch(() => "") : "";
    // #775 — idempotency check: fetch the target's existing comments
    // BEFORE posting so a comment the ops dispatch already posted (whose
    // URL was lost) is not re-posted. A failed dispatch leaves no such
    // comment, so the fallback posts exactly once.
    let existingComments: unknown[] | undefined;
    if (!commentUrl) {
      try {
        existingComments =
          objType === "pr" ? await forge.prComments(targetId) : await forge.issueComments(targetId);
      } catch (err) {
        trace(
          `work-driver: handoff comment-list fetch failed (non-fatal): ${(err as Error).message?.slice(0, 160)}`,
        );
      }
    }
    const posted = await postHandoffWithRetry(forge, {
      issue,
      body,
      expectedBody: body,
      targetId: targetId,
      objType,
      needsComment: !commentUrl,
      // #798 — the comment target is the PR (when prNumber set), but the
      // label must land on BOTH. The retry handles the comment target's
      // label; the issue label is applied separately below.
      needsLabel: !labelApplied,
      existingComments,
    });
    if (posted.commentUrl) {
      commentUrl = posted.commentUrl;
      // #775 — the fallback established the comment URL. If the dispatch
      // also failed, this is the fallback's provenance.
      if (dispatchFailed && !delivery) delivery = "fallback";
    }
    if (prNumber) {
      // #798 — dual-target: re-verify both independently after the retry.
      const issueVerified = await verifyHandoffLabel(forge, "issue", issue);
      const prVerified = posted.labelApplied
        ? await verifyHandoffLabel(forge, "pr", prNumber)
        : (prLabelApplied ?? false);
      if (issueVerified) {
        issueLabelApplied = true;
        if (dispatchFailed) delivery = "fallback";
      }
      if (prVerified) {
        prLabelApplied = true;
        if (dispatchFailed) delivery = "fallback";
      }
      labelApplied = issueVerified && prVerified;
    } else if (posted.labelApplied) {
      issueLabelApplied = true;
      labelApplied = true;
      if (dispatchFailed) delivery = "fallback";
    }
  } else {
    // No forge resolved — the fallback cannot run. The handoff is still
    // recorded (handoff-emitted), but the comment/label are NOT posted.
    // The operator sees the HANDOFF DISPATCH INCOMPLETE banner.
    trace("work-driver: handoff: no forge resolved — in-process fallback skipped");
  }
  return { commentUrl, labelApplied, issueLabelApplied, prLabelApplied, delivery };
}

/** Whether this state's event log records a failed handoff ops dispatch. */
export function handoffDispatchFailed(state: WorkState): boolean {
  return [...state.eventLog]
    .reverse()
    .some(
      (e) =>
        e.kind === "dispatch-failed" &&
        e.step === "handoff" &&
        e.role === "ops" &&
        e.label === "ops:handoff",
    );
}

export function parseHandoffCommentUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https:\/\/github\.com\/[^\s)>]+#issuecomment-\d+/);
  return m?.[0];
}

/**
 * The comment URL a PREVIOUS handoff attempt already delivered, if any —
 * the re-entry dedupe key (census 2026-09-09: a crash between the comment
 * post and the enclosing writeState re-posted a duplicate on resume). Pure;
 * newest event wins.
 */
export function priorHandoffCommentUrl(eventLog: readonly WorkEvent[]): string | undefined {
  const prior = [...eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "handoff-emitted" }> => e.kind === "handoff-emitted",
    );
  const url = prior?.commentUrl;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}
