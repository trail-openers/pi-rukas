/**
 * work-driver-cause-class — #1675: the cause class, reason, evidence and user
 * action of one park or failure, derived from the cap, the failure kind and
 * the cycle's recorded evidence. Pure: reads a WorkState, never writes.
 *
 * What each decision reads. The difference matters when a marker drifts.
 *   - STRUCTURED, read by a typed field: the cap name, the failure kind
 *     (KIND_CLASS), the verify evidence origin (`pr-not-open`, `fix-pass`),
 *     and the awaiting-merge hold.
 *   - SHARED CONSTANT, a phrase the producer writes and this module matches
 *     exactly: the ungranted-protected halt (UNGRANTED_PROTECTED_MARK), the
 *     empty-round failure (EMPTY_ROUND_FAILURE), the baseline-red prefix
 *     (BASELINE_RED_MARKER).
 *   - PROSE, read from text a child or a tool wrote, so it is tolerant rather
 *     than exact: the developer's `[ensemble:plumb]` block and its `question:`
 *     line, the dependency signature (looksLikeMissingDeps) on the raw verify
 *     output, and the assertion lines extractSpecificAssertion accepts. A prose
 *     read that finds nothing falls through to the next rule, never to a guess.
 *
 * Order of derivation (first match wins):
 *   1. no cap recorded          → pi-rukas (the driver lost its own record)
 *   2. awaiting-human-merge     → no class: the work is done, it is not a failure
 *   3. verify-failed:<step>     → verifyVerdict: the route is read from the
 *                                 structured origin, the markers above, and the
 *                                 extracted check lines
 *   4. every other cap          → its FIXED_CAP_CAUSE / TEMPLATE_CAP_CAUSE entry;
 *                                 a kind-driven entry takes its class from the
 *                                 failed dispatch's failure kind (KIND_CLASS)
 *
 * The `causeEvidence` lines are bounded (six lines, 300 characters each) and
 * redacted. Extracted check lines are used as evidence, never the raw tail,
 * so a dependency hint cannot ride in on a line the classifier did not accept.
 * Producers that print the verdict go through causeForCycle (work-driver-cause-for.ts),
 * which also scrubs it, so every surface carries identical text.
 */

import { redactClip } from "./decision-log.ts";
import type { CAP_TEMPLATES, FixedCap } from "./headless/caps.ts";
import type { FailureKind, ResultFailure } from "./headless/failure.ts";
import { EMPTY_ROUND_FAILURE } from "./work-develop-verify-failure.ts";
import { branchRefusalVerdictFor } from "./work-driver-branch-cause.ts";
import { pushRefusalVerdict } from "./work-driver-cause-class-push-refusal.ts";
import {
  type QuotedReply,
  plumbQuestion,
  quotedReplies,
  tagged,
} from "./work-driver-cause-class-replies.ts";
import {
  ACTION_FOR_CLASS,
  type CapCause,
  type CauseClass,
  FIXED_CAP_CAUSE,
  KIND_ACTION,
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
import { failureLines } from "./work-driver-verify-failures.ts";
import { INTEGRATE_CREATE_FAILED_PREFIX, lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

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
/** How many trailing lines of an error tail are considered. */
const TAIL_LINES = 3;
/**
 * The words that mark an error tail line as the one that names the failure.
 * #1762 — this is the LAST-RESORT mark: `tailLines` first asks the shared
 * failure-line table, and only when the tail names no failure line at all does
 * it fall back to the trailing lines carrying these words. That ordering is the
 * whole fix: `pack_release_test.sh: 36 cases, 0 failed` matches this pattern
 * (it contains `fail`) and was quoted as the top evidence of a project-runner handoff,
 * while the runner's real `failed checks (1)` block sat above it.
 */
const ERROR_MARK = /error|fail|✗|cannot|exception|not found|refused/i;
/**
 * The harness's own echo, never evidence about the project. `Command failed:`
 * and `Exit code: N` are what the executor prints when a command died; on a
 * stream that says nothing else they are all there is, so they survive as the
 * last resort — but a real failure line always outranks them.
 */
const HARNESS_ECHO = /^\s*(Command failed:|Exit code:|killed|\$\s)/i;
/** The mark a verify command puts before a check it names. */
const CHECK_MARK = "\u2717";
/** The `question:` line of a plumb block, bold or plain. */
const PLUMB_QUESTION = /^[*_]*question[*_]*\s*:/i;

/** Trimmed, de-duplicated, bounded, redacted lines of the texts, in order. Stops at the bound. */
function evidenceLines(texts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const raw of (text ?? "").split("\n")) {
      if (out.length >= EVIDENCE_MAX_LINES) return out;
      const line = raw.trim();
      if (line.length === 0) continue;
      const clipped = redactClip(line, LINE_MAX);
      if (seen.has(clipped)) continue;
      seen.add(clipped);
      out.push(clipped);
    }
  }
  return out;
}

