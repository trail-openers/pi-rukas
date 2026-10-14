/**
 * work-driver-explain-verify — the `verify-failed:<step>` explanation.
 * Split from work-driver-explain.ts so that file stays under the 500-line
 * cap. A verify-failed cap is reused by parks the outcome gate never raised
 * (the adversarial fix pass, the commit-pr re-entry refusal). Each writer
 * records where its park came from on `verifyEvidence.origin`, and the
 * explanation routes on that field through ONE decision (`routeVerifyFailed`).
 * State files written before `origin` existed fall back to the text markers,
 * honoured only when every failure carries the marker.
 */

import { HOST_EXHAUSTION_LABEL, isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { BASELINE_RED_MARKER } from "./work-driver-verify-baseline.ts";
import {
  type CapHitEvent,
  FIX_PASS_EVIDENCE_PREFIX,
  PR_NOT_OPEN_MARKER,
  lastCapHit,
} from "./workflow-state-cap.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/** The one routing decision for a `verify-failed:<step>` cap. */
export type VerifyFailedRoute = "fix-pass" | "pr-not-open" | "gate" | "unrecorded";

/** The fix pass's own reason on the cap-hit, when the cap carries one. */
function fixPassCapEvidence(cap: Cap, state: WorkState): string | undefined {
  const evidence = lastCapHit(state, cap)?.evidence;
  return evidence?.startsWith(FIX_PASS_EVIDENCE_PREFIX) ? evidence : undefined;
}

/**
 * Decides, once, which explanation a verify-failed cap gets. An explicit
 * `origin` wins outright. Without one (a legacy state file) a marker is
 * honoured only when EVERY failure carries it, so a real gate failure beside
 * a marker stays a gate failure.
 */
export function routeVerifyFailed(cap: Cap, state: WorkState): VerifyFailedRoute {
  const evidence = state.pipelineState.verifyEvidence;
  const failures = evidence?.failures ?? [];
  if (evidence?.origin === "fix-pass") return "fix-pass";
  if (evidence?.origin === "pr-not-open") return "pr-not-open";
  if (evidence?.origin === "outcome-gate") return failures.length === 0 ? "unrecorded" : "gate";
  if (
    fixPassCapEvidence(cap, state) !== undefined &&
    failures.every((f) => f.startsWith(FIX_PASS_EVIDENCE_PREFIX))
  ) {
    return "fix-pass";
  }
  if (failures.length > 0 && failures.every((f) => f.startsWith(PR_NOT_OPEN_MARKER))) {
    return "pr-not-open";
  }
  if (failures.length > 0 && failures.every((f) => f.startsWith(FIX_PASS_EVIDENCE_PREFIX))) {
    return "fix-pass";
  }
  return failures.length === 0 ? "unrecorded" : "gate";
}

function prNotOpenText(failures: readonly string[]): string {
  return `the cycle's pull request was no longer open when commit-pr ran again, so the driver refused before rebuilding or pushing anything:\n${failures.map((f) => `  - ${f}`).join("\n")}\nThe driver read the PR's state from the forge. Nothing was committed, pushed or claimed done on this round, so no "done" claim was rejected and there is no worktree defect to look for. Whether the new work belongs in a new pull request is a human decision`;
}

/**
 * The commit-pr re-entry refusal, or `undefined` for a real outcome-gate
 * failure. Nothing was committed, pushed or claimed on that round, so the
 * gate's "done claim rejected" sentence would describe something that did not
 * happen.
 */
export function explainPrNotOpen(cap: Cap, state: WorkState): string | undefined {
  if (routeVerifyFailed(cap, state) !== "pr-not-open") return undefined;
  return prNotOpenText(state.pipelineState.verifyEvidence?.failures ?? []);
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

/**
 * #841 — when the cap carries the persisted raw-output log paths STRUCTURALLY
 * (the consolidated verify's run1/run2 logs, recorded on the cap-hit event's
 * `logPaths` by the gate's emit site), render them. The paths ride on the
 * event, never parsed out of prose. Absent on pre-#841 state files.
 */
function rawLogLine(step: string, capHit: CapHitEvent | undefined): string {
  const logPaths = step === "develop" ? capHit?.logPaths : undefined;
  return logPaths && logPaths.length > 0
    ? `\nFull raw verify output: ${logPaths.join(", ")} (scratch dir — inspect it before re-dispatching)`
    : "";
}

/**
 * #782 — the consolidated-verify gate re-runs the verify command once before
 * classifying. Say so, so the operator can tell a genuine double failure from
 * one that recovered. Absent on pre-#782 state files (no re-run, no suffix).
 */
function retryLine(evidence: WorkState["pipelineState"]["verifyEvidence"]): string {
  if (!evidence || (evidence.retries ?? 0) <= 0) return "";
  const n = evidence.retries ?? 0;
  const verb = n === 1 ? "retried once" : `retried ${n} times`;
  return evidence.recovered
    ? `\nNote: the verify command was ${verb} and RECOVERED — the recorded failure was a transient flake; inspect the worktree(s) to confirm nothing else changed.`
    : `\nNote: the verify command was ${verb} and still failed — this is a real failure, not a flake.`;
}

// PR17 — `verify-failed:<step>`: the driver-side outcome gate found
// the step's claimed result isn't backed by executed evidence. The
// per-check findings live in pipelineState.verifyEvidence.
export function explainVerifyFailed(cap: Cap, state: WorkState): string {
  const step = cap.slice("verify-failed:".length);
  const evidence = state.pipelineState.verifyEvidence;
  const failures = evidence?.failures ?? [];
  const route = routeVerifyFailed(cap, state);
  if (route === "fix-pass") {
    // #1137 — a fix-pass park writes its detail on the cap-hit's own
    // `evidence`; prefer it, since `failures` may be empty on that path.
    const capEvidence = fixPassCapEvidence(cap, state);
    return explainFixPassPark(
      capEvidence ? `\n${capEvidence}` : `\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
  if (route === "pr-not-open") return prNotOpenText(failures);
  const capHit = lastCapHit(state, cap);
  const suffix = `${retryLine(evidence)}${rawLogLine(step, capHit)}`;
  // No recorded failure means this text cannot say which check refused the
  // step, or that the driver ran one: the gate's sentence below would be a
  // claim about checks nothing on the state file shows were executed.
  if (route === "unrecorded") {
    const recorded = capHit?.evidence
      ? ` The cap-hit event itself carries: ${capHit.evidence}.`
      : "";
    return `the ${step} step parked as verify-failed, but the state file does not record the reason — no check result was saved with the cap, so this message cannot say which check refused the step or whether the project's verify command ran at all.${recorded}${suffix} Read the plumb reports in the handoff body and the event log for the reason before changing anything`;
  }
  const findings = `\n${failures.map((f) => `  - ${f}`).join("\n")}`;
  // Neither a check the host could not fork nor a gate already red at the
  // base judged the change: "inspect the worktree(s)" would be wrong advice.
  if (failures.some(isHostExhaustionFailure)) {
    return `the driver's outcome-verification gate could not run on the ${step} step — the host refused to start a process (fork failed / EAGAIN):${findings}${suffix}\nThe entries marked ${HOST_EXHAUSTION_LABEL} are environment failures, not defects in the change: those checks never executed. Free processes on the host (or raise its pid limit), then re-run the cycle`;
  }
  const advice = failures.some((f) => f.startsWith(BASELINE_RED_MARKER))
    ? "The verify command already fails at the cycle's base commit — fix the gate there (or the host it runs on) before inspecting the worktree(s), then re-run."
    : "Inspect the worktree(s), fix or re-dispatch, and re-run.";
  return `the driver's outcome-verification gate rejected the ${step} step's "done" claim — the claimed result is not backed by executed evidence:${findings}${suffix}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). ${advice} Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`;
}
