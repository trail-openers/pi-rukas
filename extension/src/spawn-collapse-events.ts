/**
 * Collapses a spawned child's raw `agent_end`/`message_end` JSONL events into
 * a single `DispatchResult` — the text/tool-uses/usage summary every dispatch
 * tool and the async-job reporter consumes. Split out of spawn.ts (#171) to
 * stay under the module-size guideline (AGENTS.md §12); spawnSpecialist is
 * the only caller.
 */

import { NO_TEXT_PLACEHOLDER } from "./lens-review-incomplete.ts";
import { adapterFor } from "./model-adapters.ts";
import type { PiContentBlock, PiJsonEvent, PiMessage } from "./pi-event-shapes.ts";
import { addUsage } from "./pi-usage.ts";
import { RECORDED_ARGS_DETAILS_KEY } from "./plan-workstream-schema.ts";
import type { DispatchResult } from "./types.ts";

/** The longest tool-result text kept on a DispatchResult (#1652). */
const TOOL_RESULT_TEXT_MAX = 300;

/**
 * The `report_workstream` tool's name — the ONLY tool whose `details` this
 * module carries. Named here rather than imported so the collapse path does not
 * pull the plan module graph into every spawn.
 */
const REPORT_WORKSTREAM_TOOL = "report_workstream";

/**
 * The longest `details` JSON kept on a tool result (#1756 round 2). The plan
 * child's companion echoes the arguments it recorded there and the driver judges
 * that value, so it must survive the collapse — but a tool's `details` is an
 * arbitrary `unknown` the extension author chose, and some tools put large
 * payloads there. This is the bound that keeps a runaway `details` from becoming
 * a second unbounded channel on every DispatchResult: past it the key is
 * omitted, which the reader reads as NO echo and handles as it always did (judge
 * the raw arguments). Generous against the schema's own ceilings, which bound
 * one `report_workstream` call to a few tens of KB at the very most.
 */
export const TOOL_RESULT_DETAILS_MAX = 64 * 1024;

/**
 * The `details` to carry for one tool result: only `report_workstream`'s, only
 * the `recordedArgs` key the plan reader consumes, and only within
 * `TOOL_RESULT_DETAILS_MAX`. Everything else — another tool's payload, a
 * non-JSON-serialisable value, an over-capacity one — is omitted, and omission
 * is the reader's "no echo" answer, never a guessed one. `details` stays
 * `unknown` at the transport: this module does not know the echo's shape and the
 * reader narrows it (plan-workstream-schema.ts).
 */
function carriedDetails(toolName: string, details: unknown): Record<string, unknown> | undefined {
  if (toolName !== REPORT_WORKSTREAM_TOOL) return undefined;
  if (!isObjectLike(details)) return undefined;
  const echoed = details[RECORDED_ARGS_DETAILS_KEY];
  // A null / string / array under the key is not a params object anybody
  // recorded; carrying it would let the transport assert an echo the child never
  // built. Omit it and the reader judges the raw arguments.
  if (!isObjectLike(echoed)) return undefined;
  let json: string;
  try {
    json = JSON.stringify(echoed);
  } catch {
    // A value JSON cannot express is not a structured echo anybody recorded.
    return undefined;
  }
  if (typeof json !== "string" || json.length > TOOL_RESULT_DETAILS_MAX) return undefined;
  return { [RECORDED_ARGS_DETAILS_KEY]: echoed };
}

/**
 * The text of a tool result's blocks, accumulated block by block and stopped at
 * TOOL_RESULT_TEXT_MAX — so a large non-text payload is never joined in full
 * just to be cut down afterwards.
 */
function boundedResultText(blocks: PiContentBlock[]): string {
  let out = "";
  for (const block of blocks) {
    if (typeof block.text !== "string") continue;
    out += block.text;
    if (out.length >= TOOL_RESULT_TEXT_MAX) return out.slice(0, TOOL_RESULT_TEXT_MAX);
  }
  return out;
}

/**
 * The own-property plain-object test a structured payload must pass. The same
 * prototype rule `plan-provenance.ts`'s `isPlainObject` makes — kept local
 * rather than imported so the spawn path every dispatch runs through does not
 * gain an edge on the issue-filing provenance module. A value this refuses is
 * dropped by the caller, never forwarded as a payload the reader could misread.
 */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

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
  // onto the parent call's OWN toolResult message (see `NestedCallSummary`
  // in pi's `nested-tool-calls.d.ts`); that `usage` field is the only
  // record of that spend, so it is summed here, once, through the same
  // `addUsage` helper the assistant loop below uses.
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!msg.usage) continue;
    addUsage(usage, msg.usage, {});
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    turns++;
    if (msg.model && !model) model = msg.model;
    if (msg.provider && !provider) provider = msg.provider;
    if (msg.api && !api) api = msg.api;
    if (msg.usage) addUsage(usage, msg.usage, {});
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

  // #1652 — which tool calls Pi accepted. Refusal text is kept (bounded): it is
  // the reason the operator reads when a plan parks on refused calls.
  const toolResults = messages
    .filter(
      (m): m is PiMessage & { toolCallId: string } =>
        m.role === "toolResult" && typeof m.toolCallId === "string",
    )
    .map((m) => {
      const toolName = m.toolName ?? "";
      const details = carriedDetails(toolName, m.details);
      return {
        toolCallId: m.toolCallId,
        toolName,
        // Fail closed: only an explicit `false` is a success (#1652 review).
        isError: m.isError !== false,
        text: boundedResultText(m.content ?? []),
        // #1756 round 2 — the companion's structured echo rides here, bounded
        // and filtered by `carriedDetails`: only report_workstream's, only the
        // key the reader reads, only within the cap. Kept whole and NOT bounded
        // like `text`, which is truncated for display — a bound on the judgement
        // channel would silently destroy it, so an over-capacity payload is
        // dropped entirely and read as no echo instead of half a judgement.
        ...(details === undefined ? {} : { details }),
      };
    });

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
  // for the final reply. See PR #236 and the transcripts of the run that
  // motivated the detection for the failure shape.
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
    ...(toolResults.length > 0 ? { toolResults } : {}),
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
