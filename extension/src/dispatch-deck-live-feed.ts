/**
 * The live buffer's FEED PATH (#1032 split from dispatch-deck-live.ts when
 * that file hit the 500-line cap): `feedRawEvent` and `pushEvent`, the
 * per-event normalisation of a raw child event into a `LiveEvent`.
 *
 * The ring-buffer state (the buffers, the per-key running sizes, the
 * char-bound enforcement `trimToBound`, the append subscribers) lives in
 * dispatch-deck-live-state.ts, which both this module and
 * dispatch-deck-live.ts import — they never import each other (the main
 * module re-exports the feed functions, one direction only).
 *
 * A top-level tool call is surfaced by the assistant message's `toolCall`
 * content block — the `tool_execution_start` that Pi emits for it is the
 * SAME call (verified against pi-coding-agent's agent-loop: the top-level
 * emit carries no `parentToolCallId`), so `pushEvent` only stores
 * `tool_execution_start` events that ARE nested (`parentToolCallId` present
 * — the codemode `ctx.executeTool` path in pi's nested-tool-calls, which
 * renders no message-bearing block of its own). Storing the top-level event
 * too would double-render every tool call in the deck.
 */

// =============================================================================
// Feed path
// =============================================================================

import { sanitizeForStorage, sanitizeText } from "./dispatch-deck-line.ts";
import {
  LIVE_BUFFER_MAX_CHARS,
  bufferSizes,
  buffers,
  eventSize,
  notifyAppend,
  trimToBound,
} from "./dispatch-deck-live-state.ts";
import type { LiveEvent } from "./dispatch-deck-live-state.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";

/**
 * #1032 — the ONE serialiser for tool-call args in the feed path. The two
 * branches (the nested `tool_execution_start` branch and the assistant
 * `toolCall` block branch) used to stringify args two different ways
 * (a try/catch fallback here, a `JSON.stringify(...) ?? ""` there with a
 * dead `??`); this helper replaces both: "" for undefined/null, a
 * try/catch fallback that can never leave the buffer holding a non-string.
 */
function stringifyArgs(x: unknown): string {
  if (x === undefined || x === null) return "";
  try {
    return JSON.stringify(x);
  } catch {
    return "[unserialisable args]";
  }
}

/**
 * Feed one parsed child event into the job's ring buffer. Events the
 * overlay cannot show (non-assistant / non-toolResult messages, empty
 * content) are dropped silently. A feed for a key with no buffer (quiet
 * mode, or a lens/adversarial child) is a no-op.
 */
export function feedRawEvent(key: string, event: PiJsonEvent): void {
  const buf = buffers.get(key);
  if (!buf) return;
  const added = pushEvent(key, buf, event);
  if (added) notifyAppend(key);
}

/**
 * Push a parsed event onto a buffer (module helper, exported for the
 * feed-path test). Returns true when at least one event was stored.
 *
 * Storage is UNTRUNCATED (#916): the only bound is the per-job char cap
 * (`LIVE_BUFFER_MAX_CHARS`), enforced AFTER the push by evicting oldest
 * events first. Sanitisation (control chars, ANSI, newline collapse) is
 * kept — only the length truncation was removed.
 */
export function pushEvent(key: string, buf: LiveEvent[], event: PiJsonEvent): boolean {
  // #1032 — a tool_execution_start is stored ONLY when the call is nested
  // (parentToolCallId present). A top-level call already surfaces as a
  // toolCall entry from the assistant message's toolCall block — storing
  // its flat event too would render it twice. The nested codemode calls
  // (ctx.executeTool) emit flat events with a `<callerId>/<n>` toolCallId
  // and no message of their own, so this branch is their only record.
  // Args sanitised at feed time like every sibling branch (#927).
  if (event.type === "tool_execution_start" && event.toolName) {
    if (!event.parentToolCallId) return false;
    const ev: LiveEvent = {
      kind: "toolCall",
      name: sanitizeForStorage(`↳ ${event.toolName}`),
      args: sanitizeForStorage(stringifyArgs(event.args)),
    };
    buf.push(ev);
    bufferSizes.set(key, (bufferSizes.get(key) ?? 0) + eventSize(ev));
    return trimToBound(key, buf);
  }
  if (event.type !== "message" && event.type !== "message_end") return false;
  const msg = event.message;
  if (!msg) return false;
  let added = false;
  let total = bufferSizes.get(key) ?? 0;
  if (msg.role === "toolResult") {
    const resultText = (msg.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0)
      .map((b) => b.text as string)
      .join("");
    if (!resultText) return false;
    // #839 — the tool-result identity fields live on the MESSAGE (pi-ai
    // `ToolResultMessage`), not on the event; no cast needed. The result
    // text is untrusted child output — sanitise + collapse to ONE logical
    // line at feed time (newlines → the ` ⏎ ` separator, C0/ANSI stripped,
    // tabs → spaces) so the overlay can never desync pi-tui's line
    // accounting (issue #927: raw newlines / control chars from tool
    // results ghosted the overlay over the main chat and polluted the
    // scrollback on every 1 s re-render).
    const name = msg.toolName;
    const ev: LiveEvent = {
      kind: "toolResult",
      name: name ? sanitizeText(name) : "unknown",
      text: sanitizeForStorage(resultText),
      isError: msg.isError === true,
    };
    buf.push(ev);
    total += eventSize(ev);
    added = true;
    return trimToBound(key, buf);
  }
  if (msg.role !== "assistant") return false;
  for (const block of msg.content ?? []) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      const ev: LiveEvent = {
        kind: "text",
        text: sanitizeForStorage(block.text),
      };
      buf.push(ev);
      total += eventSize(ev);
      added = true;
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.length > 0
    ) {
      // #916 — thinking blocks were silently dropped before; store them as
      // their own variant so the view can render `▸ thinking (N chars)`.
      const ev: LiveEvent = {
        kind: "thinking",
        text: sanitizeForStorage(block.thinking),
      };
      buf.push(ev);
      total += eventSize(ev);
      added = true;
    } else if (block.type === "toolCall" && block.name) {
      // #916 — store the FULL JSON of the arguments (previously the 50-char
      // extractToolHint preview); the view renders it in full.
      const ev: LiveEvent = {
        kind: "toolCall",
        name: sanitizeText(block.name),
        // block.arguments comes from JSON.parse of the child's event stream, so it cannot be circular or contain BigInt — stringify cannot throw here.
        // Still routed through stringifyArgs + sanitizeForStorage: the "sanitised at feed time" invariant must hold at every storage site (#1032).
        args: sanitizeForStorage(stringifyArgs(block.arguments)),
      };
      buf.push(ev);
      total += eventSize(ev);
      added = true;
    }
  }
  if (added) {
    bufferSizes.set(key, total);
    return trimToBound(key, buf);
  }
  return added;
}
