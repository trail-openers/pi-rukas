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
import { PLUMB_REPLY_MARKER } from "./work-driver-adversarial-plumb.ts";
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
/** The words that mark an error tail line as the one that names the failure. */
const ERROR_MARK = /error|fail|✗|cannot|exception|not found|refused/i;
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

/** The last few non-empty lines of an error tail; the ones that name an error when any do. */
function tailLines(tail: string | undefined): string[] {
  const last = (tail ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-TAIL_LINES);
  const marked = last.filter((l) => ERROR_MARK.test(l));
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

/** A developer reply the verdict quotes; `id` names the workstream under a fan-out. */
interface QuotedReply {
  id?: string;
  text: string;
  /** The workstream recorded no reply; `text` is NO_REPLY, never another workstream's words. */
  missing?: boolean;
}

const NO_REPLY = "(no reply recorded)";

/**
 * The develop replies the verdict quotes. Under a fan-out these are the reply(s)
 * of the workstream(s) that produced no change (a no-change green is downgraded
 * to failing, so the downgraded workstreams are that set), else of every failing
 * workstream. With no failing workstream, the developer's last reply.
 */
function quotedReplies(state: WorkState): QuotedReply[] {
  const replies = new Map<string, string>();
  const verdicts = new Map<string, { ok: boolean; downgraded: boolean }>();
  let last: string | undefined;
  for (const e of state.eventLog) {
    if (e.kind === "dispatch-completed" && e.step === "develop" && e.role === "developer") {
      if (e.summary?.trim()) {
        replies.set(e.label, e.summary);
        last = e.summary;
      }
    } else if (e.kind === "branch-completed" && e.step === "develop") {
      verdicts.set(e.workstreamId, { ok: e.ok, downgraded: e.downgrade === true });
    }
  }
  const failing = [...verdicts].filter(([, v]) => !v.ok);
  const noChange = failing.filter(([, v]) => v.downgraded);
  const chosen = (noChange.length > 0 ? noChange : failing).map(([id]) => id);
  const picked: QuotedReply[] = [];
  for (const id of chosen) {
    const text =
      replies.get(`developer[${id}]`) ??
      (chosen.length === 1 ? replies.get("developer") : undefined);
    picked.push(text === undefined ? { id, text: NO_REPLY, missing: true } : { id, text });
  }
  if (picked.length > 0) return picked;
  return last === undefined ? [] : [{ text: last }];
}

/** Evidence lines from the quoted replies: named by workstream only when several are quoted. */
function tagged(replies: readonly QuotedReply[], lines: (r: QuotedReply) => string[]): string[] {
  const named = replies.length > 1;
  return replies.flatMap((r) =>
    lines(r).map((l) =>
      r.id !== undefined && (named || r.missing === true) ? `workstream ${r.id}: ${l}` : l,
    ),
  );
}

/**
 * The question a developer's reply asks the operator: the `question:` line of
 * its `[ensemble:plumb]` block, or the block's first line. Undefined when the
 * reply has no plumb block.
 */
function plumbQuestion(reply: string): string | undefined {
  const at = reply.indexOf(PLUMB_REPLY_MARKER);
  if (at < 0) return undefined;
  const lines = reply
    .slice(at + PLUMB_REPLY_MARKER.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.find((l) => PLUMB_QUESTION.test(l)) ?? lines[0] ?? PLUMB_REPLY_MARKER;
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
