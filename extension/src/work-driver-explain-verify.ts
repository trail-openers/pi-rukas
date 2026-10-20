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
 *
 * #1349 — those parks now carry their own caps (`fix-pass-park`,
 * `pr-not-open:<step>`), as do a gate the system refused to run
 * (`verify-env:<step>`) and a gate already red at the base commit
 * (`verify-baseline-red:<step>`). The origin routing stays for state files
 * written before them; each new cap renders the same text its route did.
 */

import { commitPrRootBlurb } from "./work-driver-commit-inspect.ts";
import { BUILD_RESIDUE_LABEL, isBuildResidueFailure } from "./work-driver-dirty-root-classify.ts";
import { HOST_EXHAUSTION_LABEL, isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import {
  GATE_HANG_LABEL,
  GATE_HANG_NO_NAMED_TEST as NO_NAMED_TEST,
  isGateHangFailure,
} from "./work-driver-gate-hang.ts";
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
  return raw === "outcome-gate" ||
    raw === "fix-pass" ||
    raw === "pr-not-open" ||
    // #1439 — the push refusal. It raises its own cap, so it never reaches the
    // `verify-failed:` router's prose branches; naming it here is what keeps the
    // `assertNeverOrigin` switch honest instead of quietly folding a new origin into
    // the outcome-gate route.
    raw === "push-refused"
    ? raw
    : undefined;
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
    // #1439 — a push refusal is its own cap (`push-refused:<step>`), not a
    // `verify-failed:` one, so this route is unreachable by construction. It has to
    // exist for the switch to stay exhaustive over `VerifyEvidenceOrigin`; had the two
    // ever shared the cap, the refusal would be explained as a verify failure, which is
    // exactly the #1439 misdiagnosis.
    case "push-refused":
      return "unrecorded";
    case "outcome-gate":
    case undefined:
      return failures.length > 0 ? "gate" : "unrecorded";
    default:
      return assertNeverOrigin(origin);
  }
}

