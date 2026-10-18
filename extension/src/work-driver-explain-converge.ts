/**
 * work-driver-explain-converge — cap-hit explanation for the converge gate
 * (`develop-incomplete-deliverables`, #741). Split from work-driver-explain.ts
 * along the same seam as `work-driver-explain-plan.ts`, so the parent sits
 * under the 500-line cap; the body is the verbatim former `case` arm.
 */

import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

export function explainConvergeIncomplete(state: WorkState): string {
  // #741 — the converge gate: the verify gate passed (the code builds),
  // but one or more plan deliverables are absent from the end-of-develop
  // diff. The missing deliverables ride on the cap event's evidence.
  const hit = lastCapHit(state, "develop-incomplete-deliverables");
  const evidence = (hit && "evidence" in hit ? hit.evidence : undefined) ?? "(no detail recorded)";
  const partials = (state.pipelineState.convergeEvidence?.deliverables ?? [])
    .filter((d) => d.status === "partial")
    .map((d) => `${d.id} (${d.reason})`);
  const noDiff = (state.pipelineState.convergeEvidence?.deliverables ?? [])
    .filter((d) => d.status === "no-diff")
    .map((d) => `${d.id} (${d.reason})`);
  // #1155 — an UNMEASURABLE deliverable is the gate saying "I could not
  // judge this", which is a different sentence from "the work is missing",
  // and it must not be folded into the absent list. The operator needs to
  // see it here because the cap below may have fired on OTHER deliverables
  // while this one slipped past the check entirely.
  const unmeasurable = (state.pipelineState.convergeEvidence?.deliverables ?? [])
    .filter((d) => d.status === "unmeasurable")
    .map((d) => `${d.id} (${d.reason})`);
  const partialWarning =
    partials.length > 0
      ? `\n\nPartial deliverables (warning, non-blocking):\n${partials.map((p) => `  - ${p}`).join("\n")}`
      : "";
  const noDiffWarning =
    noDiff.length > 0
      ? `\n\nNo-diff deliverables (not blocking — no diff by design):\n${noDiff.map((p) => `  - ${p}`).join("\n")}`
      : "";
  const unmeasurableWarning =
    unmeasurable.length > 0
      ? `\n\nUnmeasurable deliverables (warning, non-blocking — the gate could not check these; reword their [paths:] slot so the plan names a real file or a <template>):\n${unmeasurable.map((p) => `  - ${p}`).join("\n")}`
      : "";
  return `the converge gate found the end-of-develop diff INCOMPLETE: ${evidence}. The verify gate passed — the code builds and tests; what is missing is declared plan work the diff never contained. The driver already spent its one-shot corrective re-dispatch on these deliverables; re-running /work re-enters the gate with a fresh corrective budget, or implement the missing deliverables on the branch directly.${partialWarning}${noDiffWarning}${unmeasurableWarning}`;
}
