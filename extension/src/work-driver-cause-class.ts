/**
 * work-driver-cause-class — #1675: the cause class, reason, evidence and user
 * action of one park or failure, derived from the cap, the failure kind and
 * structured evidence. Pure: reads a WorkState, never writes, never reads
 * prose to decide a class.
 *
 * Order of derivation (first match wins):
 *   1. no cap recorded          → pi-rukas (the driver lost its own record)
 *   2. awaiting-human-merge     → no class: the work is done, it is not a failure
 *   3. verify-failed:<step>     → verifyVerdict: the route is read from the
 *                                 structured origin, the protected-path and
 *                                 empty-diff markers, and extracted check lines
 *   4. every other cap          → its FIXED_CAP_CAUSE / TEMPLATE_CAP_CAUSE entry;
 *                                 a kind-driven entry takes its class from the
 *                                 failed dispatch's failure kind (KIND_CLASS)
 *
 * The `causeEvidence` lines are bounded (six lines, 300 characters each) and
 * redacted. Extracted check lines are used as evidence, never the raw tail,
 * so a dependency hint cannot ride in on a line the classifier did not accept.
 */

import { redactClip } from "./decision-log.ts";
import type { CAP_TEMPLATES, FixedCap } from "./headless/caps.ts";
import type { ResultFailure } from "./headless/failure.ts";
import { EMPTY_ROUND_FAILURE } from "./work-develop-verify-failure.ts";
import {
  ACTION_FOR_CLASS,
  type CapCause,
  type CauseClass,
  FIXED_CAP_CAUSE,
  KIND_CLASS,
  TEMPLATE_CAP_CAUSE,
} from "./work-driver-cause-table.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "./work-driver-consolidation-classify.ts";
import { isBuildResidueFailure } from "./work-driver-dirty-root-classify.ts";
import { UNGRANTED_PROTECTED_MARK } from "./work-driver-doctrine.ts";
import { isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { BASELINE_RED_MARKER } from "./work-driver-verify-baseline.ts";
import { INTEGRATE_CREATE_FAILED_PREFIX, lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/** What a park or failure carries for the headless result and every renderer. */
export interface CauseVerdict {
  /** Absent for a non-failure (awaiting merge). */
  causeClass?: CauseClass;
  /** One plain sentence: why the cycle stopped. */
  causeReason: string;
  /** Bounded, redacted evidence lines: the failing checks, the denied command, the provider's words. */
  causeEvidence: string[];
  /** What the user can do, with the issue number filled in; null for pi-rukas (the defect is ours). */
  userAction: string | null;
}

export const EVIDENCE_MAX_LINES = 6;
const LINE_MAX = 300;

/** Trimmed, de-duplicated, bounded, redacted lines of `text`. */
function evidenceLines(texts: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const raw of (text ?? "").split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || out.includes(redactClip(line, LINE_MAX))) continue;
      if (out.length < EVIDENCE_MAX_LINES) out.push(redactClip(line, LINE_MAX));
    }
  }
  return out;
}

/** The action for a class, with `{issue}` filled in; null when there is none. */
function actionOf(cls: CauseClass, rule: CapCause | undefined, issue: number): string | null {
  const raw = rule && rule.cls === cls ? rule.action : ACTION_FOR_CLASS[cls];
  return raw === null ? null : raw.replaceAll("{issue}", String(issue));
}

/** A failure read from a dispatch carries structured fields; a cap-derived one does not. */
function dispatchDerived(failure: ResultFailure | undefined): boolean {
  return (
    failure !== undefined &&
    (failure.cause !== undefined ||
      failure.killCause !== undefined ||
      failure.providerMessage !== undefined ||
      failure.errorTail !== undefined ||
      failure.exitCode !== undefined)
  );
}

/** The table entry a cap names: a fixed literal first, then its template family. */
export function capRuleOf(cap: string): CapCause | undefined {
  if (Object.prototype.hasOwnProperty.call(FIXED_CAP_CAUSE, cap)) {
    return FIXED_CAP_CAUSE[cap as FixedCap];
  }
  const i = cap.indexOf(":");
  if (i < 0) return undefined;
  const family = cap.slice(0, i);
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_CAP_CAUSE, family)) return undefined;
  return TEMPLATE_CAP_CAUSE[family as keyof typeof CAP_TEMPLATES];
}

