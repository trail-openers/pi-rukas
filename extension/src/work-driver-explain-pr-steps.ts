/**
 * work-driver-explain-pr-steps — cap-hit explanation for the
 * intent-park cap. Split from work-driver-explain.ts so that file sits
 * under the 500-line cap with headroom for new caps; the content here is
 * the verbatim former case body of work-driver-explain.ts.
 */

import { explainPushRefusal } from "./work-driver-explain-push-refusal.ts";
import { isMemoryClaim } from "./work-driver-intent-criticality.ts";
import { type ParkReason, explainPark } from "./work-driver-intent.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the `intent-park` cap; the dispatch is exhaustive, so an
 * unknown cap can never land here.
 */
export function explainPrSteps(cap: Cap, state: WorkState): string {
  switch (cap) {
    // #1439 — the forge refused the push. The consolidated commit is local and intact;
    // what is missing is the remote's permission. Naming the refusal (and the allow-
    // the-secret URLs inside it) is the whole deliverable here — the pre-fix handoff
    // called it a verify failure and sent the operator to fix code.
    case "push-refused:commit-pr":
      return explainPushRefusal(state);
    case "intent-park": {
      const spec = state.pipelineState.normalisedSpec;
      const reason = (spec?.parkReason ?? "underspecified") as ParkReason;
      // #1561 — a park resting on an open PR is work awaiting review, not a
      // done issue: name the PR instead of inviting the reader to close it.
      const hit = [...state.eventLog]
        .reverse()
        .find((e) => e.kind === "cap-hit" && e.cap === "intent-park");
      const openPr = hit?.kind === "cap-hit" ? hit.awaitingReviewPr : undefined;
      const why =
        openPr !== undefined
          ? `#${state.issue}'s work is in open PR #${openPr}, which is awaiting review — it is not merged, so #${state.issue} is not done. Review or merge PR #${openPr}; close #${state.issue} once it lands, or say what is still missing and re-run.`
          : explainPark(reason, state.issue);
      // Memory rows are listed apart: under "Contradicting evidence" a stale
      // vipune row reads as a finding about the code, which it is not.
      const row = (e: { claim: string; source: string }) =>
        `  - ${e.claim}${e.source ? ` (${e.source})` : ""}`;
      const contradicted = (spec?.evidence ?? []).filter((e) => e.verdict === "contradicted");
      const contradictions = contradicted.filter((e) => !isMemoryClaim(e));
      const staleMemory = contradicted.filter(isMemoryClaim);
      const evidence =
        (contradictions.length > 0
          ? `\n\nContradicting evidence:\n${contradictions.map(row).join("\n")}`
          : "") +
        (staleMemory.length > 0
          ? `\n\nStale memory rows the resolver found (a correction to memory, not a reading of the code):\n${staleMemory.map(row).join("\n")}`
          : "");
      const rationale = spec?.rationale ? `\n\nResolver's rationale: ${spec.rationale}` : "";
      // A repeat was re-resolved but not re-reported; say so, so the operator
      // does not look for a new comment (work-driver-park-memory.ts).
      const emitted = [...state.eventLog].reverse().find((e) => e.kind === "handoff-emitted");
      const repeat =
        emitted?.kind === "handoff-emitted" && emitted.repeatOf
          ? `REPEAT of the park reported ${Math.max(0, Math.round((emitted.at - emitted.repeatOf.at) / 60_000))} min ago (${emitted.repeatOf.commentUrl}): this cycle re-resolved the issue from scratch and reached the same verdict against the same issue text and commit, so no second comment was posted.\n\n`
          : "";
      return `${repeat}${why} No code was written — the driver halted at intent resolution, before plan or branch ran.${evidence}${rationale}`;
    }
    default:
      return `unhandled intent-park cap: ${cap}`;
  }
}
