/**
 * #907 — the CI-wait exclusion for the slow-run watch's ELAPSED dimension.
 *
 * A healthy ops ship job sits in `gh pr checks --watch` / `gh run watch`
 * for ~7 minutes a time; the slow watch used to count that wall time and
 * steer a healthy job at 20 minutes. The decision: time during which the
 * child has an in-flight CI-watch tool call does not count toward the
 * elapsed threshold — the notice is DELAYED, never suppressed.
 *
 * Span signals (there is no tool_execution_start/end in PiJsonEvent):
 *   - OPEN: the assistant `message_end` `toolCall` block — its `id` plus
 *     the full `arguments`. Only a `bash` block whose command classifies
 *     as CI-watch opens a span (a toolCall whose arguments lack
 *     `command`, or whose block has no `id`, opens nothing).
 *   - CLOSE: the `toolResult` message whose `toolCallId` matches. An
 *     `isError` result closes too — the classifier keys on the OPENING
 *     command, never on the result.
 *
 * Spans are tracked per toolCallId and live on the tracker (the tracker
 * lives on the Watch and dies with it via `dispose`), so a killed child
 * (no toolResult ever) cannot exclude time forever or leak state into the
 * module-level watch map.
 */

import type { PiContentBlock, PiJsonEvent } from "./pi-event-shapes.ts";

/**
 * The canonical CI-watch shapes the ops recipes use (AGENTS.md / the ship
 * briefs). This list and the `isCiWatchCommand` classifier below must
 * change together — a recipe that gains a new watch form requires both the
 * list and the classifier to grow in the same change.
 */
export const CI_WATCH_SHAPES: readonly { cmd: string; description: string }[] = [
  { cmd: "gh pr checks … --watch", description: "GitHub PR required checks in watch mode" },
  { cmd: "gh run watch", description: "GitHub workflow run in watch mode" },
  { cmd: "glab ci status --live", description: "GitLab CI status in live mode" },
  { cmd: "glab ci view", description: "GitLab CI view" },
];

/**
 * Classifier — is this bash command a CI-watch command?
 *
 * Accepts exactly the four shapes in `CI_WATCH_SHAPES`, tolerant of flag
 * order and of leading shell wrappers (`timeout <N>[smh]? ` with
 * optional flags such as `-k 5`, `env VAR=… `, `nice `) in any combination
 * and order:
 *   - `gh pr checks … --watch`   - `gh run watch`
 *   - `glab ci status --live`    - `glab ci view`
 *
 * A CHAINED command (`&&`, `;`, `|`, …) is NOT classified: only a single
 * plain command counts.
 */
export function isCiWatchCommand(raw: string): boolean {
  let cmd = raw;
  for (;;) {
    const m = cmd.match(/^timeout(?:\s+-\S+(?:\s+\S+)?)*\s+\d+[smh]?\s+/i);
    if (m) {
      cmd = cmd.slice(m[0].length).trimStart();
      continue;
    }
    const e = cmd.match(/^env\s+\w+=\S*\s+/);
    if (e) {
      cmd = cmd.slice(e[0].length).trimStart();
      continue;
    }
    if (cmd.startsWith("nice ")) {
      cmd = cmd.slice(5).trimStart();
      continue;
    }
    break;
  }
  const tokens = cmd.trim().split(/\s+/);
  const idx = (s: string) => tokens.indexOf(s);
  if (idx("&&") !== -1 || idx(";") !== -1 || idx("|") !== -1) return false;
  if (tokens[0] === "gh" && idx("pr") === 1 && idx("checks") === 2 && idx("--watch") !== -1) {
    return true;
  }
  if (tokens[0] === "gh" && idx("run") === 1 && idx("watch") === 2) {
    return true;
  }
  if (tokens[0] === "glab" && idx("ci") === 1 && idx("status") === 2 && idx("--live") !== -1) {
    return true;
  }
  if (tokens[0] === "glab" && idx("ci") === 1 && idx("view") === 2) {
    return true;
  }
  return false;
}

