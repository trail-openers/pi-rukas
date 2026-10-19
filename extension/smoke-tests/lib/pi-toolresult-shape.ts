/**
 * Live-shape check for Pi's `toolResult` messages (#1652): the channel the plan
 * step reads its report_workstream calls back from. Each toolCall gets a
 * toolResult message with the same toolCallId, a toolName, and a boolean
 * isError. Used by test-pi-shape-live.ts, which spawns the real child.
 */

type ToolResultMsg = { role?: string; toolCallId?: unknown; toolName?: unknown; isError?: unknown };

export function checkToolResultShape(
  assert: (cond: boolean, msg: string) => void,
  agentEnd: { messages?: unknown } | undefined,
  messageEnds: Array<{ message?: unknown }>,
  callId: string | undefined,
): void {
  const endMessages = agentEnd?.messages;
  const fromEnd: unknown[] = Array.isArray(endMessages) ? endMessages : [];
  const results = [...fromEnd, ...messageEnds.map((e) => e.message)].filter(
    (m): m is ToolResultMsg => (m as ToolResultMsg | undefined)?.role === "toolResult",
  );
  const first = results[0];
  assert(results.length > 0, "at least one toolResult message follows the toolCall");
  assert(
    typeof first?.toolCallId === "string" && first.toolCallId === callId,
    "toolResult.toolCallId matches the toolCall block's id",
  );
  assert(
    typeof first?.toolName === "string" && first.toolName.length > 0,
    "toolResult carries a non-empty `toolName`",
  );
  assert(typeof first?.isError === "boolean", "toolResult.isError is a boolean");
}
