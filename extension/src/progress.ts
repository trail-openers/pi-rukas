/**
 * Live progress rendering for spawned specialists.
 *
 * The pattern matches Pi's bundled `subagent/` example:
 * - parse JSON events from the child's stdout as they arrive
 * - on every `message_end` (assistant turn complete), update a `RunningState`
 *   and call the dispatcher's `onProgress` callback
 * - the dispatcher translates the state into Pi's `AgentToolUpdateCallback`
 *   shape (`{ content, details }`) and forwards to Pi's `onUpdate`
 *
 * The user sees the resulting text replace "Working..." in the tool block,
 * updating roughly once per child turn.
 */

import type { DispatchUsage } from "./types.ts";

export interface RunningState {
  /** Role label (e.g. "developer", "code-review-specialist"). */
  role: string;
  /** Optional disambiguation tag (e.g. lens name in six-pass review). */
  tag?: string;
  /** Number of assistant turns completed in the child so far. */
  turns: number;
  /** Total tool calls the child has issued so far. */
  toolUses: number;
  /** Most recent tool call's name (e.g. "bash", "read"). */
  lastToolName?: string;
  /**
   * Truncated string hint extracted from the most recent tool call's
   * arguments — e.g., the bash command for `bash`, the file path for
   * `read`/`write`/`edit`, the pattern for `grep`. Surfaced in the
   * dispatch deck row so the user can see "bash: parallel-cli research
   * poll trun_…" instead of just "bash". See `extractToolHint`.
   */
  lastToolHint?: string;
  /** Truncated assistant text from the most recent message. */
  lastText?: string;
  /** Running cumulative usage stats. */
  usage: DispatchUsage;
  /** Model in use (populated after first assistant message). */
  model?: string;
  /** ms since spawn began. */
  elapsedMs: number;
  /**
   * Epoch ms of the most recent child event ingested — ANY event type
   * (#299), not just assistant turn ends: the assistant message carrying a
   * toolCall completes BEFORE the tool executes, so a turn-end-only
   * heartbeat flagged healthy children as STALE during every long build/
   * test/CI tool call. Used by the dispatch-deck STALE detection: if
   * `now - lastEventAt` exceeds `PI_ENSEMBLE_STALE_THRESHOLD_MS`, the row
   * marks STALE. Note pi children emit NO events mid-turn (long thinking)
   * or mid-tool-execution, so healthy gaps up to ~15 min occur — the
   * threshold default accounts for that. Undefined until the first event.
   */
  lastEventAt?: number;
  /** True once the child has exited; false while in-flight. */
  done: boolean;
  /** Set when done — child exited cleanly. */
  ok?: boolean;
}

export function emptyRunningState(role: string, tag?: string): RunningState {
  return {
    role,
    tag,
    turns: 0,
    toolUses: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    elapsedMs: 0,
    done: false,
  };
}

export function formatTokens(count: number): string {
  if (!count || count < 0) return "0";
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * Cache hit rate as a compact percent string ("78%"), or undefined when it
 * cannot be computed. #534 — half the provider fleet reports cacheRead=0
 * structurally (no prompt caching), so the guards are load-bearing, not
 * cosmetic: cacheRead must be > 0 (never render "0%" for a provider that
 * simply doesn't cache) and the denominator must be > 0 (a turn that sent
 * nothing is no signal).
 */
export function cacheHitRate(u: { input: number; cacheRead: number }): string | undefined {
  if (u.cacheRead <= 0 || u.input < 0) return undefined;
  const denom = u.cacheRead + u.input;
  if (denom <= 0) return undefined;
  return `${Math.round((u.cacheRead / denom) * 100)}%`;
}

/**
 * One-line usage summary: `2 turns · 4.2s · ↑3.1k ↓890 R12k W4k $0.0021 · model`.
 * Only includes fields that have non-zero values. The cache hit rate
 * (R/(R+↑)) appears right after the cacheRead figure when it is computable;
 * providers without prompt caching show no rate at all.
 */
export function formatUsage(state: RunningState): string {
  const u = state.usage;
  const parts: string[] = [];
  if (state.turns) parts.push(`${state.turns} turn${state.turns > 1 ? "s" : ""}`);
  parts.push(formatElapsed(state.elapsedMs));
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cacheRead) {
    parts.push(`R${formatTokens(u.cacheRead)}`);
    const rate = cacheHitRate(u);
    if (rate) parts.push(rate);
  }
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (state.model) parts.push(state.model);
  return parts.join(" · ");
}

