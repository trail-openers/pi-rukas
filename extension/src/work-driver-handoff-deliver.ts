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
import {
  applyIssueLabelDualTarget,
  parseHandoffOpsReply,
  verifyHandoffLabel,
} from "./work-driver-handoff-post.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * Outcome of the delivery leg: what the comment/label ended up as, and where
 * the driver's record of each came from.
 */
export interface HandoffDelivery {
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
 */
export async function deliverHandoff(args: {
  repoRoot: string;
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
}): Promise<HandoffDelivery> {
  const { repoRoot, issue, prNumber, forge, handoffBodyPath, dispatchFailed } = args;
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
    // #798 — when prNumber is set, the fallback above applies the label to the
    // comment target (PR) via postHandoffWithRetry. The ISSUE label is applied
    // separately here because the retry only targets one object.
    if (prNumber && !issueLabelApplied) {
      // #798 — the helper APPLIES the issue label (its return is the
      // immediately-following read-back, which can be stale/false when the
      // server-side write has not settled). The authoritative state is a
      // FRESH read — never trust the helper's first read for the record.
      const ok = await applyIssueLabelDualTarget(forge, issue);
      const verified = ok || (await verifyHandoffLabel(forge, "issue", issue));
      issueLabelApplied = verified;
      // Both targets or nothing: the issue label alone must not report the
      // PR's failed label as applied (#1219).
      labelApplied = verified && prLabelApplied === true;
    }
  }
  return { commentUrl, labelApplied, issueLabelApplied, prLabelApplied, delivery };
}

/** Whether this state's event log records a failed handoff ops dispatch. */
export function handoffDispatchFailed(state: WorkState): boolean {
  return state.eventLog
    .slice()
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

/** The ops reply's parsed label state, re-exported for the step handler. */
export { parseHandoffOpsReply };