function prNotOpenText(step: string, failures: readonly string[]): string {
  const when = step === "commit-pr" ? "commit-pr ran again" : `the ${step} step started`;
  return `the cycle's pull request was no longer open when ${when}, so the driver refused before rebuilding or pushing anything:\n${failures.map((f) => `  - ${f}`).join("\n")}\nThe driver read the PR's state from the forge. Nothing was committed, pushed or claimed done on this round, so no "done" claim was rejected and there is no worktree defect to look for. Whether the new work belongs in a new pull request is a human decision`;
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
  // #1439 — the commit-pr push-refusal park carries the same structural log paths the
  // develop caps do (see `runCommitPrLocked`), so the pointer must render there too.
  const logPaths = step === "develop" || step === "commit-pr" ? capHit?.logPaths : undefined;
  if (!logPaths || logPaths.length === 0) return "";
  // #1427 — a hang report is a different artefact from a raw verify log: it
  // names the hung test and the processes the kill left behind, and it is the
  // thing to read FIRST when the cap is a timeout. Splitting the sentence is
  // what makes it a pointer rather than one more file in a list.
  const hang = logPaths.filter((p) => p.includes("gate-hang-"));
  const raw = logPaths.filter((p) => !p.includes("gate-hang-"));
  const parts: string[] = [];
  if (hang.length > 0)
    parts.push(
      `\nWhat hung: ${hang.join(", ")} (names the still-running test(s) and the gate's process tree at the kill — read this before anything else)`,
    );
  if (raw.length > 0)
    parts.push(
      `\nFull raw verify output: ${raw.join(", ")} (scratch dir — inspect it before re-dispatching)`,
    );
  return parts.join("");
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

/**
 * #1323 — the handoff sentence for a park after a sibling-symbol merge, or
 * "" when this cycle did not merge one. Read by the verify-failed
 * explanation so the operator sees the split was merged and still failed.
 */
export function mergedSplitNote(state: WorkState): string {
  const merges = state.eventLog.filter(
    (e): e is Extract<WorkState["eventLog"][number], { kind: "fence-recovery-started" }> =>
      e.kind === "fence-recovery-started" && e.cause === "sibling-symbol",
  );
  if (merges.length === 0) return "";
  const what = merges
    .map(
      (e) =>
        `${e.owners.join(", ")} into ${e.workstreamId} (on ${(e.symbols ?? []).map((s) => `\`${s}\``).join(", ")})`,
    )
    .join("; ");
  return `\nThe driver already merged the split workstreams ${what} and re-ran develop once; the merged workstream still failed, so another re-split or retry will not converge.`;
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
  if (route === "pr-not-open") return `${prNotOpenText(step, failures)}${suffix}`;
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
  if (failures.some(isHostExhaustionFailure)) return hostExhaustionText(step, findings, suffix);
  // #1421 — the gate declined to run because the root held build output, not
  // because anything about the change failed. The generic advice below would
  // send the operator to a diff that was never the problem.
  if (failures.some(isBuildResidueFailure)) return buildResidueText(step, findings, suffix);
  const advice = failures.some((f) => f.startsWith(BASELINE_RED_MARKER))
    ? "The verify command already fails at the cycle's base commit — fix the gate there (or the host it runs on) before inspecting the worktree(s), then re-run."
    : "Inspect the worktree(s), fix or re-dispatch, and re-run.";
  const merged = step === "develop" ? mergedSplitNote(state) : "";
  return `the driver's outcome-verification gate rejected the ${step} step's "done" claim — the claimed result is not backed by executed evidence:${findings}${suffix}${merged}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). ${advice} Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`;
}

function hostExhaustionText(step: string, findings: string, suffix: string): string {
  return `the driver's outcome-verification gate could not run on the ${step} step — the system refused to start a process (fork failed / EAGAIN):${findings}${suffix}\nThe entries marked ${HOST_EXHAUSTION_LABEL} are environment failures, not defects in the change: those checks never executed. They name the pid count and limit where the driver runs — in a container that is the container's own pid limit, not a host ulimit. Check the ceiling named in the evidence (container pid limit, pid_max, RLIMIT_NPROC, memory), clear it if it was hit, then re-run the cycle.`;
}

/**
 * #1421 — the gate declined to mutate a root holding untracked, git-ignored
 * build output. Nothing judged the change, so the recovery is about the tree
 * and the project's build, not the diff.
 */
function buildResidueText(step: string, findings: string, suffix: string): string {
  return `the driver's outcome-verification gate was declined on the ${step} step — the repo root held build output it would have had to mutate:${findings}${suffix}\nThe entries marked ${BUILD_RESIDUE_LABEL} are environment refusals, not defects in the change: the named paths are untracked and git-ignored, so they are a tool's output, not source. The gate refuses to consolidate while ANY dirt sits in the root, and it cannot tell a tool's output from content, so it stopped. Do NOT inspect the diff first — it was never judged. Keep build output out of the checkout the gate runs in (point it at a directory outside the tree, e.g. CARGO_TARGET_DIR, or gitignore it where it lands), clear what is already there, then re-run the cycle`;
}

/** The failures recorded for `step`, else the cap-hit's own evidence. */
function recordedFailures(cap: Cap, state: WorkState, step: string): readonly string[] {
  const evidence = state.pipelineState.verifyEvidence;
  if (evidence?.step === step && evidence.failures.length > 0) return evidence.failures;
  const capEvidence = lastCapHit(state, cap)?.evidence;
  return capEvidence ? [capEvidence] : [];
}

function bullets(failures: readonly string[]): string {
  return failures.map((f) => `\n  - ${f}`).join("") || " (no detail recorded)";
}

/**
 * #1349 — the explanations for the parks that used to share
 * `verify-failed:<step>`. None of them is a verdict on the code.
 */