/** Evidence for a dispatch-derived failure, or the cap-hit's own evidence. */
function capEvidence(state: WorkState, cap: string, failure: ResultFailure | undefined): string[] {
  const hit = lastCapHit(state, cap)?.evidence;
  if (failure !== undefined && dispatchDerived(failure)) {
    const tail = failure.errorTail
      ?.split("\n")
      .filter((l) => l.trim().length > 0)
      .pop();
    return evidenceLines([failure.providerMessage, failure.message, tail, failure.evidence]);
  }
  return evidenceLines([hit, failure?.message]);
}

/** The awaiting-merge verdict: not a failure, so no class. */
function awaitingVerdict(issue: number): CauseVerdict {
  return {
    causeReason:
      "all the work is done and pushed, and only the merge is held — this is a hold, not a failure",
    causeEvidence: [],
    userAction: `merge the PR, or grant merge authority (AGENTS.md section 9, or --merge) and re-run \`/work ${issue}\``,
  };
}

/** The text of every assertion line the verify failures carry, in order. */
function assertionLinesOf(failures: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of failures) {
    for (const raw of f.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || out.includes(line)) continue;
      if (extractSpecificAssertion(line) === NO_SPECIFIC_ASSERTION) continue;
      out.push(line);
    }
  }
  return out;
}

/** The last developer report from the develop step, if the developer wrote one. */
function developerReport(state: WorkState): string | undefined {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (
      e?.kind === "dispatch-completed" &&
      e.step === "develop" &&
      e.role === "developer" &&
      e.summary?.trim()
    ) {
      return e.summary;
    }
  }
  return undefined;
}

/** `verify-failed:<step>` — routed on the structured origin and the failure markers. */
function verifyVerdict(state: WorkState, cap: string, issue: number): CauseVerdict {
  const step = cap.slice("verify-failed:".length);
  const ev = state.pipelineState.verifyEvidence;
  const failures = ev?.failures ?? [];
  const hit = lastCapHit(state, cap)?.evidence;
  const verdict = (
    cls: CauseClass,
    reason: string,
    evidence: string[],
    rule?: CapCause,
  ): CauseVerdict => ({
    causeClass: cls,
    causeReason: reason,
    causeEvidence: evidence,
    userAction: actionOf(cls, rule, issue),
  });
  const changeRule = TEMPLATE_CAP_CAUSE["verify-failed"];
  const envRule = TEMPLATE_CAP_CAUSE["verify-env"];

  // The PR was closed under the cycle: a person decides where the new work goes.
  if (ev?.origin === "pr-not-open") {
    return verdict(
      "issue",
      TEMPLATE_CAP_CAUSE["pr-not-open"].reason,
      evidenceLines(failures),
      TEMPLATE_CAP_CAUSE["pr-not-open"],
    );
  }
  // A protected path edited without this cycle's grant: only the operator can grant it.
  const protectedHit = failures.find((f) => f.includes(UNGRANTED_PROTECTED_MARK));
  if (protectedHit !== undefined) {
    return {
      causeClass: "issue",
      causeReason:
        "the change edits protected paths (CI, the verify command, the policy files) that this cycle was not granted",
      causeEvidence: evidenceLines([protectedHit]).slice(0, 1),
      userAction: `if the change is genuinely wanted, grant the paths named in the evidence with \`/work ${issue} --restart --allow-protected <paths>\` after reviewing each diff; otherwise make the change without them, then re-run \`/work ${issue} --restart\``,
    };
  }
  // The adversarial fix pass parked on its own checks: the cycle's own code.
  if (ev?.origin === "fix-pass") {
    return verdict(
      "change",
      "the adversarial fix pass did not clear its own checks on the change",
      evidenceLines([hit, ...failures]),
      changeRule,
    );
  }
  // The developer changed nothing. Its own report is the one thing that says why.
  if (failures.some((f) => EMPTY_ROUND_FAILURE.test(f))) {
    const report = developerReport(state);
    if (report !== undefined) {
      return {
        causeClass: "pi-rukas",
        causeReason:
          "the develop step's developer changed nothing and reported why it could not act, so the driver routed that dead end into a verify park (a driver defect, not the issue)",
        causeEvidence: evidenceLines([`developer's report: ${report.trim().split("\n")[0] ?? ""}`]),
        userAction: null,
      };
    }
    return verdict(
      "change",
      "the develop step finished with no code change and the developer gave no reason for it",
      evidenceLines(failures),
      changeRule,
    );
  }
  // The host, the base or the repo root judged the environment, not the change.
  if (failures.some(isHostExhaustionFailure)) {
    return verdict(
      "environment",
      "the host refused to start a process, so the verify command never judged the change",
      evidenceLines(failures),
      envRule,
    );
  }
  if (failures.some(isBuildResidueFailure)) {
    return verdict(
      "environment",
      "build output at the repo root stopped the gate before it judged the change",
      evidenceLines(failures),
      envRule,
    );
  }
  if (failures.some((f) => f.startsWith(BASELINE_RED_MARKER))) {
    return verdict(
      "environment",
      TEMPLATE_CAP_CAUSE["verify-baseline-red"].reason,
      evidenceLines(failures),
      TEMPLATE_CAP_CAUSE["verify-baseline-red"],
    );
  }
  // The verify command ran and named the failing checks: the cycle's own code.
  const assertions = assertionLinesOf(failures);
  if (assertions.length > 0) {
    return verdict(
      "change",
      `the verify command failed: ${assertions[0]}`,
      evidenceLines(assertions),
      changeRule,
    );
  }
  if (failures.length > 0) {
    return verdict(
      "change",
      "the verify command failed and no specific failing line could be extracted — see the raw output",
      evidenceLines(failures.slice(0, 1)),
      changeRule,
    );
  }
  // A park with no recorded check result: the driver cannot say what refused the step.
  return {
    causeClass: "pi-rukas",
    causeReason:
      "the develop gate parked without recording a check result, so the driver cannot say which check refused the step (a gap in the driver's own record)",
    causeEvidence: evidenceLines([hit]),
    userAction: null,
  };
}

