/**
 * work-driver-explain-verify — the `verify-failed:<step>` explanation.
 * Split from work-driver-explain.ts so that file stays under the 500-line
 * cap. The cap is reused by parks the outcome gate never raised; their
 * writers lead the failure string with a marker (`FIX_PASS_EVIDENCE_PREFIX`,
 * `PR_NOT_OPEN_MARKER`), and the explanation routes on it rather than on the
 * prose around it.
 */

import { HOST_EXHAUSTION_LABEL, isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { BASELINE_RED_MARKER } from "./work-driver-verify-baseline.ts";
import { FIX_PASS_EVIDENCE_PREFIX, lastCapHit } from "./workflow-state-cap.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/** Leads the failure string of a commit-pr re-entry refused on a PR that is not open. */
export const PR_NOT_OPEN_MARKER = "[pr-not-open]";

/**
 * The commit-pr re-entry refusal, or `undefined` for a real outcome-gate
 * failure. Nothing was committed, pushed or claimed on that round, so the
 * gate's "done claim rejected" sentence would describe something that did not
 * happen.
 */
export function explainPrNotOpen(state: WorkState): string | undefined {
  const failures = state.pipelineState.verifyEvidence?.failures ?? [];
  if (!failures.some((f) => f.startsWith(PR_NOT_OPEN_MARKER))) return undefined;
  return `the cycle's pull request was no longer open when commit-pr ran again, so the driver refused before rebuilding or pushing anything:\n${failures.map((f) => `  - ${f}`).join("\n")}\nThe driver read the PR's state from the forge. Nothing was committed, pushed or claimed done on this round, so no "done" claim was rejected and there is no worktree defect to look for. Whether the new work belongs in a new pull request is a human decision`;
}

/**
 * The adversarial fix pass parks on its own checks (scope fence, no-op pass,
 * origin/main comment retention, a read that failed closed) under this cap.
 * The outcome gate rejected nothing, and the pass does not consult
 * PI_ENSEMBLE_VERIFY.
 */
function explainFixPassPark(findings: string): string {
  return `the adversarial fix pass did not clear, so the cycle parked before commit-pr — the fix pass raised this park itself, and the reason it recorded is the whole of it:${findings}\nThis is not the outcome-verification gate refusing the develop step's first-round work, and the entry above is not output of the project's verify command. The change, including whatever the pass edited, is still in the cycle's worktree(s); the review findings the pass was answering are in the handoff's plumb report. Act on the reason above, then re-run the cycle`;
}

// PR17 — `verify-failed:<step>`: the driver-side outcome gate found
// the step's claimed result isn't backed by executed evidence. The
// per-check findings live in pipelineState.verifyEvidence.
export function explainVerifyFailed(cap: Cap, state: WorkState): string {
  const step = cap.slice("verify-failed:".length);
  const evidence = state.pipelineState.verifyEvidence;
  // #1137 — a fix-pass park (parkFixPass) writes its detail on the cap-hit's
  // own `evidence` string, and `verifyEvidence.failures` is never written on
  // that path, so the "Why" read "(evidence detail missing from state)".
  // Prefer the cap's evidence ONLY for fix-pass caps: the generic develop
  // verify cap also carries evidence, but it is a bounded join of the same
  // failures, and the per-failure bullets (with fence attribution) are the
  // richer rendering for it.
  const capHit = lastCapHit(state, cap);
  const capEvidence = capHit?.evidence?.startsWith(FIX_PASS_EVIDENCE_PREFIX)
    ? capHit.evidence
    : undefined;
  const failures = evidence?.failures ?? [];
  if (capEvidence) return explainFixPassPark(`\n${capEvidence}`);
  // No recorded failure means this text cannot say which check refused the
  // step, or that the driver ran one: the gate's sentence below would be a
  // claim about checks nothing on the state file shows were executed.
  if (failures.length === 0) {
    const recorded = capHit?.evidence
      ? ` The cap-hit event itself carries: ${capHit.evidence}.`
      : "";
    return `the ${step} step parked as verify-failed, but the state file does not record the reason — no check result was saved with the cap, so this message cannot say which check refused the step or whether the project's verify command ran at all.${recorded} Read the plumb reports in the handoff body and the event log for the reason before changing anything`;
  }
  const findings = `\n${failures.map((f) => `  - ${f}`).join("\n")}`;
  if (failures.every((f) => f.startsWith(FIX_PASS_EVIDENCE_PREFIX))) {
    return explainFixPassPark(findings);
  }
  // #841 — when the cap carries the persisted raw-output log paths
  // STRUCTURALLY (the consolidated verify's run1/run2 logs, recorded on
  // the cap-hit event's `logPaths` field by the gate's emit site), render
  // them here. The failure-string bullets above already name the path, but
  // the operator reads the closing sentence for WHERE to look; an empty
  // failures list otherwise leaves
  // the log path reachable only from the raw event. No prose scanning —
  // the paths ride on the event, never parsed out of it. Absent on
  // pre-#841 state files (say nothing rather than guess).
  let logLine = "";
  if (step === "develop") {
    const logPaths = capHit?.logPaths;
    if (logPaths && logPaths.length > 0) {
      logLine = `\nFull raw verify output: ${logPaths.join(", ")} (scratch dir — inspect it before re-dispatching)`;
    }
  }
  // #782 — the consolidated-verify gate re-runs the verify command once
  // before classifying. When the re-run happened, say so so the operator
  // can tell a genuine double failure from one that recovered; absent on
  // pre-#782 state files (treat absent as "no re-run", no suffix).
  let retryNote = "";
  if (evidence && (evidence.retries ?? 0) > 0) {
    const n = evidence.retries;
    const verb = n === 1 ? "retried once" : `retried ${n} times`;
    retryNote = evidence.recovered
      ? `\nNote: the verify command was ${verb} and RECOVERED — the recorded failure was a transient flake; inspect the worktree(s) to confirm nothing else changed.`
      : `\nNote: the verify command was ${verb} and still failed — this is a real failure, not a flake.`;
  }
  // Neither a check the host could not fork nor a gate already red at the
  // base judged the change: "inspect the worktree(s)" would be wrong advice.
  if (evidence?.failures.some(isHostExhaustionFailure)) {
    return `the driver's outcome-verification gate could not run on the ${step} step — the host refused to start a process (fork failed / EAGAIN):${findings}${retryNote}${logLine}\nThe entries marked ${HOST_EXHAUSTION_LABEL} are environment failures, not defects in the change: those checks never executed. Free processes on the host (or raise its pid limit), then re-run the cycle`;
  }
  const advice = evidence?.failures.some((f) => f.startsWith(BASELINE_RED_MARKER))
    ? "The verify command already fails at the cycle's base commit — fix the gate there (or the host it runs on) before inspecting the worktree(s), then re-run."
    : "Inspect the worktree(s), fix or re-dispatch, and re-run.";
  return `the driver's outcome-verification gate rejected the ${step} step's "done" claim — the claimed result is not backed by executed evidence:${findings}${retryNote}${logLine}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). ${advice} Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`;
}
