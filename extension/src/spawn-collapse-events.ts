/**
 * Collapses a spawned child's raw `agent_end`/`message_end` JSONL events into
 * a single `DispatchResult` — the text/tool-uses/usage summary every dispatch
 * tool and the async-job reporter consumes. Split out of spawn.ts (#171) to
 * stay under the module-size guideline (AGENTS.md §12); spawnSpecialist is
 * the only caller.
 */

import { NO_TEXT_PLACEHOLDER } from "./lens-review-format.ts";
import { adapterFor } from "./model-adapters.ts";
import type { PiContentBlock, PiJsonEvent, PiMessage } from "./pi-event-shapes.ts";
import type { DispatchResult } from "./types.ts";

export function collapseEvents(
  lastAgentEnd: PiJsonEvent | null,
  lastAssistantMessageEnd: PiJsonEvent | null,
  role: string,
  ms: number,
  exitCode: number | null,
  stderr: string,
): DispatchResult {
  // Prefer agent_end's assembled messages; fall back to last assistant
  // message_end if agent_end is missing. The two slots are filled by the
  // stdoutRl line handler — see spawn() — so we never need to walk a full
  // event history here.
  let messages: PiMessage[] = lastAgentEnd?.messages ?? [];
  if (messages.length === 0 && lastAssistantMessageEnd?.message) {
    messages = [lastAssistantMessageEnd.message];
  }
  // #1032 — toolResult usage summation (below) requires the full message
  // list; the assistant-only fallback above cannot carry a toolResult, so it
  // contributes nothing here (an assistant message_end carries no nested
  // codemode usage — that only ever lands on the parent toolResult message,
  // which is only present in a full agent_end transcript).

  const textParts: string[] = [];
  const toolUses: PiContentBlock[] = [];
  let turns = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let model: string | undefined;
  let provider: string | undefined;
  let api: string | undefined;
  let hasThinking = false;
  let hasText = false;

  // #1032 — Pi stamps the SUMMED usage of every nested (codemode) tool call
  // onto the model-issued call's OWN toolResult message (agent-session
  // `combineUsage`; see `NestedCallSummary.usage` in pi's
  // `nested-tool-calls.d.ts`). Those nested calls are NOT visible as
  // assistant turns in this transcript — the parent's assistant `message_end`
  // only carries the model call that ISSUED the codemode script, not the
  // nested calls it executed — so the toolResult message's `usage` field is
  // the only record of that spend. We add it here, separately from the
  // assistant-message loop below, so:
  //   - a toolResult with no `usage` (an empty or errored codemode call)
  //     contributes 0, and
  //   - the same field is never also re-counted from any other message, so
  //     the total is assistant usage + toolResult usage, exactly once each.
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!msg.usage) continue;
    usage.input += msg.usage.input ?? 0;
    usage.output += msg.usage.output ?? 0;
    usage.cacheRead += msg.usage.cacheRead ?? 0;
    usage.cacheWrite += msg.usage.cacheWrite ?? 0;
    usage.cost += msg.usage.cost?.total ?? 0;
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    turns++;
    if (msg.model && !model) model = msg.model;
    if (msg.provider && !provider) provider = msg.provider;
    if (msg.api && !api) api = msg.api;
    if (msg.usage) {
      usage.input += msg.usage.input ?? 0;
      usage.output += msg.usage.output ?? 0;
      usage.cacheRead += msg.usage.cacheRead ?? 0;
      usage.cacheWrite += msg.usage.cacheWrite ?? 0;
      usage.cost += msg.usage.cost?.total ?? 0;
    }
    // Per-message model adapter: handles quirks specific to the LLM family
    // that emitted this message (e.g. GLM's "None" placeholder text blocks).
    // Default adapter is no-op, so unknown models pass through unchanged.
    const adapter = adapterFor(msg.model, msg.provider);
    for (const block of msg.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        if (adapter.isArtifactText?.(block.text)) continue;
        textParts.push(block.text);
        hasText = true;
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        // Track thinking existence separately from text
        if (block.thinking.trim()) {
          hasThinking = true;
        }
      } else if (block.type === "toolCall") {
        toolUses.push(block);
      }
    }
  }

  // Join with double-newline so distinct text blocks across turns (separated
  // by tool calls in between) stay visually delimited instead of concatenated.
  const text = textParts.filter((t) => t.trim()).join("\n\n");

  // Detect thinking-only output: some thinking-heavy models produce
  // thinking blocks but no text blocks (issue #5). Surface this clearly
  // instead of returning "(no output)" which reads like a bug. If the
  // model also emitted tool calls, don't flag as thinking-only — tool
  // execution is meaningful output.
  const thinkingOnly = hasThinking && !hasText && toolUses.length === 0;

  // Detect synthetic error-stop: pi-ai providers turn HTTP timeouts and
  // transport failures into an assistant message with `stopReason: "error"`
  // and empty content. The child process still exits 0 (the failure is
  // *inside* the conversation, not at the process level), so without this
  // signal the dispatch report mistakes the last successful thinking block
  // for the final reply. See PR #236 + transcripts under
  // ~/.pi/agent/ensemble-runs/2026-06-19/mqkw4ydu-2y6oh9-*.json for the
  // failure shape that motivated the detection.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const errorStop =
    lastAssistant?.stopReason === "error"
      ? { reason: "error", message: lastAssistant.errorMessage }
      : undefined;

  // Construct the text field. For thinking-only output, use a clear message
  // that distinguishes this case from actual "no output".
  const resolvedText = thinkingOnly ? NO_TEXT_PLACEHOLDER : text || stderr || "(no output)";

  return {
    role,
    ok: exitCode === 0 && !errorStop,
    text: resolvedText,
    toolUses,
    ms,
    exitCode,
    usage: { ...usage, turns },
    model,
    provider,
    api,
    errorStop,
    thinkingOnly,
  };
}
