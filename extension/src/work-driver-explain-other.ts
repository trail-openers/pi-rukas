/**
 * work-driver-explain-other — cap-hit explanations for the
 * adversarial-infra-failure and step-back-revise-spec caps. Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
 * bodies of work-driver-explain.ts.
 */

import { classifyFailureCause, failureCauseReason } from "./work-driver-failure-taxonomy.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * #79 — what the adversarial step's last failed dispatch actually died of,
 * classified by the taxonomy: `provider/transport error: Request timed out.
 * (×2 in a row …) [cause=provider-severed]`. Empty when the log holds none.
 *
 * #1634 — for an unreadable diff the event carries `structuredCause`, so the
 * taxonomy reports the environment cause and the reason names the read that
 * failed. Git's stderr rides in `errorTail` but is never what decides the
 * cause, which is why this site needs no special case: `classifyFailureCause`
 * reads the structured field first.
 */
export function adversarialFailureCause(state: WorkState): string {
  const ev = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "dispatch-failed" | "dispatch-failed-provider" }> =>
        (e.kind === "dispatch-failed" || e.kind === "dispatch-failed-provider") &&
        e.step === "adversarial",
    );
  if (!ev) return "";
  const cause = classifyFailureCause(ev).cause;
  // The read that failed is event STRUCTURE, not prose: the taxonomy's reason
  // already quotes `errorTail`, but the operator needs the command to run.
  const which = ev.kind === "dispatch-failed" ? ev.readFailed : undefined;
  const reason = failureCauseReason(ev);
  return which ? `${reason} (read: ${which}) [cause=${cause}]` : `${reason} [cause=${cause}]`;
}

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
      // #1634 — which class of infra failure this is, read STRUCTURALLY. The
      // per-workstream outcome event only carries `readFailed` when the diff
      // read is what failed, so this is the producer's own answer rather than a
      // reading of prose; a single-workstream cycle keeps no such event, so the
      // failed dispatch is consulted too (same field, same rule).
      const failedRead = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "dispatch-failed" }> =>
            e.kind === "dispatch-failed" &&
            e.step === "adversarial" &&
            e.structuredCause === "environment:diff-unreadable",
        );
      const which = out ? `workstream ${out.workstreamId}` : "a workstream";
      const cause = adversarialFailureCause(state);
      // A diff the driver could not read is not "infrastructure" in the
      // provider sense, and the operator needs to know the retry ladder stopped
      // deliberately: waiting does not make git answer.
      const unreadable = out?.readFailed !== undefined || failedRead !== undefined;
      const nature = unreadable
        ? "its diff could not be read, so no reviewer ever saw it"
        : "failed on infrastructure";
      const ladder = unreadable
        ? "the retry ladder did NOT re-run it (an unreadable diff is an environment fact — a re-spawn asks git the same question and gets the same answer)"
        : "was not retried further";
      return `${which}'s adversarial loop ${nature}${cause ? ` (${cause})` : ""} and ${ladder} — NO verdict exists for it, and that is not a review rejection. The other workstreams' completed reviews are preserved in the state file (adversarial-workstream-outcome events); recover by re-running /work, which re-enters the adversarial step and re-runs ONLY the workstream(s) that never produced a verdict`;
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
