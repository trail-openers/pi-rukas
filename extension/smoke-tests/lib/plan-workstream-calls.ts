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
 *
 * #1756 round 2 — an accepted result also carries the companion's ECHO of the
 * arguments it recorded, on `details`, built by the SAME exported envelope the
 * companion uses (`recordedWorkstreamDetails`), because the driver's reader
 * judges that value rather than the raw call — and BINDS it to the call, so a
 * fixture that echoed something else would be refused rather than believed. An
 * entry may override what the child claims it recorded (`recorded`) to model a
 * companion that accepted a shape the raw call does not have, or omit the echo
 * entirely (`noEcho`) to model an older companion. Both are shapes the reader
 * must decide on its own, so the helper reproduces them rather than a fixture
 * guessing at them.
 *
 * A fixture whose call the real companion would REFUSE (a schema miss, a bad
 * path, a duplicate id) gets no echo: `companionOutcome` returns the error
 * result before any echo is built, exactly as the companion throws before it
 * records anything — a fixture must not model a child that recorded what it
 * says it refused.
 */

import { Value } from "@sinclair/typebox/value";
import {
  recordedWorkstreamDetails,
  WORKSTREAM_PARAMETERS,
  type WorkstreamArgs,
  workstreamCallRefusal,
} from "../../src/plan-workstream-schema.ts";
import { workstreamCallsOf } from "../../src/work-driver-plan-calls.ts";

export type { WorkstreamArgs };

export interface PlanResultShape {
  text: string;
  toolUses: unknown[];
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    isError: boolean;
    text: string;
    details?: Record<string, unknown>;
  }>;
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
 * reached the companion) and overrides the companion's own result. `recorded`
 * overrides what an ACCEPTED call echoes back as the value it stored, and
 * `noEcho` drops the echo from an accepted result entirely (#1756 round 2).
 */
export function planResultFromRawCalls(
  entries: Array<{
    id: string;
    args: Record<string, unknown>;
    refused?: string;
    recorded?: unknown;
    noEcho?: boolean;
  }>,
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
      : companionOutcome(accepted, toolCallId, entry.args, entry);
    toolResults.push({ toolCallId, toolName: "report_workstream", ...outcome });
  });
  return { text, toolUses, toolResults };
}

/** The result fields a fixture supplies; the two identity fields are added by the caller. */
type CompanionOutcome = Omit<PlanResultShape["toolResults"][number], "toolCallId" | "toolName">;

/**
 * One call's outcome: Pi's schema check, then the companion's refusal rules,
 * then — for an accepted call ONLY — the echo of the recorded value, in the one
 * carrier the real companion writes.
 *
 * A call the companion would REFUSE gets no echo, and that ordering is the
 * point: the companion throws before it records anything, so a fixture whose
 * schema check fails (an 81-character id, a bare string where an array belongs)
 * or whose refusal rules fire (a bad path, a duplicate id) must model an error
 * result with no `details` at all. A fixture that echoed the value it says the
 * child refused would teach the reader to accept exactly the shape the companion
 * never recorded.
 */
function companionOutcome(
  accepted: Set<string>,
  toolCallId: string,
  args: Record<string, unknown>,
  entry: { recorded?: unknown; noEcho?: boolean } = {},
): CompanionOutcome {
  if (!Value.Check(WORKSTREAM_PARAMETERS, args)) {
    return {
      isError: true,
      text: `${toolCallId}: report_workstream arguments do not match the schema — call again with a valid id, scope, paths and outOfScope.`,
    };
  }
  const refusal = workstreamCallRefusal(args, accepted);
  if (refusal) return { isError: true, text: refusal };
  accepted.add(args.id as string);
  // What the companion would have been handed. The helper cannot observe Pi's
  // conversion, so a test that wants a coerceable shape says so with `recorded`;
  // otherwise the child recorded what it was sent.
  const recorded = entry.recorded ?? { ...args };
  if (entry.noEcho) return { isError: false, text: `recorded workstream ${args.id}` };
  return {
    isError: false,
    text: `recorded workstream ${args.id}`,
    details: recordedWorkstreamDetails(recorded),
  };
}

/** The workstream map a plan result's calls produce, read by the PRODUCTION reader. */
export function workstreamsOfCalls(calls: WorkstreamArgs[]): Record<string, WorkstreamArgs> {
  return workstreamCallsOf(planResultFromCalls(calls)).workstreams as Record<
    string,
    WorkstreamArgs
  >;
}
