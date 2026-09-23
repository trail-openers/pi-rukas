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
      return `${why} No code was written — the driver halted at intent resolution, before plan or branch ran.${evidence}${rationale}`;
    }
    default:
      return `unhandled intent-park cap: ${cap}`;
  }
}
