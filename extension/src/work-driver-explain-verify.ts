/**
 * work-driver-explain-verify — the `verify-failed:<step>` explanation.
 * Split from work-driver-explain.ts so that file stays under the 500-line
 * cap. A verify-failed cap is reused by parks the outcome gate never raised
 * (the adversarial fix pass, the commit-pr re-entry refusal). Each writer
 * records where its park came from on `verifyEvidence.origin`, and the
 * explanation routes on that field alone (`routeVerifyFailed`). The failure
 * strings are text for the operator and never drive routing. A state file
 * with no origin, or an origin this build does not know, renders as the
 * outcome gate did before origin existed.
 */

import { commitPrRootBlurb } from "./work-driver-commit-inspect.ts";
import {
  HOST_EXHAUSTION_LABEL,
  HOST_EXHAUSTION_RUNBOOK,
  isHostExhaustionFailure,
} from "./work-driver-exec-error.ts";
import { BASELINE_RED_MARKER } from "./work-driver-verify-baseline.ts";
import { type CapHitEvent, lastCapHit } from "./workflow-state-cap.ts";
import type { VerifyEvidenceOrigin } from "./workflow-state-schema-verify.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/** The one routing decision for a `verify-failed:<step>` cap. */
export type VerifyFailedRoute = "fix-pass" | "pr-not-open" | "gate" | "unrecorded";

/** The recorded origin, or `undefined` when absent or unknown to this build (treated as absent). */
function originOf(state: WorkState): VerifyEvidenceOrigin | undefined {
  const raw: string | undefined = state.pipelineState.verifyEvidence?.origin;
  return raw === "outcome-gate" || raw === "fix-pass" || raw === "pr-not-open" ? raw : undefined;
}

/**
 * The fix pass's own reason on the cap-hit. Read only on the fix-pass origin.
 * Not used on the gate route: the cap's evidence is a bounded join of
 * verifyEvidence.failures, and the per-failure bullets (with fence attribution)
 * are the richer rendering.
 */
function fixPassCapEvidence(cap: Cap, state: WorkState): string | undefined {
  return lastCapHit(state, cap)?.evidence;
}

function assertNeverOrigin(origin: never): never {
  throw new Error(`unhandled verify-evidence origin: ${String(origin)}`);
}

/**
 * Decides, once, which explanation a verify-failed cap gets. Routes on
 * `origin` alone. An empty failure list with no reason recorded anywhere on
 * the cap is `unrecorded` on every route.
 */
export function routeVerifyFailed(cap: Cap, state: WorkState): VerifyFailedRoute {
  const failures = state.pipelineState.verifyEvidence?.failures ?? [];
  const origin = originOf(state);
  switch (origin) {
    case "fix-pass":
      return failures.length > 0 || fixPassCapEvidence(cap, state) !== undefined
        ? "fix-pass"
        : "unrecorded";
    case "pr-not-open":
      return failures.length > 0 ? "pr-not-open" : "unrecorded";
    case "outcome-gate":
    case undefined:
      return failures.length > 0 ? "gate" : "unrecorded";
    default:
      return assertNeverOrigin(origin);
  }
}

function prNotOpenText(failures: readonly string[]): string {
  return `the cycle's pull request was no longer open when commit-pr ran again, so the driver refused before rebuilding or pushing anything:\n${failures.map((f) => `  - ${f}`).join("\n")}\nThe driver read the PR's state from the forge. Nothing was committed, pushed or claimed done on this round, so no "done" claim was rejected and there is no worktree defect to look for. Whether the new work belongs in a new pull request is a human decision`;
}

/**
 * The adversarial fix pass parks on its own checks (scope fence, no-op pass,
 * origin/main comment retention, a read that failed closed) under this cap.
 * The outcome gate rejected nothing, and the pass does not consult
 * PI_ENSEMBLE_VERIFY.
 */
function explainFixPassPark(findings: string, suffix: string): string {
  return `the adversarial fix pass did not clear, so the cycle parked before commit-pr — the fix pass raised this park itself, and the reason it recorded is the whole of it:${findings}${suffix}\nThis is not the outcome-verification gate refusing the develop step's first-round work, and the entry above is not output of the project's verify command. The change, including whatever the pass edited, is still in the cycle's worktree(s); the review findings the pass was answering are in the handoff's plumb report. Act on the reason above, then re-run the cycle`;
}

/**
 * The commit-pr outcome-gate sentence: the text the consolidation explainer
 * carried before this module owned every verify-failed cap. The per-check
 * findings live in the handoff body, so they are not repeated here.
 */
function commitPrGateText(state: WorkState): string {
  const rootBlurb = commitPrRootBlurb(
    state.pipelineState.commitPrRoot,
    state.pipelineState.commitPrRootError,
    "the recovery commands below apply as-is",
  );
  return `the driver's outcome-verification gate rejected the commit-pr step's "done" claim — the committed + pushed + PR-opened claim is not backed by executed evidence. The per-check findings are in the handoff body; inspect the recorded repoRoot state there and re-run.${rootBlurb}`;
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
  const capHit = lastCapHit(state, cap);
  // The verify-run suffixes describe the command, not the writer, so every route gets them.
  const suffix = `${retryLine(evidence)}${rawLogLine(step, capHit)}`;
  const findings = `\n${failures.map((f) => `  - ${f}`).join("\n")}`;
  if (route === "fix-pass") {
    // #1137 — a fix-pass park writes its detail on the cap-hit's own
    // `evidence`; prefer it, since `failures` may be empty on that path.
    const capEvidence = fixPassCapEvidence(cap, state);
    return explainFixPassPark(capEvidence ? `\n${capEvidence}` : findings, suffix);
  }
  if (route === "pr-not-open") return `${prNotOpenText(failures)}${suffix}`;
  // No recorded failure means this text cannot say which check refused the
  // step, or that the driver ran one: the gate's sentence below would be a
  // claim about checks nothing on the state file shows were executed.
  if (route === "unrecorded") {
    const recorded = capHit?.evidence
      ? ` The cap-hit event itself carries: ${capHit.evidence}.`
      : "";
    return `the ${step} step parked as verify-failed, but the state file does not record the reason — no check result was saved with the cap, so this message cannot say which check refused the step or whether the project's verify command ran at all.${recorded}${suffix} Read the plumb reports in the handoff body and the event log for the reason before changing anything`;
  }
  if (step === "commit-pr") return commitPrGateText(state);
  // Neither a check the host could not fork nor a gate already red at the
  // base judged the change: "inspect the worktree(s)" would be wrong advice.
  if (failures.some(isHostExhaustionFailure)) {
    return `the driver's outcome-verification gate could not run on the ${step} step — the system refused to start a process (fork failed / EAGAIN):${findings}${suffix}\nThe entries marked ${HOST_EXHAUSTION_LABEL} are environment failures, not defects in the change: those checks never executed. They name the pid count and limit where the driver runs — in a container that is the container's own pid limit, not a host ulimit. Clear the limit that was hit, then re-run the cycle. ${HOST_EXHAUSTION_RUNBOOK}`;
  }
  const advice = failures.some((f) => f.startsWith(BASELINE_RED_MARKER))
    ? "The verify command already fails at the cycle's base commit — fix the gate there (or the host it runs on) before inspecting the worktree(s), then re-run."
    : "Inspect the worktree(s), fix or re-dispatch, and re-run.";
  return `the driver's outcome-verification gate rejected the ${step} step's "done" claim — the claimed result is not backed by executed evidence:${findings}${suffix}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). ${advice} Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`;
}