/**
 * The span tracker for one slow watch. Tracks in-flight CI-watch bash
 * toolCalls, keyed per toolCallId; `excludedMs` is the wall time spent
 * inside an open span (open spans are measured live against `now()`, so
 * the value grows while a span is open and freezes when it closes).
 *
 * The caller (slow-notice.ts) keeps one instance per Watch, feeds it from
 * the raw event stream, and disposes it when the watch stops — the span
 * state dies with the watch.
 */
export interface CiWaitSpanTracker {
  /** OPEN signal: one assistant `message_end` content block list. */
  observeBlocks(blocks: PiContentBlock[]): void;
  /** CLOSE signal: one `toolResult` message (an isError result closes too). */
  observeToolResult(toolCallId: unknown): void;
  /** Excluded wall time in ms (live while spans are open). */
  excludedMs: (now: number) => number;
  /** The caller's clock; used for open-span accounting. */
  now: () => number;
  /** Drop all state (the watch is being stopped). */
  dispose: () => void;
}

/** A span's bookkeeping: the wall moment it opened, and the accumulated
 * ms of CLOSED spans with the same toolCallId (a child can re-issue the
 * same id across retries; the ids are unique in practice, but the map is
 * keyed per id either way). */
interface SpanEntry {
  openAt: number | undefined;
  closedTotal: number;
}

export function createCiWaitSpanTracker(now: () => number): CiWaitSpanTracker {
  const spans = new Map<string, SpanEntry>();
  return {
    observeBlocks(blocks: PiContentBlock[]): void {
      for (const block of blocks) {
        if (block.type !== "toolCall" || block.name !== "bash") continue;
        const id = block.id;
        if (!id) continue; // no id → the span can never be closed; skip.
        const args = block.arguments;
        if (!args || typeof args !== "object") continue; // no command → skip.
        const cmd = (args as Record<string, unknown>).command;
        if (typeof cmd !== "string" || !isCiWatchCommand(cmd)) continue;
        // An id already tracked (open or previously closed) is left
        // untouched: the open span wins, a closed total is never
        // double-counted.
        if (!spans.has(id)) spans.set(id, { openAt: now(), closedTotal: 0 });
      }
    },
    observeToolResult(toolCallId: unknown): void {
      if (typeof toolCallId !== "string" || toolCallId === "") return;
      const span = spans.get(toolCallId);
      if (!span) return;
      if (span.openAt === undefined) return; // already closed; idempotent.
      span.closedTotal += Math.max(0, now() - span.openAt);
      span.openAt = undefined;
    },
    excludedMs: (at: number): number => {
      let total = 0;
      for (const span of spans.values()) {
        if (span.openAt !== undefined) total += Math.max(0, at - span.openAt);
        // #907 — a CLOSED span is never double-counted: its live measurement
        // ends at the close moment (openAt → undefined), after which only
        // the frozen `closedTotal` carries its duration.
      }
      for (const span of spans.values()) {
        total += span.closedTotal;
      }
      return total;
    },
    now,
    dispose: () => {
      spans.clear();
    },
  };
}

/** #907 — wraps the caller's onRawEvent so the span tracker is fed from
 * the watch's own clock: the assistant toolCall block of a message_end
 * opens a span, the matching toolResult closes it. The caller's hook is
 * chained, never replaced. Returns the wrapper (or undefined when the
 * caller passed no onRawEvent). */
export function installRawEventSeam(
  userFn: (event: PiJsonEvent) => void,
  ciWait: CiWaitSpanTracker,
): (event: PiJsonEvent) => void {
  return (event) => {
    const msg = (
      event as { message?: { role?: string; content?: PiContentBlock[]; toolCallId?: string } }
    ).message;
    if (msg && msg.role === "assistant" && Array.isArray(msg.content))
      ciWait.observeBlocks(msg.content);
    else if (msg && msg.role === "toolResult") ciWait.observeToolResult(msg.toolCallId);
    userFn(event);
  };
}
