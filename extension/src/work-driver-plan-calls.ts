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
import { statReporterPath } from "./reporter-preflight.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { foldToCeiling, workstreamFromArgs } from "./work-driver-plan-workstreams.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import {
  WORKSTREAM_PARAMETERS,
  type WorkstreamArgs,
  duplicateWorkstreamIdMessage,
  workstreamPathProblem,
} from "./workstream-reporter.ts";

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

type ToolUse = { id?: unknown; name?: unknown; arguments?: unknown };

function isWorkstreamArgs(v: unknown): v is WorkstreamArgs {
  return Value.Check(WORKSTREAM_PARAMETERS, v);
}

/**
 * The workstreams a plan dispatch reported. A call whose result is an error is
 * refused with the error text; a call whose result is missing is unreadable.
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
    refused.push({
      ...(id === undefined ? {} : { id: id.slice(0, REFUSED_ID_MAX) }),
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
    // Pi validated the call, but the parent judges it again: a value this check
    // would refuse must not reach state because the child let it through.
    if (!isWorkstreamArgs(args)) {
      refuse(rawId, "arguments do not match the report_workstream schema");
      continue;
    }
    const pathProblem = workstreamPathProblem(args);
    if (pathProblem) {
      refuse(args.id, pathProblem);
      continue;
    }
    if (seen.has(args.id)) {
      refuse(args.id, duplicateWorkstreamIdMessage(args.id));
      continue;
    }
    seen.add(args.id);
    accepted.push(workstreamFromArgs(args));
  }
  return {
    workstreams: foldToCeiling(accepted),
    accepted: accepted.length,
    refused,
    unreadable,
  };
}

/**
 * The evidence a zero-accepted report reads as. Two different facts, so two
 * sentences: the planner never called the tool, or it called and every call
 * was refused — the operator needs to know which.
 */
export function noWorkstreamCallsEvidence(report: WorkstreamReport): string {
  if (report.refused.length === 0) return "no report_workstream call";
  return `no successful report_workstream call (${report.refused.length} refused)`;
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
    return (err as Error).message;
  }
}
