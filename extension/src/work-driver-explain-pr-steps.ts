/**
 * work-driver-explain-pr-steps — cap-hit explanation for the
 * intent-park cap. Split from work-driver-explain.ts so that file sits
 * under the 500-line cap with headroom for new caps; the content here is
 * the verbatim former case body of work-driver-explain.ts.
 */

import { type ParkReason, explainPark } from "./work-driver-intent.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the `intent-park` cap; the dispatch is exhaustive, so an
 * unknown cap can never land here.
 */
export function explainPrSteps(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "intent-park": {
      const spec = state.pipelineState.normalisedSpec;
      const reason = (spec?.parkReason ?? "underspecified") as ParkReason;
      const why = explainPark(reason, state.issue);
      const contradictions = (spec?.evidence ?? []).filter((e) => e.verdict === "contradicted");
      const evidence =
        contradictions.length > 0
          ? `\n\nContradicting evidence:\n${contradictions.map((e) => `  - ${e.claim}${e.source ? ` (${e.source})` : ""}`).join("\n")}`
          : "";
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
