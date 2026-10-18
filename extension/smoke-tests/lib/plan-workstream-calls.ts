/**
 * Test helper (#1652): the tool-call transcript a /work plan child produces.
 *
 * The plan step reads workstreams from its `report_workstream` calls, so a
 * fixture is a `DispatchResult`-shaped object: the calls in `toolUses`, and the
 * results Pi would record in `toolResults`.
 *
 * The results are produced by DRIVING THE REAL COMPANION (workstream-reporter.ts):
 * each dispatch gets a fresh reporter instance, so its duplicate-id set starts
 * empty, as a corrective re-dispatch does in production. Schema refusals come
 * from the registered tool's own TypeBox parameters; everything else comes from
 * its `execute`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { workstreamCallsOf } from "../../src/work-driver-plan-calls.ts";
import workstreamReporter, {
  type WorkstreamArgs,
  type WORKSTREAM_PARAMETERS,
} from "../../src/workstream-reporter.ts";

export type { WorkstreamArgs };

export interface PlanResultShape {
  text: string;
  toolUses: unknown[];
  toolResults: Array<{ toolCallId: string; toolName: string; isError: boolean; text: string }>;
}

interface RegisteredReporterTool {
  parameters: typeof WORKSTREAM_PARAMETERS;
  execute: (id: string, raw: unknown) => Promise<{ content: { text: string }[] }>;
}

/** A fresh companion instance: its own accepted-id set, as one dispatch has. */
function freshReporterTool(): RegisteredReporterTool {
  let tool: RegisteredReporterTool | undefined;
  workstreamReporter({
    registerTool(t: RegisteredReporterTool) {
      tool = t;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("workstream-reporter did not register report_workstream");
  return tool;
}

/** A plan result whose calls report exactly these workstreams, in order. */
export function planResultFromCalls(calls: WorkstreamArgs[], text = ""): PlanResultShape {
  return planResultFromRawCalls(
    calls.map((args) => ({ id: args.id, args })),
    text,
  );
}

/**
 * Calls by raw `args` — used where a test needs a call the companion would
 * refuse. `refused`, when given, models a channel-level refusal (the call never
 * reached the companion) and overrides the companion's own result.
 */
export function planResultFromRawCalls(
  entries: Array<{ id: string; args: Record<string, unknown>; refused?: string }>,
  text = "",
): PlanResultShape {
  const tool = freshReporterTool();
  const toolUses: unknown[] = [];
  const toolResults: PlanResultShape["toolResults"] = [];
  entries.forEach((entry, i) => {
    const toolCallId = `call-${i + 1}`;
    toolUses.push({
      type: "toolCall",
      id: toolCallId,
      name: "report_workstream",
      arguments: entry.args,
    });
    const outcome = entry.refused
      ? { isError: true, text: entry.refused }
      : companionOutcome(tool, toolCallId, entry.args);
    toolResults.push({ toolCallId, toolName: "report_workstream", ...outcome });
  });
  return { text, toolUses, toolResults };
}

/**
 * Runs one call through the companion and reads its outcome. `execute` is async
 * but has no await, so its promise is already settled on return; `Bun.peek`
 * reads that settled outcome without making every fixture site async.
 */
function companionOutcome(
  tool: RegisteredReporterTool,
  toolCallId: string,
  args: Record<string, unknown>,
): { isError: boolean; text: string } {
  if (!Value.Check(tool.parameters, args)) {
    return {
      isError: true,
      text: `${toolCallId}: report_workstream arguments do not match the schema — call again with a valid id, scope, paths and outOfScope.`,
    };
  }
  const settled = tool.execute(toolCallId, args);
  // A refusal is an expected outcome here, not an unhandled rejection to report.
  settled.catch(() => undefined);
  if (Bun.peek.status(settled) === "rejected") {
    const reason = Bun.peek(settled) as unknown;
    return { isError: true, text: reason instanceof Error ? reason.message : String(reason) };
  }
  const result = Bun.peek(settled) as { content: { text: string }[] };
  return { isError: false, text: result.content[0]?.text ?? "" };
}

/** The workstream map a plan result's calls produce, read by the PRODUCTION reader. */
export function workstreamsOfCalls(calls: WorkstreamArgs[]): Record<string, WorkstreamArgs> {
  return workstreamCallsOf(planResultFromCalls(calls)).workstreams as Record<
    string,
    WorkstreamArgs
  >;
}
