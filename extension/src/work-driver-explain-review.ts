/**
 * work-driver-explain-review — cap-hit explanation for the
 * repeat-finding-seam cap (the #280 §B missing-seam signal). Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
 * body of work-driver-explain.ts.
 */

import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the `repeat-finding-seam` cap; the dispatch is exhaustive,
 * so an unknown cap can never land here.
 */
export function explainReview(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "repeat-finding-seam": {
      // #280 §B — same finding shape across ≥3 files is a missing-seam
      // signal, not N independent defects. Patching each instance would
      // entrench the duplication; explore is dispatched to analyse which
      // spec element under-specifies the shared behaviour.
      const hit = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
            e.kind === "cap-hit" && e.cap === "repeat-finding-seam",
        );
      const evidence =
        hit?.evidence ?? "the lens found the same finding shape across multiple files";
      return `lens-review round 1 flagged a repeating-seam pattern: ${evidence}. This is a missing-seam signal, not N independent defects. The driver dispatched @explore to analyse which spec element (outcomes / scope boundaries / constraints / prior decisions / task breakdown / verification criteria) under-specifies the shared behaviour. Patching each instance would entrench the duplication rather than surface the root cause. Review explore's SDD analysis and revise the issue before re-running /work`;
    }
    default:
      return `unhandled review cap: ${cap}`;
  }
}