/**
 * The lines of an error tail to show as evidence: the failure lines the shared
 * table recognises (last `TAIL_LINES` of them), so a stream of passing tallies
 * plus a harness echo cannot return the echo. When the tail holds no recognised
 * failure line, the trailing lines that merely carry an error-ish word, and
 * failing even those, the last line — the pre-#1762 behaviour, kept for the
 * shapes no table covers.
 */
function tailLines(tail: string | undefined): string[] {
  const named = failureLines(tail ?? "").slice(-TAIL_LINES);
  if (named.length > 0) return named;
  const last = (tail ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-TAIL_LINES);
  const marked = last.filter((l) => ERROR_MARK.test(l) && !HARNESS_ECHO.test(l));
  return marked.length > 0 ? marked : last.slice(-1);
}

/** The action for a class, with `{issue}` filled in; null when there is none. */
function actionOf(cls: CauseClass, rule: CapCause | undefined, issue: number): string | null {
  const raw = rule && rule.cls === cls ? rule.action : ACTION_FOR_CLASS[cls];
  return raw === null ? null : raw.replaceAll("{issue}", String(issue));
}

/**
 * The action for a cap whose class came from its failure kind. A kind that
 * moved the cap out of its own entry's class takes the kind's action (a host
 * exit names the host); otherwise the entry's own class action applies.
 */
function actionForKind(
  kind: FailureKind | undefined,
  cls: CauseClass,
  rule: CapCause,
  issue: number,
): string | null {
  const kindAction = kind === undefined ? undefined : KIND_ACTION[kind];
  if (kindAction !== undefined && rule.cls !== cls) {
    return kindAction.replaceAll("{issue}", String(issue));
  }
  return actionOf(cls, rule, issue);
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
    return evidenceLines([
      failure.providerMessage,
      failure.message,
      ...tailLines(failure.errorTail),
      failure.evidence,
    ]);
  }
  return evidenceLines([hit, failure?.message]);
}

/** The awaiting-merge verdict: not a failure, so no class. The text is the table's. */
function awaitingVerdict(issue: number): CauseVerdict {
  const rule = FIXED_CAP_CAUSE["awaiting-human-merge"];
  return {
    causeReason: rule.reason,
    causeEvidence: [],
    userAction: rule.action?.replaceAll("{issue}", String(issue)) ?? null,
  };
}

