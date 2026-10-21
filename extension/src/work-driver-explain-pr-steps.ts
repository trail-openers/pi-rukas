/**
 * work-driver-explain-pr-steps — cap-hit explanation for the parks this module
 * remembers: `intent-park`, `existing-pr-detected` and the forge push refusal.
 * Split from work-driver-explain.ts so that file sits under the 500-line cap
 * with headroom for new caps; the intent-park body is the verbatim former case
 * body of work-driver-explain.ts.
 *
 * Each of these can park twice on an unchanged issue, so each opens with the
 * shared repeat sentence when it does (work-driver-explain-repeat.ts).
 */

import { explainPushRefusal } from "./work-driver-explain-push-refusal.ts";
import { repeatParkNote } from "./work-driver-explain-repeat.ts";
import { isMemoryClaim } from "./work-driver-intent-criticality.ts";
import { type ParkReason, explainPark } from "./work-driver-intent.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the parks and the push refusal; the dispatch in `explainCap` is
 * exhaustive, so an unknown cap can never land here.
 */
export function explainPrSteps(cap: Cap, state: WorkState): string {
  switch (cap) {
    // #1439 — the forge refused the push. The consolidated commit is local and intact;
    // what is missing is the remote's permission. Naming the refusal (and the allow-
    // the-secret URLs inside it) is the whole deliverable here — the pre-fix handoff
    // called it a verify failure and sent the operator to fix code.
    case "push-refused:commit-pr":
      return explainPushRefusal(state);
    // #1743 — the branch step's pre-flight found the issue's open PR. `--restart`
    // wipes the state file but not GitHub, so this one repeats on every re-run.
    case "existing-pr-detected": {
      const pr = state.pipelineState.existingPr;
      const via =
        pr?.matchedBy === "branch"
          ? `its head branch \`${pr.headRefName}\` names the issue`
          : "its body carries a closing keyword for the issue";
      return `${repeatParkNote(state)}PR #${pr?.number ?? "(unknown)"} is already open for this issue — ${via}. The driver halted at the branch step BEFORE any dispatch, so no tokens were spent and nothing was written. \`--restart\` wipes the driver's state file but not GitHub, which is how issue #5 got rebuilt from scratch and shipped as a duplicate (#358 left orphaned by #359). Decide whether to resume that PR's branch, close it, or retarget it — the driver will not attach new commits to a PR whose head is a different branch`;
    }
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
      return `${repeatParkNote(state)}${why} No code was written — the driver halted at intent resolution, before plan or branch ran.${evidence}${rationale}`;
    }
    default:
      return `unhandled intent-park cap: ${cap}`;
  }
}
