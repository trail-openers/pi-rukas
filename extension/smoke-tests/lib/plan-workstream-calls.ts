/**
 * Test helper (#1652): the tool-call transcript a /work plan child produces.
 *
 * The plan step reads workstreams from its `report_workstream` calls, so a
 * fixture is a `DispatchResult`-shaped object: the calls in `toolUses`, and the
 * results Pi would record in `toolResults`.
 *
 * Each result is judged by the SAME rules the companion applies: Pi's schema
 * check (TypeBox, as Pi runs it) and the companion's own refusal function
 * (workstreamCallRefusal). A dispatch's duplicate-id set starts empty, as a
 * corrective re-dispatch does in production. The registration itself is covered
 * by test-plan-workstream-tool.ts.
 */

import { Value } from "@sinclair/typebox/value";
import {
  WORKSTREAM_PARAMETERS,
  type WorkstreamArgs,
  workstreamCallRefusal,
} from "../../src/plan-workstream-schema.ts";
import { workstreamCallsOf } from "../../src/work-driver-plan-calls.ts";

export type { WorkstreamArgs };

export interface PlanResultShape {
  text: string;
  toolUses: unknown[];
  toolResults: Array<{ toolCallId: string; toolName: string; isError: boolean; text: string }>;
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
  const accepted = new Set<string>();
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
      : companionOutcome(accepted, toolCallId, entry.args);
    toolResults.push({ toolCallId, toolName: "report_workstream", ...outcome });
  });
  return { text, toolUses, toolResults };
}

/** One call's outcome: Pi's schema check, then the companion's refusal rules. */
function companionOutcome(
  accepted: Set<string>,
  toolCallId: string,
  args: Record<string, unknown>,
): { isError: boolean; text: string } {
  if (!Value.Check(WORKSTREAM_PARAMETERS, args)) {
    return {
      isError: true,
      text: `${toolCallId}: report_workstream arguments do not match the schema — call again with a valid id, scope, paths and outOfScope.`,
    };
  }
  const refusal = workstreamCallRefusal(args, accepted);
  if (refusal) return { isError: true, text: refusal };
  accepted.add(args.id as string);
  return { isError: false, text: `recorded workstream ${args.id}` };
}

/** The workstream map a plan result's calls produce, read by the PRODUCTION reader. */
export function workstreamsOfCalls(calls: WorkstreamArgs[]): Record<string, WorkstreamArgs> {
  return workstreamCallsOf(planResultFromCalls(calls)).workstreams as Record<
    string,
    WorkstreamArgs
  >;
}
