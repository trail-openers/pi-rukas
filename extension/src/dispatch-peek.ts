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
import {
  driverOwnerTag,
  getOrchestratorActiveChild,
  isDriverOwnedJob,
  isOrchestratorJob,
} from "./async-jobs.ts";
import { type DeckEntry, snapshot as deckSnapshot } from "./dispatch-deck.ts";
import { formatElapsed, formatTokens } from "./progress.ts";

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
        // Orchestrator-shaped jobs (adversarial_loop) don't have a deck entry
        // keyed by their own jobId — they hide and let each inner phase own
        // the deck row. Resolve via the orchestrator's active-child registry
        // instead: if active, peek that inner deck entry; if between rounds,
        // return an explicit "between rounds" status.
        if (isOrchestratorJob(params.jobId)) {
          const active = getOrchestratorActiveChild(params.jobId);
          if (!active) {
            const details: PeekDetails = {
              found: true,
              jobId: params.jobId,
              orchestrator: { activeChild: null },
              entries: [],
            };
            return {
              content: [
                {
                  type: "text",
                  text: `orchestrator '${params.jobId}' is between rounds — no inner child running right now. dispatch_status to confirm it's still alive.`,
                },
              ],
              details,
            };
          }
          const entry = all.find((e) => e.key === active.deckKey);
          if (!entry) {
            // Active child registered but deck entry already cleared — rare
            // race between setOrchestratorActiveChild(child) and the deck
            // startEntry call. Treat as between-rounds.
            const details: PeekDetails = {
              found: true,
              jobId: params.jobId,
              orchestrator: { activeChild: null },
              entries: [],
            };
            return {
              content: [
                {
                  type: "text",
                  text: `orchestrator '${params.jobId}' is between rounds (child handoff in progress).`,
                },
              ],
              details,
            };
          }
          const childSerial = serialise(entry);
          const details: PeekDetails = {
            found: true,
            jobId: params.jobId,
            orchestrator: {
              activeChild: {
                ...childSerial,
                childStartedAt: active.startedAt,
              },
            },
            entries: [childSerial],
          };
          return {
            content: [{ type: "text", text: renderOrchestratorPeek(params.jobId, entry) }],
            details,
          };
        }
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
  /**
   * Set when the jobId resolved to an orchestrator-shaped job (e.g.
   * adversarial_loop). Surfaces the active inner child or `null` if the
   * orchestrator is between rounds. PM can read both `entries` (compat
   * shape: the active child's serialised state, if any) and this richer
   * field to distinguish orchestrator from single-dispatch results.
   */
  orchestrator?: {
    activeChild: (SerialisedEntry & { childStartedAt: number }) | null;
  };
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
  /** Wall-clock age of the child (see `peekTiming`). */
  elapsedMs: number;
  /** Time since the child's last completed turn. */
  quietMs: number;
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
    ...peekTiming(e, Date.now()),
    totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    model: e.state.model,
  };
}

function truncate(s: string, max: number): string {
  const oneLine = s.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** Past this long without a completed turn, a peek row says so outright. */
const QUIET_MS = 5 * 60_000;

/**
 * Wall-clock timing for a peek row. `state.elapsedMs` is NOT an age: it is
 * stamped when the child's last assistant turn ended (the deck state only
 * refreshes on `onProgress`), so a child hung inside one tool call peeked
 * byte-identically — same "8m36s" — for an hour and read as live. Age is
 * measured from the deck entry's start instead, and `quietMs` is the time
 * since that last completed turn.
 */
export function peekTiming(
  e: Pick<DeckEntry, "state" | "startedAt">,
  now: number,
): { elapsedMs: number; quietMs: number } {
  // Entries always carry startedAt in production; a bare state (tests) has
  // only the stamped value to offer.
  if (!Number.isFinite(e.startedAt)) return { elapsedMs: e.state.elapsedMs, quietMs: 0 };
  return {
    elapsedMs: Math.max(0, now - e.startedAt),
    quietMs: Math.max(0, now - (e.state.lastEventAt ?? e.startedAt)),
  };
}

function renderHeader(e: DeckEntry, now: number): string {
  const { state, label, key } = e;
  const parts = [`[${key}]`, label, `${state.turns} turn${state.turns === 1 ? "" : "s"}`];
  if (state.lastToolName) {
    parts.push(`last: ${state.lastToolName}`);
  }
  const { elapsedMs, quietMs } = peekTiming(e, now);
  parts.push(formatElapsed(elapsedMs));
  if (quietMs >= QUIET_MS) {
    // A tool call may legitimately run this long; a hang looks the same.
    parts.push(`no new turn for ${formatElapsed(quietMs)}`);
  }
  const u = state.usage;
  const totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} toks`);
  if (state.model) parts.push(state.model);
  if (isDriverOwnedJob(key)) parts.push(driverOwnerTag());
  return parts.join(" · ");
}

export function renderPeek(entries: DeckEntry[], now: number = Date.now()): string {
  if (entries.length === 0) return "no in-flight subagents — call dispatch_status to confirm";
  const lines: string[] = [`peek (${entries.length} in flight):`];
  for (const e of entries) {
    lines.push(`  ${renderHeader(e, now)}`);
    if (e.state.lastText) {
      lines.push(`    last said: "${truncate(e.state.lastText, LAST_TEXT_MAX)}"`);
    }
  }
  return lines.join("\n");
}

/**
 * Render-shape for an orchestrator peek with an active child. Carries the
 * orchestrator's jobId in the header so PM can tell at a glance "this came
 * from peeking an orchestrator" vs "a single dispatch".
 */
export function renderOrchestratorPeek(
  orchestratorJobId: string,
  entry: DeckEntry,
  now: number = Date.now(),
): string {
  const lines: string[] = [`peek (orchestrator '${orchestratorJobId}' → active inner child):`];
  lines.push(`  ${renderHeader(entry, now)}`);
  if (entry.state.lastText) {
    lines.push(`    last said: "${truncate(entry.state.lastText, LAST_TEXT_MAX)}"`);
  }
  return lines.join("\n");
}