export function statusIcon(state: RunningState): string {
  if (!state.done) return "⏳";
  return state.ok ? "✓" : "✗";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Render a single child's progress as a 1–2-line block. */
export function renderSingle(state: RunningState): string {
  const label = state.tag ? `${state.role} (${state.tag})` : state.role;
  const head = `${statusIcon(state)} ${label} · ${formatUsage(state)}`;
  const sub: string[] = [];
  if (!state.done) {
    if (state.lastToolName) {
      sub.push(
        `  · running ${state.lastToolName}${state.toolUses > 1 ? ` (#${state.toolUses})` : ""}`,
      );
    } else if (state.lastText) {
      sub.push(`  · ${truncate(state.lastText.replaceAll("\n", " "), 80)}`);
    }
  }
  return [head, ...sub].join("\n");
}

/**
 * Render a parallel batch: `dispatch_parallel · 3/6 done, 3 running` header
 * plus one block per child.
 */
export function renderBatch(label: string, states: RunningState[]): string {
  const done = states.filter((s) => s.done).length;
  const total = states.length;
  const running = total - done;
  const header = `${label} · ${done}/${total} done${running > 0 ? `, ${running} running` : ""}`;
  const blocks = states.map(renderSingle);
  return [header, "", ...blocks].join("\n");
}

/** Strict subset of Pi's JSON event shape that we care about for progress. */
interface ProgressEvent {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      arguments?: unknown;
    }>;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
    model?: string;
  };
}

/**
 * Priority-ordered keys we look at first when extracting a one-line hint
 * from a tool call's `arguments` object. Order matches "what's most
 * meaningful to a human glancing at the deck row":
 *   - `command` / `cmd` — the bash command (most informative for `bash`)
 *   - `file_path` / `path` — file targets for read/write/edit
 *   - `pattern` — rg / regex query
 *   - `query` — vipune / search-style tools
 *   - `url` — fetch-style tools
 * If none match, falls back to the first non-empty string-valued field.
 * Used by `ingestEvent` to populate `RunningState.lastToolHint`.
 */
const TOOL_HINT_PRIORITY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
] as const;

const TOOL_HINT_MAX = 50;

export function extractToolHint(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const obj = args as Record<string, unknown>;
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  for (const k of TOOL_HINT_PRIORITY_KEYS) {
    const v = pick(obj[k]);
    if (v) return truncateHint(v);
  }
  for (const v of Object.values(obj)) {
    const s = pick(v);
    if (s) return truncateHint(s);
  }
  return undefined;
}

function truncateHint(s: string): string {
  const oneLine = s.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= TOOL_HINT_MAX) return oneLine;
  return `${oneLine.slice(0, TOOL_HINT_MAX - 1).trimEnd()}…`;
}

/**
 * Mutate `state` from a single child event. Returns true if this event
 * advanced the state in a way worth emitting onProgress about
 * (i.e. a new assistant turn ended).
 */
export function ingestEvent(state: RunningState, event: ProgressEvent, startMs: number): boolean {
  state.elapsedMs = Date.now() - startMs;
  // #299 — STALE heartbeat refreshes on ANY child event, not just assistant
  // turn ends. The assistant message carrying a toolCall completes BEFORE
  // the tool executes, so under the old turn-end-only heartbeat any build/
  // test/CI tool call >90s flagged a healthy child as STALE (empirical:
  // 14.6-min healthy bash gaps flagged in production transcripts). Any
  // event from the child — tool results included — proves it is alive.
  state.lastEventAt = Date.now();
  if (event.type !== "message" && event.type !== "message_end") return false;
  const msg = event.message;
  if (!msg || msg.role !== "assistant") return false;
  state.turns += 1;
  if (msg.model && !state.model) state.model = msg.model;
  if (msg.usage) {
    state.usage.input += msg.usage.input ?? 0;
    state.usage.output += msg.usage.output ?? 0;
    state.usage.cacheRead += msg.usage.cacheRead ?? 0;
    state.usage.cacheWrite += msg.usage.cacheWrite ?? 0;
    state.usage.cost += msg.usage.cost?.total ?? 0;
    state.usage.turns = state.turns;
  }
  // Find the latest tool call name + assistant text in this turn.
  let latestToolName: string | undefined;
  let latestToolHint: string | undefined;
  let latestText: string | undefined;
  for (const block of msg.content ?? []) {
    if (block.type === "toolCall" && block.name) {
      latestToolName = block.name;
      latestToolHint = extractToolHint(block.arguments);
      state.toolUses += 1;
    } else if (block.type === "text" && typeof block.text === "string") {
      latestText = block.text;
    }
  }
  if (latestToolName) state.lastToolName = latestToolName;
  // Hint refreshes alongside the name (or clears if the latest tool has no
  // extractable hint — keeps deck snapshot honest).
  if (latestToolName) state.lastToolHint = latestToolHint;
  if (latestText) state.lastText = latestText;
  return true;
}
