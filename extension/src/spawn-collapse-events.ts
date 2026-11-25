/**
 * Collapses a spawned child's raw `agent_end`/`message_end` JSONL events into
 * a single `DispatchResult` — the text/tool-uses/usage summary every dispatch
 * tool and the async-job reporter consumes. Split out of spawn.ts (#171) to
 * stay under the module-size guideline (AGENTS.md §12); spawnSpecialist is
 * the only caller.
 *
 * #2618 — the tool calls a child made THROUGH codemode. Pi records a call a tool
 * made to another tool on the PARENT call's own `toolResult` message as
 * `nestedCalls`, never as an assistant `toolCall` block, so a reader that walks
 * assistant content cannot see them and the lean steps read a child that
 * submitted from one script as silent. `creditNestedReporterCalls` adds the
 * nested rows for the two lean companion tools (their names live in
 * `lean-reporter-tools.ts`, the one place they are spelled) to `toolUses`, after
 * the child's own blocks and in tool-result order — the transcript's own order,
 * which keeps each nested run behind its parent call; no other name enters the
 * array, so the lens and adversarial evidence consumers of `toolUses` are
 * unaffected by construction.
 *
 * Two decisions that are not visible in the code and must not be rediscovered:
 *   - a record whose `arguments` Pi dropped (past its size bound) is credited as
 *     a PRESENT-BUT-UNUSABLE entry, not skipped here: the lean extractors own the
 *     "unreadable call" count, and an entry that vanished would let the step say
 *     `the child never submitted a test` about a child that did submit.
 *   - `complete: false` credits the `ok` rows that survived and is traced, not
 *     carried on the entry. The flag describes Pi's recording of the whole batch,
 *     not the credited call: carrying it would put a transport-side caveat into
 *     the shape the extractors match, for no rule the reader could act on — the
 *     rows that survived really did run.
 *
 * Ordering is stated above; the `lastAssistantMessageEnd` fallback arm is NOT
 * credited and that is disclosed, not fixed: that arm holds one assistant message
 * and no tool result at all, so there is no `nestedCalls` to read. A child killed
 * before its result arrived stays silent, exactly as it did before #2618.
 */

