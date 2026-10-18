#!/usr/bin/env bun
/**
 * #1652 — the production tool-result channel: `collapseEvents` reads a child's
 * `agent_end` messages (assistant toolCall blocks, then `toolResult` messages)
 * into `DispatchResult.toolResults`, and `workstreamCallsOf` judges them. The
 * shapes below are Pi's (pi-event-shapes.ts): a toolResult message carries
 * `toolCallId`, `toolName`, `isError` and `content` blocks. Pure, offline.
 */

import type { PiJsonEvent, PiMessage } from "../src/pi-event-shapes.ts";
import { collapseEvents } from "../src/spawn-collapse-events.ts";
import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import { planRefusalsSection } from "../src/work-driver-pr-sections.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function assistantCalls(calls: Array<{ id: string; args: Record<string, unknown> }>): PiMessage {
  return {
    role: "assistant",
    model: "test-model",
    provider: "test",
    stopReason: "toolUse",
    content: calls.map((c) => ({
      type: "toolCall",
      id: c.id,
      name: "report_workstream",
      arguments: c.args,
    })),
  } as PiMessage;
}

function toolResult(toolCallId: string, isError: boolean, text: string): PiMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "report_workstream",
    isError,
    content: [{ type: "text", text }],
  } as PiMessage;
}

function collapse(messages: PiMessage[]) {
  const agentEnd = { type: "agent_end", messages } as PiJsonEvent;
  return collapseEvents(agentEnd, null, "explore", 10, 0, "");
}

const ARGS_A = { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] };
const ARGS_B = { id: "task-b", scope: "b", paths: ["src/b.ts"], outOfScope: [] };

{
  // One accepted call, one refused call (the child's duplicate-id error).
  const result = collapse([
    assistantCalls([
      { id: "call-1", args: ARGS_A },
      { id: "call-2", args: { ...ARGS_A, scope: "again" } },
    ]),
    toolResult("call-1", false, "recorded workstream task-a"),
    toolResult(
      "call-2",
      true,
      "workstream id 'task-a' was already reported in this plan — each workstream needs a distinct id.",
    ),
  ]);
  assert(
    result.toolResults?.length === 2 &&
      result.toolResults[0]?.isError === false &&
      result.toolResults[1]?.isError === true,
    "collapseEvents keeps each toolResult's isError flag, in call order",
  );
  assert(
    result.toolResults?.[0]?.toolCallId === "call-1" &&
      result.toolResults?.[0]?.toolName === "report_workstream",
    "collapseEvents keeps the toolCallId and toolName of each result",
  );
  const report = workstreamCallsOf(result);
  assert(
    report.accepted === 1 &&
      Object.keys(report.workstreams).join() === "task-a" &&
      report.refused.length === 1 &&
      report.refused[0]?.reason.includes("task-a") === true,
    "the reader counts the success, and keeps the error as the refusal reason",
  );
}
{
  // The result text is bounded to 300 characters, block by block.
  const long = "x".repeat(1000);
  const result = collapse([
    assistantCalls([{ id: "call-1", args: ARGS_B }]),
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "report_workstream",
      isError: true,
      content: [
        { type: "text", text: long },
        { type: "text", text: long },
      ],
    } as PiMessage,
  ]);
  assert(
    result.toolResults?.[0]?.text.length === 300,
    "a refusal text is cut to 300 characters while accumulating, not joined whole",
  );
}
{
  // No toolResult message at all (the message_end fallback): the calls are unreadable.
  const result = collapse([assistantCalls([{ id: "call-1", args: ARGS_A }])]);
  assert(result.toolResults === undefined, "no toolResult messages: toolResults is absent");
  const report = workstreamCallsOf(result);
  assert(
    report.accepted === 0 && report.unreadable === 1 && report.refused.length === 0,
    "a call with no result message in the replay is unreadable, not refused",
  );
}
{
  // A toolResult with no toolCallId is not a channel entry at all.
  const result = collapse([
    assistantCalls([{ id: "call-1", args: ARGS_A }]),
    { role: "toolResult", toolName: "report_workstream", isError: false, content: [] } as PiMessage,
  ]);
  assert(
    result.toolResults === undefined && workstreamCallsOf(result).unreadable === 1,
    "a toolResult without a toolCallId is ignored, so its call stays unreadable",
  );
}

{
  // Partial yield reaches the PR body: the refused calls are named, not just logged.
  const state = {
    ...initialState(1652, 1),
    eventLog: [
      {
        kind: "workstream-calls-refused",
        step: "plan",
        label: "plan",
        at: 1,
        accepted: 1,
        refused: [{ id: "Bad A", reason: "schema: id does not match the pattern" }],
        omitted: 2,
      },
    ],
  } as unknown as WorkState;
  const section = planRefusalsSection(state.eventLog);
  assert(
    section.startsWith("## Planner refused some workstream calls") &&
      section.includes("- `plan` · id `Bad A`: schema: id does not match the pattern") &&
      section.includes("2 more refused call(s) not listed"),
    "the PR body names each refused call, its dispatch and reason, and the count not listed",
  );
  assert(planRefusalsSection([]) === "", "a plan with no refusals adds nothing to the PR body");
}

process.exit(exit);
