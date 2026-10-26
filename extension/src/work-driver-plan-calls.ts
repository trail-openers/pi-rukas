/**
 * work-driver-plan-calls — #1652: the plan step's workstreams, read from its
 * `report_workstream` tool calls instead of a markdown block.
 *
 * A call is COUNTED only when its tool result is a success AND its arguments
 * pass the same checks the companion applies (schema, plain paths, distinct
 * id). A refused call — an `isError` result, or a call this reader refuses on
 * the same grounds — contributes nothing, and its reason is kept so the
 * cycle's event log and handoff can say what the planner got wrong.
 *
 * #1756 — those checks do NOT run on the raw arguments. Pi's tool validation
 * clones them and normalises/coerces them before its `Check`, so a model that
 * sends an array field as a single string can be accepted in the child and
 * refused HERE — the workstream recorded in the child and lost by the driver,
 * and the planner's retry under the same id then drew the duplicate refusal.
 *
 * ROUND 2 — the parent does NOT mirror that conversion; it tried (this branch's
 * first commit) and got it wrong in both directions. The full reason — which
 * TypeBox package the INSTALLED Pi validates with, and why there is no
 * version-independent answer to "what did Pi pass the child" — is stated ONCE in
 * plan-workstream-schema.ts, at `RECORDED_ARGS_DETAILS_KEY`; read it there. The
 * consequence for this reader: the CHILD reports the params object its `execute`
 * actually recorded (workstream-reporter.ts), the parent BINDS that report to the
 * call it claims to describe (`echoMatchesCall` — an echo that widens `paths`,
 * empties `outOfScope` or renames the workstream is refused, not judged), and
 * only a bound echo goes through the schema, path and duplicate checks. A result
 * with no echo (an older companion, or a channel that dropped the payload) is
 * judged on its raw arguments exactly as before #1756 — the reader never invents
 * a shape nobody reported.
 *
 * A call with NO result entry is different: the channel that carries results
 * failed, so nothing says the planner did anything wrong. Those calls are
 * counted as `unreadable`, and the step parks on them rather than reading them
 * as refusals (`workstream-results-unreadable`).
 *
 * Read the same way lens-findings-extract.ts reads `report_finding`: from the
 * child's tool events, never from prose.
 */

import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  WORKSTREAM_ID_MAX,
  WORKSTREAM_ID_PATTERN,
  WORKSTREAM_PARAMETERS,
  type WorkstreamArgs,
  duplicateWorkstreamIdMessage,
  echoMatchesCall,
  recordedWorkstreamArgs,
  workstreamPathProblem,
} from "./plan-workstream-schema.ts";
import { statReporterPath } from "./reporter-preflight.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { foldToCeiling, workstreamFromArgs } from "./work-driver-plan-workstreams.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

const WORKSTREAM_ID_RE = new RegExp(WORKSTREAM_ID_PATTERN);

/** Companion extension path, loaded into the plan child with `--extension`. */
export const WORKSTREAM_REPORTER_PATH = path.join(__dirname, "workstream-reporter.ts");

/** The extra args every plan dispatch (primary and corrective) carries. */
export const PLAN_WORKSTREAM_EXTRA_ARGS: readonly string[] = [
  "--extension",
  WORKSTREAM_REPORTER_PATH,
];

/** Longest refused-call id recorded; a longer one is truncated for display. */
export const REFUSED_ID_MAX = 64;
/** Longest refusal reason recorded. */
export const REFUSED_REASON_MAX = 300;
/** Refusal entries recorded per dispatch; the rest are counted, not stored. */
export const MAX_REFUSALS_RECORDED = 20;

/** One refused call: the id it named (if any) and why it was refused. */
export interface RefusedWorkstreamCall {
  id?: string;
  reason: string;
}

/** What one plan dispatch reported. */
export interface WorkstreamReport {
  /** The accepted calls, folded to the ceiling. Empty when none were accepted. */
  workstreams: Record<string, Workstream>;
  /** How many calls were accepted. Zero is the trigger for the corrective. */
  accepted: number;
  /** Calls refused on their own merits: the child's error, or this reader's check. */
  refused: RefusedWorkstreamCall[];
  /**
   * Calls whose result the replay did not carry. Non-zero means the report
   * cannot be judged: the step parks as `workstream-results-unreadable`.
   */
  unreadable: number;
}

