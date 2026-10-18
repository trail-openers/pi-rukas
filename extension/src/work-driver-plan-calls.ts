/**
 * work-driver-plan-calls — #1652: the plan step's workstreams, read from its
 * `report_workstream` tool calls instead of a markdown block.
 *
 * A call is COUNTED only when its tool result is a success. A refused call
 * (schema-invalid, or a duplicate id the child refused in-process) is an
 * `isError` result: it contributes nothing, and its reason is kept so the
 * cycle's event log and handoff can say what the planner got wrong.
 *
 * Read the same way lens-findings-extract.ts reads `report_finding`: from the
 * child's tool events, never from prose.
 */

import path from "node:path";
import { statReporterPath } from "./reporter-preflight.ts";
import type { DispatchResult } from "./types.ts";
import { foldToCeiling, workstreamFromArgs } from "./work-driver-plan-workstreams.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Companion extension path, loaded into the plan child with `--extension`. */
export const WORKSTREAM_REPORTER_PATH = path.join(__dirname, "workstream-reporter.ts");

/** The extra args every plan dispatch (primary and corrective) carries. */
export const PLAN_WORKSTREAM_EXTRA_ARGS: string[] = ["--extension", WORKSTREAM_REPORTER_PATH];

/** One refused call: the id it named (if any) and what Pi said. */
export interface RefusedWorkstreamCall {
  id?: string;
  reason: string;
}

/** What one plan dispatch reported. */
export interface WorkstreamReport {
  /** The accepted calls, folded to the ceiling. Empty when none were accepted. */
  workstreams: Record<string, Workstream>;
  /** How many calls Pi accepted. Zero is the trigger for the corrective. */
  accepted: number;
  refused: RefusedWorkstreamCall[];
}

type ToolUse = { id?: unknown; name?: unknown; arguments?: unknown };

/**
 * The workstreams a plan dispatch reported. Calls whose result is missing or
 * an error are refused; the reason is the error text, or a plain statement
 * that no result was recorded.
 */
export function workstreamCallsOf(
  result: Pick<DispatchResult, "toolUses" | "toolResults">,
): WorkstreamReport {
  const results = new Map((result.toolResults ?? []).map((r) => [r.toolCallId, r]));
  const accepted: Workstream[] = [];
  const refused: RefusedWorkstreamCall[] = [];
  for (const raw of result.toolUses) {
    if (!raw || typeof raw !== "object") continue;
    const tu = raw as ToolUse;
    if (tu.name !== "report_workstream") continue;
    const args =
      tu.arguments && typeof tu.arguments === "object"
        ? (tu.arguments as Record<string, unknown>)
        : {};
    const id = typeof args.id === "string" ? args.id : undefined;
    const r = typeof tu.id === "string" ? results.get(tu.id) : undefined;
    if (!r) {
      refused.push({ id, reason: "no tool result was recorded for this call" });
    } else if (r.isError) {
      refused.push({ id, reason: r.text || "refused" });
    } else {
      accepted.push(workstreamFromArgs(args));
    }
  }
  return {
    workstreams: foldToCeiling(accepted),
    accepted: accepted.length,
    refused,
  };
}

/**
 * The evidence a zero-accepted report reads as. Two different facts, so two
 * sentences: the planner never called the tool, or it called and every call
 * was refused — the operator needs to know which.
 */
export function noWorkstreamCallsEvidence(report: WorkstreamReport): string {
  return report.refused.length === 0
    ? "no report_workstream call"
    : `no successful report_workstream call (${report.refused.length} refused)`;
}

/**
 * Record a dispatch's refused calls, if it refused any. The caller appends this
 * BEFORE the dispatch's completion event: `nextStep()` routes on the tail, and
 * a refusal event after the completion would become the tail.
 */
export function appendWorkstreamRefusals(
  state: WorkState,
  label: string,
  report: WorkstreamReport,
): WorkState {
  if (report.refused.length === 0) return state;
  return appendEvent(state, {
    kind: "workstream-calls-refused",
    step: "plan",
    label,
    at: Date.now(),
    accepted: report.accepted,
    refused: report.refused,
  });
}

/** Test seam: a stat override for the reporter-path preflight. Production never sets it. */
let reporterStatForTest: ((p: string) => Promise<unknown>) | undefined;
export function setWorkstreamReporterStatForTestForTest(
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
