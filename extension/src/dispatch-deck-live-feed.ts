/**
 * The live buffer's FEED PATH (#1032 split from dispatch-deck-live.ts when
 * that file hit the 500-line cap): `feedRawEvent` and `pushEvent`, the
 * per-event normalisation of a raw child event into a `LiveEvent`, and the
 * per-job char-bound enforcement (`trimToBound`).
 *
 * The ring-buffer state (the buffers, the per-key running sizes, the append
 * subscribers) and its lifecycle (`startBuffer` / `dropBuffer` / …) stay in
 * dispatch-deck-live.ts; this module imports that state via the seams the
 * main module exports, so the public import paths are unchanged.
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

import { sanitizeForStorage, sanitizeText } from "./dispatch-deck-line.ts";
import type { LiveEvent } from "./dispatch-deck-live.ts";
import {
  LIVE_BUFFER_MAX_CHARS,
  bufferSizes,
  buffers,
  eventSize,
  notifyAppend,
} from "./dispatch-deck-live.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";

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
    let rawArgs = "";
    if (event.args !== undefined && event.args !== null) {
      try {
        rawArgs = JSON.stringify(event.args) ?? "";
      } catch {
        rawArgs = "[unserialisable args]";
      }
    }
    const ev: LiveEvent = {
      kind: "toolCall",
      name: sanitizeText(`↳ ${event.toolName}`),
      args: sanitizeForStorage(rawArgs),
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
        args:
          block.arguments === undefined || block.arguments === null
            ? ""
            : (JSON.stringify(block.arguments) ?? ""),
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

/**
 * Enforce the per-job char bound AFTER a push: evict OLDEST-first
 * (`buf.shift()` — acceptable: the buffer is bounded in size) until the
 * RUNNING total (maintained per key by `feedRawEvent`, so no re-summing)
 * is within `LIVE_BUFFER_MAX_CHARS` — a live view must show the RECENT
 * activity, so the just-pushed event is never the first casualty. The
 * `buf.length > 1` guard keeps a lone oversized event ALONE and untruncated
 * (evicting it would empty the buffer — the bound caps the TOTAL across
 * events, never a lone event). Nothing "sticks": a >512 KB event — a large
 * file read — survives only until the next event arrives, at which point
 * it is the OLDEST and the first to be evicted.
 *
 * Exported (not private): dispatch-deck-live.ts `appendOperatorSteer`
 * pushes through the SAME bound as the feed path (#1032 split).
 */
export function trimToBound(key: string, buf: LiveEvent[]): boolean {
  if (buf.length === 0) return false;
  // Evict oldest-first, but never evict down to zero events — a lone
  // oversized event is retained alone (see above).
  let total = bufferSizes.get(key) ?? 0;
  while (total > LIVE_BUFFER_MAX_CHARS && buf.length > 1) {
    const oldest = buf.shift();
    if (oldest) total -= eventSize(oldest);
  }
  bufferSizes.set(key, total);
  return true;
}
