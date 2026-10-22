/**
 * work-driver-adversarial-plumb — the plumb-report reader for the adversarial
 * fix pass (#1137). Split from work-driver-adversarial-fix.ts (AGENTS.md §12
 * file-size limit). `plumbQuestion` is the single reader both no-change park
 * branches use; `withNewPlumbReports` records the fix developer's plumb
 * report that is new to this pass. `parkFixPass` / `withFixPassReport` (the
 * pass's own park + handoff report) moved here from
 * work-driver-adversarial-fix.ts for the same size limit. Leaf module: no
 * imports from the fix pass or its handlers.
 */

import { postPassFault } from "./work-driver-adversarial-fix-scope.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import { FIX_PASS_EVIDENCE_PREFIX } from "./workflow-state-cap.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Bound on the findings carried in an event / the fix prompt (state-file hygiene). */
export const FIX_FINDINGS_MAX = 4000;

/**
 * Cuts one sibling's findings to `max` characters and says so, so a cut
 * is never silent.
 */
export function capWithMarker(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} chars omitted]`;
}

/**
 * A mixed first-pass fan-out parks on the infra cap, which would otherwise
 * drop the parsed siblings. Each parsed sibling's verdict and findings go to
 * the handoff as a plumb report.
 */
export function withParsedSiblings(
  state: WorkState,
  outcomes: readonly AdversarialOutcome[],
  now: number,
): WorkState {
  const parsed = outcomes.filter((o) => o.fixRequested || (!o.ok && !o.infra && !o.threw));
  if (parsed.length === 0) return state;
  const body = parsed
    .map((o) => {
      const status = o.records[o.records.length - 1]?.status ?? "parsed verdict";
      const text = (o.fixRequested ? o.fixFindings : o.rejectionText) ?? "(no findings text)";
      return `[workstream ${o.id}] ${status}:\n${capWithMarker(text, FIX_FINDINGS_MAX)}`;
    })
    .join("\n\n---\n\n");
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        {
          step: "adversarial",
          role: "driver",
          body: `mixed fan-out: parsed sibling verdicts kept alongside the infra cap:\n${body}`,
          at: now,
        },
      ],
    },
  };
}

/** Discloses a fact on the handoff report without parking the pass. */
export function noteFixPass(state: WorkState, note: string, now: number): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        { step: "develop", role: "driver", body: `adversarial fix pass: ${note}`, at: now },
      ],
    },
  };
}

/** The pending fix as the park report renders it. */
export interface ParkedFixRequest {
  workstreamId: string;
  round: number;
  findings: string;
}

/**
 * Records the handoff report naming the rounds, the reason and the findings.
 * #1760 — it also carries what the pass ADMITTED: a park that discloses the
 * refusals but not the authorisations reads as a fence that never widened, and
 * an admission the operator never sees is a fence that widened invisibly.
 */
export function withFixPassReport(
  state: WorkState,
  pending: readonly ParkedFixRequest[],
  reason: string,
  now: number,
  admissions: readonly string[] = [],
): WorkState {
  const rounds = pending.map((p) => `${p.workstreamId} round ${p.round}`).join(", ");
  const findings = capWithMarker(pending.map((p) => p.findings).join("\n---\n"), FIX_FINDINGS_MAX);
  const admitted =
    admissions.length > 0
      ? `\nWhat the pass admitted before parking:\n${admissions.map((a) => `- ${a}`).join("\n")}`
      : "";
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        {
          step: "develop",
          role: "driver",
          body: `adversarial fix pass (${rounds}) parked: ${reason}. The findings that triggered it:\n${findings}${admitted}`,
          at: now,
        },
      ],
    },
  };
}

/**
 * Parks the fix pass: the handoff report, the verify evidence the handoff's
 * cap text reads, and the pass's own cap event. `admissions` threads the
 * fence's authorisations into the report even though the pass did not clear.
 */
export function parkFixPass(
  state: WorkState,
  pending: readonly ParkedFixRequest[],
  reason: string,
  now: number,
  admissions: readonly string[] = [],
): WorkState {
  // The handoff's cap text reads verifyEvidence, not the event: without it the
  // park reads as one whose reason was never recorded. The prefix is what
  // keeps that text from blaming the outcome gate.
  const reported = withFixPassReport(state, pending, reason, now, admissions);
  const evidenced: WorkState = {
    ...reported,
    pipelineState: {
      ...reported.pipelineState,
      verifyEvidence: {
        step: "develop",
        failures: [`${FIX_PASS_EVIDENCE_PREFIX}${reason}`],
        at: now,
        origin: "fix-pass",
      },
    },
  };
  return appendEvent(evidenced, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "fix-pass-park", // #1349 — the pass's own check, not the outcome gate
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: `${FIX_PASS_EVIDENCE_PREFIX}${reason}`,
  });
}

/** The shape plumbQuestion reads (the pipeline-state plumb report record). */
export type PlumbReportLike = { body: string };

/** The marker that identifies a plumb report (the one place both park branches read it). */
export const PLUMB_REPORT_MARKER = /\[ensemble:plumb\]|plumb report|scope-ambiguity/i;

/**
 * The one reader for both no-change park branches: the first report matching
 * the plumb marker, its body embedded as UNTRUSTED developer text — prefix
 * says so, code fences stripped, capped at 300 chars with an ellipsis
 * (display-only; the full body still rides in pipelineState). `null` when none.
 */
export function plumbQuestion(reports: readonly PlumbReportLike[]): string | null {
  const plumb = reports.find((r) => PLUMB_REPORT_MARKER.test(r.body));
  if (!plumb) return null;
  const body = plumb.body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = body.length > 300 ? `${body.slice(0, 299)}…` : body; // ≤300 chars total, ellipsis-marked
  return `developer question (untrusted text): ${capped}`;
}

/** The post-pass read's reason when the pass changed nothing (postPassFault). */
export const NO_CHANGE_REASON = /byte-identical|nothing was fixed/i;

/**
 * The fix developer's plumb question from reports NEW to this pass. A stale
 * question from an earlier pass is never presented as this pass's.
 */
export function freshPlumbQuestion(
  state: WorkState,
  priorBodies: ReadonlySet<string>,
): string | null {
  const fresh = (state.pipelineState.plumbReports ?? []).filter((r) => !priorBodies.has(r.body));
  return plumbQuestion(fresh);
}

/** True only when the post-pass read proves the pass changed nothing. */
export async function noChangeProven(
  execFn: Parameters<typeof postPassFault>[0],
  plans: Parameters<typeof postPassFault>[1],
  baseSha: string,
): Promise<boolean> {
  const check = await postPassFault(execFn, plans, baseSha);
  return check.reason !== undefined && NO_CHANGE_REASON.test(check.reason);
}

/** The marker a fix developer's reply carries when it asks a plumb question. */
export const PLUMB_REPLY_MARKER = "[ensemble:plumb]";

/**
 * Records the fix developer's plumb reply as a plumb report. The reply is the
 * `summary` of the develop step's dispatch-completed events since `fromIndex`:
 * the develop step records git failures in plumbReports, never the reply, so
 * without this the plumb-with-no-change route could not be reached. Only
 * replies carrying the marker and not already in `priorBodies` are recorded.
 * A reply spilled to a claim-check artifact (over 4 KB) is not read here: a
 * plumb question is short by contract.
 */
export function withDeveloperPlumbReplies(
  state: WorkState,
  fromIndex: number,
  priorBodies: ReadonlySet<string>,
): WorkState {
  const replies: string[] = [];
  // #1332 — the develop step's empty-round cap may already have recorded it.
  const recorded = new Set((state.pipelineState.plumbReports ?? []).map((r) => r.body));
  for (const e of state.eventLog.slice(fromIndex)) {
    if (
      e.kind === "dispatch-completed" &&
      e.step === "develop" &&
      e.summary?.includes(PLUMB_REPLY_MARKER) &&
      !priorBodies.has(e.summary) &&
      !recorded.has(e.summary) &&
      !replies.includes(e.summary)
    )
      replies.push(e.summary);
  }
  if (replies.length === 0) return state;
  const at = Date.now();
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        ...replies.map((body) => ({ step: "develop" as const, role: "developer", body, at })),
      ],
    },
  };
}