/** A report for a dispatch that made no workstream calls (or was killed). */
export function emptyWorkstreamReport(): WorkstreamReport {
  return { workstreams: {}, accepted: 0, refused: [], unreadable: 0 };
}

/**
 * The refusal of a result whose `details` echo does not describe the call it
 * arrived with (#1756 round 2). Stated here rather than inline so a test can
 * pin the exact wording the handoff shows.
 */
export const ECHO_MISMATCH_REASON = "the recorded workstream does not match the call";

type ToolUse = { id?: unknown; name?: unknown; arguments?: unknown };

function isWorkstreamArgs(v: unknown): v is WorkstreamArgs {
  return Value.Check(WORKSTREAM_PARAMETERS, v);
}

/**
 * The workstreams a plan dispatch reported. A call whose result is an error is
 * refused with the error text; a call whose result is missing is unreadable.
 * A call whose result is a success is judged on the value the child echoed, or
 * on its raw arguments when the result carried no echo (#1756 round 2).
 */
export function workstreamCallsOf(
  result: Pick<DispatchResult, "toolUses" | "toolResults">,
): WorkstreamReport {
  const results = new Map((result.toolResults ?? []).map((r) => [r.toolCallId, r]));
  const accepted: Workstream[] = [];
  const refused: RefusedWorkstreamCall[] = [];
  let unreadable = 0;
  // Parent-side uniqueness: the child refuses duplicates in-process, but a set of
  // accepted ids must be unique here too, or a later entry would overwrite one.
  const seen = new Set<string>();
  const refuse = (id: string | undefined, reason: string) => {
    // A planner-supplied id is recorded only when it is a legal id. Anything
    // else is shown as a placeholder, so the state file never holds free text
    // in the id slot.
    const recorded =
      id === undefined
        ? undefined
        : id.length <= WORKSTREAM_ID_MAX && WORKSTREAM_ID_RE.test(id)
          ? id.slice(0, REFUSED_ID_MAX)
          : "(invalid id)";
    refused.push({
      ...(recorded === undefined ? {} : { id: recorded }),
      reason: reason.slice(0, REFUSED_REASON_MAX),
    });
  };
  for (const raw of result.toolUses) {
    if (!raw || typeof raw !== "object") continue;
    const tu = raw as ToolUse;
    if (tu.name !== "report_workstream") continue;
    const args: unknown = tu.arguments;
    const rawId =
      args && typeof args === "object" && "id" in args && typeof args.id === "string"
        ? args.id
        : undefined;
    const r = typeof tu.id === "string" ? results.get(tu.id) : undefined;
    if (!r) {
      unreadable += 1;
      continue;
    }
    if (r.isError) {
      refuse(rawId, r.text || "refused");
      continue;
    }
    // The value to judge: what the child says it recorded, when it said AND when
    // what it said is a coercion of the call the transcript holds. The parent
    // never converts — it cannot know which TypeBox the installed Pi used, so
    // only the child's own report is authoritative (#1756 round 2). An echo that
    // is not a coercion of this call is REFUSED rather than judged: it is not a
    // report of the call, it is a different call smuggled in on the result, and
    // accepting one would let an echo replace the authorised `paths` or drop the
    // fence (`echoMatchesCall`). No echo (an older companion, a dropped payload)
    // falls back to the raw arguments, which is the pre-#1756 behaviour,
    // unchanged.
    const echoed = recordedWorkstreamArgs(r);
    if (echoed !== undefined) {
      const binding = echoMatchesCall(args, echoed);
      if (!binding.ok) {
        traceWarn(
          `work-driver: report_workstream result ${r.toolCallId} echoed arguments that are not a coercion of the call — refused (${binding.keys.join(", ")})`,
        );
        refuse(rawId, ECHO_MISMATCH_REASON);
        continue;
      }
    }
    const judged = echoed === undefined ? args : echoed;
    // A child that recorded a different `id` from the one the model asked with
    // is reporting something the transcript does not contain, so the refusal is
    // filed under the call the transcript actually holds.
    const judgedId =
      judged !== args &&
      judged &&
      typeof judged === "object" &&
      "id" in judged &&
      typeof (judged as { id: unknown }).id === "string"
        ? (judged as { id: string }).id
        : rawId;
    if (!isWorkstreamArgs(judged)) {
      refuse(judgedId, "arguments do not match the report_workstream schema");
      continue;
    }
    const pathProblem = workstreamPathProblem(judged);
    if (pathProblem) {
      refuse(judged.id, pathProblem);
      continue;
    }
    if (seen.has(judged.id)) {
      refuse(judged.id, duplicateWorkstreamIdMessage(judged.id));
      continue;
    }
    seen.add(judged.id);
    accepted.push(workstreamFromArgs(judged));
  }
  return {
    workstreams: foldToCeiling(accepted),
    accepted: accepted.length,
    refused,
    unreadable,
  };
}

