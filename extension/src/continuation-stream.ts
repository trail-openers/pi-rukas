/**
 * continuation-stream — reading ONE resumed child's own reply out of a replayed session.
 *
 * A `pi --mode rpc --session <file>` child replays every earlier turn before it answers, so the
 * stream carries the first child's turn as well as the continuation's own. Both readers here take the
 * LAST `agent_end` only, for the same reason and with the same hazard: a reader that took any turn
 * would report the resumed child's predecessor — its closing text, its stop reason, its tokens — as
 * this child's. `usage` is read as that one turn's own counts and never summed, which is how a
 * session that replayed twenty turns would otherwise bill twenty times the child's cost.
 *
 * Split from `developer-session-continuation.ts` for the 500-line gate (AGENTS §12), along the seam
 * the module already states: these are the pure readers over the stream's bytes; that module owns
 * the spawn, the fence env and the kill bound.
 */

import type { DispatchUsage } from "./types.ts";

/** The LAST `agent_end`'s final assistant turn's `stopReason`, or undefined when the stream carried
 *  neither. The same replay-scanning rule `continuationReplyText` states: only the last `agent_end`
 *  describes the continuation's own turn, since a resumed session replays every earlier one.
 *
 * `usage` is read as that turn's OWN counts and never summed across turns — see `usageFromTurn`. */
export function lastAgentEndFinalTurn(rawStdout: string): {
  stopReason?: string;
  usage?: DispatchUsage;
} {
  let last: { stopReason?: string; usage?: DispatchUsage } = {};
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: { type?: string; messages?: unknown };
    try {
      event = JSON.parse(trimmed) as { type?: string; messages?: unknown };
    } catch {
      continue;
    }
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    for (const message of event.messages as Array<{
      role?: string;
      stopReason?: unknown;
      usage?: unknown;
    }>) {
      if (message?.role !== "assistant") continue;
      // The LAST assistant turn of the LAST `agent_end` is the continuation's own. Its usage is the
      // per-turn shape (`input`/`output`/…), so it is read as that and never summed: summing turns is
      // how a session that replayed twenty of them would bill twenty times the child's cost.
      const usage = usageFromTurn(message.usage);
      last = {
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(usage === undefined ? {} : { usage }),
      };
    }
  }
  return last;
}

/** The per-turn `usage` block, read as a turn's own counts, not a session's. Absent or malformed
 *  usage answers absent — the step bills a child it cannot read as zero, never as a guess. */
function usageFromTurn(usage: unknown): DispatchUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const num = (key: string): number => {
    const v = u[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  if (typeof u.input !== "number" && typeof u.output !== "number") return undefined;
  // Pi's per-turn `cost` is an object: `total`, and from Pi 1.5 `totalFromProvider`.
  const c =
    typeof u.cost === "object" && u.cost !== null ? (u.cost as Record<string, unknown>) : {};
  const total = c.total;
  const fromProvider = c.totalFromProvider;
  return {
    input: num("input"),
    output: num("output"),
    cacheRead: num("cacheRead"),
    cacheWrite: num("cacheWrite"),
    cost: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : 0,
    ...(typeof fromProvider === "boolean" ? { costFromProvider: fromProvider } : {}),
    turns: 1,
    toolCalls: 0,
    toolErrors: 0,
  };
}

/** The assistant text of the LAST `agent_end` the stream carried.
 *
 * Only that reply counts: a resumed session REPLAYS the earlier turns, so a reader that took any
 * assistant text would read the first child's own closing message back as the continuation's reply
 * — the same hazard `reaskReplyText` names for a reviewer, with the same answer. */
export function continuationReplyText(rawStdout: string): string {
  let last = "";
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: { type?: string; messages?: unknown };
    try {
      event = JSON.parse(trimmed) as { type?: string; messages?: unknown };
    } catch {
      continue;
    }
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    let text = "";
    for (const message of event.messages as Array<{
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>) {
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string") text += `${block.text}\n`;
      }
    }
    if (text.trim() !== "") last = text;
  }
  return last;
}