/** The verdict for one park or failure. Undefined only when the cycle merged. */
export function causeVerdictOf(
  state: WorkState,
  cap: string | undefined,
  failure: ResultFailure | undefined,
): CauseVerdict | undefined {
  if (state.pipelineState.status === "merged") return undefined;
  const issue = state.issue;
  if (cap === undefined) {
    return {
      causeClass: "pi-rukas",
      causeReason:
        "the cycle stopped without recording the gate that stopped it (a gap in the driver's own record)",
      causeEvidence: [],
      userAction: null,
    };
  }
  if (cap === "awaiting-human-merge") return awaitingVerdict(issue);
  if (cap.startsWith("verify-failed:")) return verifyVerdict(state, cap, issue);
  const rule = capRuleOf(cap);
  if (rule === undefined) {
    return {
      causeClass: "pi-rukas",
      causeReason: `the driver recorded the cap ${cap}, which this build does not classify (a driver defect)`,
      causeEvidence: capEvidence(state, cap, failure),
      userAction: null,
    };
  }
  // Git refused to create the integrate worktree: the environment, not the driver's invariant.
  if (cap === "integration-worktree-violation") {
    const ev = lastCapHit(state, cap)?.evidence ?? "";
    if (ev.startsWith(INTEGRATE_CREATE_FAILED_PREFIX)) {
      return {
        causeClass: "environment",
        causeReason: "git refused to create the driver-owned integrate worktree",
        causeEvidence: evidenceLines([ev.slice(INTEGRATE_CREATE_FAILED_PREFIX.length)]),
        userAction: actionOf("environment", undefined, issue),
      };
    }
  }
  const kindClass =
    rule.kindDriven && failure !== undefined && dispatchDerived(failure)
      ? KIND_CLASS[failure.kind]
      : undefined;
  const cls: CauseClass = kindClass ?? rule.cls;
  return {
    causeClass: cls,
    causeReason: rule.reason,
    causeEvidence: capEvidence(state, cap, failure),
    userAction: actionOf(cls, rule, issue),
  };
}