import { CREDITED_NESTED_TOOLS } from "./lean-reporter-tools.ts";
import { NO_TEXT_PLACEHOLDER } from "./lens-review-incomplete.ts";
import { adapterFor } from "./model-adapters.ts";
import type { PiContentBlock, PiJsonEvent, PiMessage } from "./pi-event-shapes.ts";
import { addUsage } from "./pi-usage.ts";
import { isPlainObject } from "./plain-object.ts";
import {
  RECORDED_ARGS_DETAILS_KEY,
  REPORT_WORKSTREAM_TOOL,
  recordedWorkstreamDetails,
} from "./plan-workstream-schema.ts";
import { trace, traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/** The longest tool-result text kept on a DispatchResult (#1652). */
const TOOL_RESULT_TEXT_MAX = 300;

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
  if (!isPlainObject(details)) return undefined;
  const echoed = details[RECORDED_ARGS_DETAILS_KEY];
  // A null / string / array under the key is not a params object anybody
  // recorded; carrying it would let the transport assert an echo the child never
  // built. Omit it and the reader judges the raw arguments.
  if (!isPlainObject(echoed)) return undefined;
  let json: string;
  try {
    json = JSON.stringify(echoed);
  } catch {
    // A value JSON cannot express is not a structured echo anybody recorded.
    return undefined;
  }
  if (json.length > TOOL_RESULT_DETAILS_MAX) return undefined;
  // The ROUND-TRIPPED value rides, not the child's live object: JSON is the only
  // thing that crosses the process boundary, so what the driver judges must be
  // what JSON would have produced — no getters, no exotic prototype, no value a
  // JSON-inexpressible sibling smuggled next to it. A payload that cannot
  // round-trip is no echo, same as one that cannot be stringified.
  try {
    const carried = JSON.parse(json);
    if (!isPlainObject(carried)) return undefined;
    // The envelope is the writer's own function, so the key the transport puts on
    // the record cannot drift from the key the companion writes and the reader
    // reads (item: one envelope, three callers).
    return recordedWorkstreamDetails(carried);
  } catch {
    return undefined;
  }
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
 * The `toolUses` entry for one nested record, in the shape the lean extractors
 * already match (`{ name, arguments }`) — a nested call and a direct one are read
 * by the same code, which is the point of normalising here rather than at each
 * reader.
 *
 * `status` gates the credit: only `"ok"` is a call the child completed. `error`
 * and `unfinished` are a refusal and a call still running when the script ended —
 * neither is evidence of a submission, and neither is counted as unreadable either,
 * because the child never finished making it.
 *
 * A `"ok"` record whose `arguments` Pi dropped becomes `{}`, the one shape both
 * extractors read as "a call that named the tool and carried nothing readable":
 * `extractSubmitTests` counts it in `skipped` and `extractBlockedReport` counts
 * its yielded-nothing rule. It must NOT be omitted: an entry that vanished is the
 * silence the step reports as `the child never submitted a test`.
 */
function nestedToolUse(
  record: NonNullable<PiMessage["nestedCalls"]>["calls"][number],
): PiContentBlock | undefined {
  if (record.status !== "ok") return undefined;
  if (!CREDITED_NESTED_TOOLS.includes(record.name)) return undefined;
  // Pi's own `arguments` is a JSON object or absent; anything else at the
  // transport is not a params object anybody recorded, and reads as the omitted
  // case rather than being handed to the extractor as fact.
  const args = isPlainObject(record.arguments) ? record.arguments : {};
  return { type: "toolCall", id: record.id, name: record.name, arguments: args };
}

/**
 * The nested (`codemode`) reporter calls of one `toolResult` message, appended in
 * Pi's record order (#2618). One entry per record: each call is the unit of
 * record, so a logical submission made both directly and nested, or on two
 * codemode calls, is credited once per call — a dedupe keyed on id cannot work (a
 * direct call carries the model's id, a nested one `<callerId>/<n>`).
 *
 * An incomplete record credits the `ok` rows that survived and is traced: the
 * module header says why the flag is not carried. A record that credited nothing
 * traces nothing, because an all-error batch is a child that did not submit — not
 * a lost record.
 */
function creditNestedReporterCalls(msg: PiMessage, role: string, toolUses: PiContentBlock[]): void {
  const nested = msg.nestedCalls;
  if (nested === undefined || !Array.isArray(nested.calls)) return;
  const credited: PiContentBlock[] = [];
  for (const record of nested.calls) {
    if (!record || typeof record !== "object" || typeof record.name !== "string") continue;
    const entry = nestedToolUse(record);
    if (entry !== undefined) credited.push(entry);
  }
  toolUses.push(...credited);
  if (nested.complete === false)
    traceWarn(
      `spawn[${role}]: nested call record for ${msg.toolName ?? msg.toolCallId ?? "a tool"} ` +
        `was incomplete; credited ${String(credited.length)} reported call(s) that finished ok`,
    );
  else if (credited.length > 0)
    trace(
      `spawn[${role}]: credited ${String(credited.length)} nested reported call(s) from ` +
        `${msg.toolName ?? msg.toolCallId ?? "a tool"}`,
    );
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
        // #2618 — the calls THIS block's tool made to other tools ride on the
        // result message, so they are read in the result pass below, at the
        // parent's position; nothing to do here but keep the parent's own entry.
      }
    }
  }

  // #2618 — the nested (`codemode`) reporter calls, appended per tool-result
  // message in message order. Reading them in this pass rather than the assistant
  // loop above is what places a nested run after its parent's block and keeps Pi's
  // record order inside one result; results for the same turn arrive in the order
  // the calls were made, so a second codemode call's rows follow the first's.
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    creditNestedReporterCalls(msg, role, toolUses);
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

  // The final turn's stop reason, recorded for EVERY stop and not only the
  // `"error"` arm above. A child cut off at its output-token cap ends with
  // `"length"` and still exits 0, so `ok` stays true and nothing downstream can
  // tell a finished child from a truncated one — which is how a review fixer that
  // ran out of tokens mid-thought came back as "the fix produced no change". It
  // is carried verbatim rather than normalised: an absent reason means there was
  // no assistant turn to read one off (or no replay at all), and a reader must be
  // able to tell that from the turn having ended cleanly, so `"length"` and `"stop"
  // "end_turn"` cannot be collapsed into one default.
  const finalStopReason =
    typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : undefined;

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
    ...(finalStopReason === undefined ? {} : { stopReason: finalStopReason }),
    thinkingOnly,
  };
}
