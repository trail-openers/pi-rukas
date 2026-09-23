/**
 * work-driver-explain-other — cap-hit explanations for the
 * adversarial-infra-failure and step-back-revise-spec caps. Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
 * bodies of work-driver-explain.ts.
 */

import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the `adversarial-infra-failure` and `step-back-revise-spec`
 * caps; the dispatch is exhaustive, so an unknown cap can never land
 * here.
 */
export function explainOther(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "adversarial-infra-failure": {
      const out = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
            e.kind === "adversarial-workstream-outcome" &&
            (e.outcome === "infra-failure" || e.outcome === "dispatch-failed"),
        );
      const which = out ? `workstream ${out.workstreamId}` : "a workstream";
      return `${which}'s adversarial loop failed on infrastructure and stayed failed after a retry with the provider-stated backoff — NO verdict exists for it, and that is not a review rejection. The other workstreams' completed reviews are preserved in the state file (adversarial-workstream-outcome events); recover by re-running /work, which re-enters the adversarial step and re-runs ONLY the workstream(s) that never produced a verdict`;
    }
    case "step-back-revise-spec": {
      const sb = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
            e.kind === "step-back-completed",
        );
      const elem = sb?.sddElement ?? "(spec element not specified)";
      return `explore stepped back and identified a spec-level gap in **${elem}** — the lens-review fix loop kept flagging the same shape across rounds (MAST 41.77% — spec-level problem fingerprint). The handoff body includes a proposed revision. After updating the issue (via /plan or \`gh issue edit\`), re-run with \`/work N --restart\` to start a fresh cycle against the revised spec`;
    }
    default:
      return `unhandled explain-other cap: ${cap}`;
  }
}