/** The shared opening of every zero-accepted evidence string. */
export const NO_ACCEPTED_CALL_EVIDENCE = "no accepted report_workstream call";

/** How many refusal reasons the zero-accepted evidence quotes. */
const EVIDENCE_REASONS_SHOWN = 3;

/**
 * The verdict a zero-accepted report carries on its park (the cap-hit's
 * `planVerdict`). "no-calls" means the reply made no call at all; "all-refused"
 * means it made calls and the driver refused every one.
 */
export function zeroAcceptedVerdictOf(report: WorkstreamReport): "no-calls" | "all-refused" {
  return report.refused.length === 0 ? "no-calls" : "all-refused";
}

/**
 * The evidence a zero-accepted report reads as. With no call at all, the cause is
 * ambiguous from the driver's side: the planner ignored the tool, or the tool was
 * never registered in the plan child, so the evidence names both. With refused
 * calls the tool plainly registered, and the evidence quotes the refusal reasons.
 */
export function noWorkstreamCallsEvidence(report: WorkstreamReport): string {
  if (report.refused.length === 0) {
    return `${NO_ACCEPTED_CALL_EVIDENCE}: the reply made none, or report_workstream is missing from the plan child's tool list (the companion did not register)`;
  }
  const reasons = report.refused
    .slice(0, EVIDENCE_REASONS_SHOWN)
    .map((r) => (r.id ? `${r.id}: ${r.reason}` : r.reason))
    .join("; ");
  const more = report.refused.length > EVIDENCE_REASONS_SHOWN ? "; …" : "";
  return `${NO_ACCEPTED_CALL_EVIDENCE}: ${report.refused.length} call(s) refused — ${reasons}${more}`;
}

/** The evidence of an unreadable report: the calls exist, their results do not. */
export function unreadableWorkstreamCallsEvidence(report: WorkstreamReport): string {
  return `${report.unreadable} report_workstream call(s) made, but the tool results were not carried back, so the calls could not be judged (workstream-results-unreadable)`;
}

/**
 * Record one dispatch's outcome: its refused calls (when it refused any), then
 * its completion event. The order is load-bearing — `nextStep()` routes on the
 * tail, so a refusal appended after the completion would become the tail.
 * Refusals are capped at MAX_REFUSALS_RECORDED; the rest are counted.
 */
export function appendPlanDispatchOutcome(
  state: WorkState,
  label: string,
  report: WorkstreamReport,
  completion: WorkEvent,
): WorkState {
  let next = state;
  if (report.refused.length > 0) {
    const kept = report.refused.slice(0, MAX_REFUSALS_RECORDED);
    const omitted = report.refused.length - kept.length;
    traceWarn(
      `work-driver: ${label} dispatch refused ${report.refused.length} report_workstream call(s) and kept ${report.accepted}`,
    );
    next = appendEvent(next, {
      kind: "workstream-calls-refused",
      step: "plan",
      label,
      at: Date.now(),
      accepted: report.accepted,
      refused: kept,
      ...(omitted > 0 ? { omitted } : {}),
    });
  }
  return appendEvent(next, completion);
}

/** Test seam: a stat override for the reporter-path preflight. Production never sets it. */
let reporterStatForTest: ((p: string) => Promise<unknown>) | undefined;
export function setWorkstreamReporterStatForTest(
  fn: ((p: string) => Promise<unknown>) | undefined,
): void {
  reporterStatForTest = fn;
}

/**
 * Pre-spawn check that the companion file exists (#893 pattern). Returns the
 * named error to halt on, or undefined when the reporter is reachable.
 */
export async function checkWorkstreamReporter(): Promise<string | undefined> {
  try {
    await statReporterPath(WORKSTREAM_REPORTER_PATH, reporterStatForTest);
    return undefined;
  } catch (err) {
    return err instanceof Error
      ? err.message
      : `workstream reporter companion check failed: ${String(err)}`;
  }
}
