/**
 * work-driver-explain-plan — cap-hit explanations for the plan step's own
 * gates: `plan-timeout` (#754) and `plan-spec-mismatch` (#819). Split from
 * work-driver-explain.ts along the same seam `work-driver-explain-other.ts`
 * documents — that file's header says it exists "so that file sits under the
 * 500-line cap with headroom for new caps" — and the bodies are verbatim
 * former `case` arms of the parent's exhaustive switch.
 *
 * Both caps fire in the plan step, BEFORE branch: neither may send the
 * operator off to inspect a diff or push a branch that was never created.
 */

import { isNoCallsEvidence } from "./work-driver-plan-calls.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the plan step's caps; the dispatch in `explainCap` is exhaustive,
 * so an unknown cap can never land here.
 */
export function explainPlan(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "plan-timeout":
      // Handled by the caller: #754 routes this one through the kill-cause
      // family module (explainDetectCaps), which reads the kill event's usage
      // off the log. Kept in the switch so the arm stays visible next to its
      // sibling and this module is total over the plan-step caps.
      return "the plan step's own wall-clock bound expired before it produced a plan — see the plan-timeout explanation";
    case "plan-spec-mismatch": {
      const hit = lastCapHit(state, "plan-spec-mismatch");
      const evidence = hit?.evidence ?? "(no detail recorded)";
      // #1652 — zero accepted calls is not a judged plan. The driver cannot tell
      // "the planner ignored the tool" from "the tool never reached the child", so
      // the sentence names both and the check that separates them, and does not
      // assert the planner drifted.
      if (isNoCallsEvidence(evidence)) {
        return `the plan reply carried no accepted report_workstream call: ${evidence}. The driver cannot tell the two causes apart from the reply. Check the plan child's tool list in its transcript for report_workstream (the companion is loaded with --extension), and run test-pi-shape-live.ts against the installed Pi. If the tool is listed, the planner ignored it and a re-run may succeed; if it is not, the companion did not register and a re-run will park the same way. Nothing was written; the cycle cost one planning dispatch`;
      }
      // #819 — the plan-to-spec gate. The plan was JUDGED, not lost: what the
      // cycle would have built matches nothing the spec asked for.
      return `the plan-to-spec gate refused this plan: ${evidence}. Nothing was written — the gate fires after plan and before branch, so the cycle cost one planning dispatch, not a develop fan-out. The #818 shape this exists to stop: a corrective re-plan came back describing a different problem (a supply-chain overhaul no issue asked for) and four developers built it for 45 minutes because nothing between plan and develop compared the declared paths with the spec's deliverables. Check the issue's deliverables and the plan reply in \`.pi/work-state/${state.issue}/\` — if the spec's paths are stale (files renamed, or the work already landed), revise the issue body and re-run; if the planner drifted, re-run and the gate re-judges the new plan`;
    }
    case "workstream-results-unreadable": {
      // #1652 — the planner made report_workstream calls, but the replay carried
      // no tool results for them. Nothing says the plan was wrong, so the sentence
      // names the channel, not the planner.
      const hit = lastCapHit(state, "workstream-results-unreadable");
      const evidence = hit?.evidence ?? "(no detail recorded)";
      return `the plan's workstream calls could not be judged: ${evidence}. The planner was not found wrong — the tool results did not reach the driver. Nothing was written; re-run \`/work ${state.issue}\` (a plan dispatch costs one planning run, not a develop fan-out)`;
    }
    default:
      return `unhandled explain-plan cap: ${cap}`;
  }
}