export function explainNoVerdictCap(cap: Cap, state: WorkState): string | undefined {
  const i = cap.indexOf(":");
  const family = i < 0 ? cap : cap.slice(0, i);
  const step = i < 0 ? "develop" : cap.slice(i + 1);
  const failures = recordedFailures(cap, state, step);
  const ev = state.pipelineState.verifyEvidence;
  const suffix = `${retryLine(ev?.step === step ? ev : undefined)}${rawLogLine(step, lastCapHit(state, cap))}`;
  switch (family) {
    case "verify-env":
      // #1421 fix round — `verify-env` is now TWO refusals: the host could not
      // fork, and (since #1421) a gate declined to mutate a root holding build
      // output. The router picks the cap from the STRUCTURED decline, so the
      // explainer routes on the same field. Reading prose here would print the
      // fork advice (pid limits, RLIMIT_NPROC) for a park whose cause was
      // cargo's `target/`, which is the whole point of the cap split.
      if (ev?.step === step && ev.buildResidueOnly === true)
        return buildResidueText(step, bullets(failures), suffix);
      return hostExhaustionText(step, bullets(failures), suffix);
    case "verify-baseline-red":
      return `the ${step} step's verify command already fails at the cycle's base commit, without this change — the gate was red before the change was written, so no change can pass it and it reached no verdict on this one:${bullets(failures)}${suffix}\nFix the gate at the base commit (or the host it runs on) first, then re-run the cycle. The change is not implicated until the base is green. Do not set PI_ENSEMBLE_VERIFY=0 for this: the gate is broken at base, not wrong about the change`;
    case "pr-not-open":
      return `${prNotOpenText(step, failures)}${suffix}`;
    case "fix-pass-park":
      return explainFixPassPark(bullets(failures), suffix);
    default:
      return undefined;
  }
}

/**
 * #1324 — `verify-timeout:<step>`: the verify run was killed at its bound, so
 * nothing judged the code. The findings carry the bound; the recovery is
 * about time and host load, not the diff. The develop gate records its
 * findings on verifyEvidence; the commit-pr seam carries them on the cap.
 */
export function explainVerifyTimeout(cap: Cap, state: WorkState): string {
  const step = cap.slice("verify-timeout:".length);
  const evidence = state.pipelineState.verifyEvidence;
  const capEvidence = lastCapHit(state, cap)?.evidence;
  const failures =
    evidence?.step === step && evidence.failures.length > 0
      ? evidence.failures
      : capEvidence
        ? [capEvidence]
        : [];
  const findings = failures.map((f) => `\n  - ${f}`).join("") || " (no detail recorded)";
  // #1427 — a killed run that produced a hang report says WHICH test hung and
  // how many processes its group still held; render that line too, so the
  // handoff answers "what hung" rather than only "it was slow". The paths ride
  // on the cap event (develop) or are absent (the commit-pr seam, which has no
  // scratch dir of its own to write to).
  const hangLine = rawLogLine(step, capEvidence === undefined ? undefined : lastCapHit(state, cap));
  // The runner's own slow-test line is what makes a hang report name a test.
  // When it printed none, `gateHangClause` renders "hung in no named test" —
  // that is the string to look for, not "still running:", which only ever
  // appears in the full report file (which the failure string never carries).
  // The clause's own no-name marker is what the advice keys on (#1427 fix
  // round: it keyed on a string no failure ever contains, so the advice
  // printed for every hang, named test or not).
  const noNamedTest = failures.some((f) =>
    f.includes(`${GATE_HANG_LABEL} hung in ${NO_NAMED_TEST}`),
  );
  const hangAdvice =
    failures.some(isGateHangFailure) && noNamedTest
      ? " The runner printed no slow-test line, so the report's process tree is the only name the driver could establish — read it before suspecting the diff."
      : "";
  const knob =
    step === "commit-pr"
      ? "PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS"
      : "PI_ENSEMBLE_VERIFY_TIMEOUT_MS";
  return `the ${step} step's verify command TIMED OUT — the run was killed at its bound (${knob}) and reached no verdict, so this is not a code failure and the change is neither confirmed nor refuted:${findings}${hangLine}${retryLine(evidence?.step === step ? evidence : undefined)}${hangAdvice}\nGive the gate more time or more of the host, then re-run the cycle: raise ${knob}, or reduce concurrency (fewer workstreams with PI_ENSEMBLE_MAX_WORKSTREAMS, fewer cycles at once with PI_ENSEMBLE_PARALLEL_GROUPS, nothing else heavy on the host). A \`.pi/verify-cmd-fast\` (typecheck/lint) runs before the full command and fails fast on a type error. Do not set PI_ENSEMBLE_VERIFY=0 for this: the gate did not reject the change, it did not finish`;
}