/** The assertion lines the verify failures carry, in order, bounded. */
function assertionLinesOf(failures: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of failures) {
    for (const raw of f.split("\n")) {
      if (out.length >= EVIDENCE_MAX_LINES) return out;
      const line = raw.trim();
      if (line.length === 0 || seen.has(line)) continue;
      if (extractSpecificAssertion(line) === NO_SPECIFIC_ASSERTION) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

/** A missing-module message whose specifier is a relative or absolute path: the change's own import, not a package. */
const RELATIVE_MISS = /(?:Cannot find module|Could not resolve)[:\s]+['"`]?[./]/i;

/** The first verify line that carries a package dependency signature, if the output has one. */
function firstDependencyLine(failures: readonly string[]): string | undefined {
  if (!looksLikeMissingDeps(failures.join("\n"))) return undefined;
  for (const f of failures) {
    for (const raw of f.split("\n")) {
      const line = raw.trim();
      if (line.length > 0 && looksLikeMissingDeps(line) && !RELATIVE_MISS.test(line)) return line;
    }
  }
  return undefined;
}

/**
 * The develop round changed nothing. A developer that stopped on a question for
 * the operator needs the operator; one that changed nothing for another reason
 * is the change's to revisit, with its own reply as the evidence.
 */
function emptyDiffVerdict(
  state: WorkState,
  failures: readonly string[],
  issue: number,
): CauseVerdict {
  const replies = quotedReplies(state);
  const questions = replies.flatMap((r) => {
    const q = plumbQuestion(r.text);
    return q === undefined ? [] : [{ ...r, text: q }];
  });
  if (questions.length > 0) {
    return {
      causeClass: "issue",
      causeReason: "the developer could not act on the issue as written and asked a question",
      causeEvidence: evidenceLines(tagged(questions, (r) => [r.text])),
      userAction: `answer the question in the issue (or edit the issue), then re-run \`/work ${issue}\``,
    };
  }
  return {
    causeClass: "change",
    causeReason: "the developer made no change",
    causeEvidence:
      replies.length === 0
        ? evidenceLines(failures)
        : evidenceLines(tagged(replies, (r) => [r.text.trim().split("\n")[0] ?? ""])),
    userAction: `read the developer's reply in the handoff; edit the issue or re-run \`/work ${issue} --restart\``,
  };
}

/** `verify-failed:<step>` — routed on the structured origin and the failure markers. */
function verifyVerdict(state: WorkState, cap: string, issue: number): CauseVerdict {
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

  // #1439 — the FORGE refused the push. The verify command never judged this content:
  // GitHub declined to accept it. That is neither "the change is broken" nor an
  // environment fault — the issue asked for content the forge will not host (secret-
  // shaped fixtures are the measured case), and only an operator can allow it or the
  // issue can change. Read from the structured origin; the mark is the back-stop for a
  // state file whose origin field predates the cap.
  if (ev?.origin === "push-refused" || /^push-refused:/.test(cap)) {
    return pushRefusalVerdict(failures, hit, issue, evidenceLines);
  }
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
  // The developer changed nothing: a question for the operator, or a dead end.
  if (failures.some((f) => EMPTY_ROUND_FAILURE.test(f))) {
    return emptyDiffVerdict(state, failures, issue);
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
  // A dependency the worktree lacks, on a line with no ✗ check marker: the worktree's
  // problem, not the change's. A ✗ line is a check the verify command named, so a
  // dependency line that carries the marker stays the change's diagnosis.
  const assertions = assertionLinesOf(failures);
  const depLine = firstDependencyLine(failures);
  if (depLine !== undefined && (assertions.length === 0 || !depLine.startsWith(CHECK_MARK))) {
    return {
      causeClass: "environment",
      causeReason:
        "the verify command stopped on a missing dependency in the worktree, not on the change",
      causeEvidence: evidenceLines([depLine, ...failures]),
      userAction: `install the project dependencies in the worktree (or fix \`.pi/worktree-setup\`) and re-run \`/work ${issue}\``,
    };
  }
  // The verify command ran and named the failing checks: the cycle's own code.
  if (assertions.length > 0) {
    return verdict(
      "change",
      `the verify command failed: ${redactClip(assertions[0] ?? "", LINE_MAX)}`,
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

/**
 * The verdict for one park or failure. Undefined only when the cycle merged.
 * `cap` is the cap name as the cycle recorded it; an unknown name is a pi-rukas gap.
 */
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
  // #1642 — a branch step that refused a stale worktree recorded WHY; a generic
  // template entry was calling the operator's own leftover a host suspend.
  const refusal = branchRefusalVerdictFor(state, cap, issue, evidenceLines);
  if (refusal !== undefined) return refusal;
  const rule = capRuleOf(cap);
  if (rule === undefined || rule.cls === null) {
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
  // A kind-driven cap takes its class from the failure kind, whether or not a
  // dispatch explains it: a child that exited with no structured cause is `process`.
  const kind = rule.kindDriven && failure !== undefined ? failure.kind : undefined;
  const kindClass = kind === undefined ? undefined : KIND_CLASS[kind];
  const cls: CauseClass = kindClass ?? rule.cls;
  return {
    causeClass: cls,
    causeReason: rule.reason,
    causeEvidence: capEvidence(state, cap, failure),
    userAction: actionForKind(kind, cls, rule, issue),
  };
}
