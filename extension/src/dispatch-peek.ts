/**
 * dispatch_peek — PM-callable introspection of an in-flight subagent (#21).
 *
 * Where `dispatch_status` returns pure metadata (jobId, role, elapsed),
 * `dispatch_peek` adds the bounded RunningState snapshot the dispatch deck
 * (#117) already maintains: last tool name, truncated last assistant text,
 * turn count, token usage, model. Same in-memory source — no new event
 * plumbing.
 *
 * Use case: PM answers "what's developer doing right now?" by quoting the
 * peeked state. NEVER reads the raw transcript file (forbidden by #19).
 *
 * Boundedness: per-job header (~120 chars) + ≤200 chars of truncated lastText.
 * Strictly metadata + the most recent assistant text snippet.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type DeckEntry, snapshot as deckSnapshot } from "./dispatch-deck.ts";
import { type RunningState, formatElapsed, formatTokens } from "./progress.ts";

const LAST_TEXT_MAX = 200;

export function registerDispatchPeekTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_peek",
    label: "Peek Running Subagent",
    description:
      "Inspect what an in-flight subagent is currently doing — turns, last tool, truncated last assistant text snippet, elapsed, tokens. Call this when the user asks 'what's <role> doing right now?' rather than guessing or fabricating. With a jobId, returns one row; without one, returns all in-flight. Bounded by design: never includes raw transcript, never the full message history.",
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({
          description:
            "Optional job id (as shown by dispatch_status). Omit to peek every in-flight job.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { jobId?: string };
      const all = deckSnapshot();
      if (params.jobId) {
        const entry = all.find((e) => e.key === params.jobId);
        if (!entry) {
          const details: PeekDetails = { found: false, jobId: params.jobId, entries: [] };
          return {
            content: [
              {
                type: "text",
                text: `No such in-flight job '${params.jobId}'. It may have finished — call dispatch_status to list active jobs.`,
              },
            ],
            details,
          };
        }
        const details: PeekDetails = {
          found: true,
          jobId: params.jobId,
          entries: [serialise(entry)],
        };
        return { content: [{ type: "text", text: renderPeek([entry]) }], details };
      }
      const details: PeekDetails = {
        found: true,
        entries: all.map(serialise),
      };
      return { content: [{ type: "text", text: renderPeek(all) }], details };
    },
  });
}

interface PeekDetails {
  /** True when the request returned at least one row or matched a known job. */
  found: boolean;
  /** Echoed back when caller passed a specific jobId. */
  jobId?: string;
  entries: SerialisedEntry[];
}

interface SerialisedEntry {
  key: string;
  label: string;
  role: string;
  tag?: string;
  turns: number;
  toolUses: number;
  lastToolName?: string;
  lastText?: string;
  elapsedMs: number;
  totalTokens: number;
  model?: string;
}

function serialise(e: DeckEntry): SerialisedEntry {
  const u = e.state.usage;
  return {
    key: e.key,
    label: e.label,
    role: e.state.role,
    tag: e.state.tag,
    turns: e.state.turns,
    toolUses: e.state.toolUses,
    lastToolName: e.state.lastToolName,
    lastText: e.state.lastText,
    elapsedMs: e.state.elapsedMs,
    totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    model: e.state.model,
  };
}

function truncate(s: string, max: number): string {
  const oneLine = s.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function renderHeader(state: RunningState, label: string, key: string): string {
  const parts = [`[${key}]`, label, `${state.turns} turn${state.turns === 1 ? "" : "s"}`];
  if (state.lastToolName) {
    parts.push(`last: ${state.lastToolName}`);
  }
  parts.push(formatElapsed(state.elapsedMs));
  const u = state.usage;
  const totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} toks`);
  if (state.model) parts.push(state.model);
  return parts.join(" · ");
}

export function renderPeek(entries: DeckEntry[]): string {
  if (entries.length === 0) return "no in-flight subagents — call dispatch_status to confirm";
  const lines: string[] = [`peek (${entries.length} in flight):`];
  for (const e of entries) {
    lines.push(`  ${renderHeader(e.state, e.label, e.key)}`);
    if (e.state.lastText) {
      lines.push(`    last said: "${truncate(e.state.lastText, LAST_TEXT_MAX)}"`);
    }
  }
  return lines.join("\n");
}
