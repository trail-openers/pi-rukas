/**
 * child-progress — the per-spawn progress tracker of the child-supervision
 * policy (#1567, piece P1).
 *
 * The watchdogs used to read "any stdout line" as life, and the in-flight
 * set as "a tool is working". Neither says whether the child is getting
 * anywhere: a child hung in one bash call and a child running a long suite
 * look the same, and a child repeating one turn emits plenty of lines. The
 * policy defines progress once, and this module records it:
 *
 *   - a tool result (`toolResult` message) or a `tool_execution_end`;
 *   - a `report_finding` call;
 *   - a live call emitting a `tool_execution_update` with new bytes;
 *   - a turn whose last text or last tool call differs from the previous
 *     turn's;
 *   - a HEAD or dirty-tree change, which the driver samples and reports
 *     through `recordWorkspaceChange` (no git is run here).
 *
 * Not progress: token growth alone, stdin echoes (`isStdinEcho`), steers
 * (user messages), the start of a call, and a turn identical to the previous
 * one. An `error` / `aborted` assistant message is not a turn of work either.
 *
 * Which calls are in flight comes from `spanEdges` (spawn-inflight.ts), the
 * same rule the inactivity watchdog uses. The tracker adds what the call
 * budget needs: each live call's start time, command fingerprint and last
 * update, and the longest completed call per fingerprint (the budget is
 * max(20 min, 3 × the longest same-command call)).
 *
 * Observation only: nothing here kills, steers or notifies. One instance per
 * spawn, fed from the stdout line handler; it dies with the spawn.
 */

import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { isStdinEcho, spanEdges } from "./spawn-inflight.ts";

/** The finding-report tool (lens children); calling it is progress. */
const REPORT_FINDING_TOOL = "report_finding";

/** One call still in flight. */
export interface InFlightCall {
  toolCallId: string;
  toolName: string;
  /** `commandFingerprint` of the call; equal fingerprints are the same command. */
  fingerprint: string;
  /** The call's arguments as the child sent them (a bash call's `timeout` lives here). */
  args: unknown;
  startedAt: number;
  /** When the call last emitted an update with new bytes; `startedAt` until then. */
  lastUpdateAt: number;
}

/**
 * The command identity of a call: tool name plus canonical, whitespace-
 * collapsed arguments. Paths are kept verbatim (unlike the loop detector's
 * per-spawn path tokens), so fingerprints compare across spawns in a cycle.
 */
export function commandFingerprint(toolName: string, args: unknown): string {
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  let raw: string;
  if (args == null) raw = "";
  else if (typeof args === "string") raw = collapse(args);
  else {
    try {
      // Collapse inside string values, before JSON escapes a newline away.
      raw = JSON.stringify(args, (_k, v) => (typeof v === "string" ? collapse(v) : v)) ?? "";
    } catch {
      raw = String(args);
    }
  }
  return `${toolName} ${raw}`.trim();
}

interface OpenCall extends InFlightCall {
  /** The last update payload seen, to tell new bytes from a repeat. */
  lastPayload: string | undefined;
  /** #1465 — the call budget killed it; its duration is not a run of the command. */
  killed?: boolean;
}

export class ChildProgress {
  private readonly now: () => number;
  private progressAt: number;
  private readonly calls = new Map<string, OpenCall>();
  private readonly longest = new Map<string, number>();
  private lastTurn: string | undefined;

  /** `now` is injectable for tests; the start of the spawn counts as progress. */
  constructor(now: () => number = Date.now) {
    this.now = now;
    this.progressAt = now();
  }

  /** When the child last made progress (spawn start until it first does). */
  get lastProgressAt(): number {
    return this.progressAt;
  }

  /** The calls still in flight, oldest first. */
  inFlightCalls(): InFlightCall[] {
    return [...this.calls.values()].map(({ lastPayload: _, ...call }) => call);
  }

  /** The longest completed call with this fingerprint, in ms; undefined if none completed. */
  longestCompletedMs(fingerprint: string): number | undefined {
    return this.longest.get(fingerprint);
  }

  /** Every fingerprint's longest completed call, in ms. */
  longestCompleted(): ReadonlyMap<string, number> {
    return this.longest;
  }

  /** #1465 — the call budget killed this call: do not record its duration as a run. */
  markKilled(toolCallId: string): void {
    const call = this.calls.get(toolCallId);
    if (call) call.killed = true;
  }

  /** The driver saw HEAD move or the dirty tree change. */
  recordWorkspaceChange(): void {
    this.mark();
  }

  /** Process one parsed child event. */
  observe(event: PiJsonEvent): void {
    if (isStdinEcho(event.type ?? "")) return;
    const t = this.now();
    if (event.type === "tool_execution_update") {
      this.observeUpdate(event, t);
      return;
    }
    const { opens, closes } = spanEdges(event);
    for (const o of opens) {
      if (o.name === REPORT_FINDING_TOOL) this.mark();
      const open = this.calls.get(o.id);
      if (open) {
        // #1465 — the call opened at its assistant message_end; it STARTS when
        // Pi executes it, which can be later (a sequential batch, a hook).
        if (event.type === "tool_execution_start") open.startedAt = open.lastUpdateAt = t;
        continue;
      }
      const fingerprint = commandFingerprint(o.name, o.args);
      this.calls.set(o.id, {
        toolCallId: o.id,
        toolName: o.name,
        fingerprint,
        args: o.args,
        startedAt: t,
        lastUpdateAt: t,
        lastPayload: undefined,
      });
    }
    for (const id of closes) {
      // A result is progress even for a call opened before tracking began.
      this.mark();
      const call = this.calls.get(id);
      if (!call) continue;
      this.calls.delete(id);
      if (call.killed) continue;
      const ms = t - call.startedAt;
      if (ms > (this.longest.get(call.fingerprint) ?? -1)) this.longest.set(call.fingerprint, ms);
    }
    this.observeTurn(event);
  }

  private observeUpdate(event: PiJsonEvent, t: number): void {
    const call = event.toolCallId ? this.calls.get(event.toolCallId) : undefined;
    if (!call) return;
    let payload: string;
    try {
      payload = JSON.stringify(event.partialResult) ?? "";
    } catch {
      return;
    }
    if (payload === "" || payload === call.lastPayload) return;
    call.lastPayload = payload;
    call.lastUpdateAt = t;
    this.mark();
  }

  /** A turn is progress when its last text or last tool call is new. */
  private observeTurn(event: PiJsonEvent): void {
    const msg = event.message;
    if (event.type !== "message_end" || msg?.role !== "assistant") return;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
    let lastText: string | undefined;
    let lastTool: string | undefined;
    for (const block of msg.content ?? []) {
      if (block.type === "text" && block.text?.trim()) lastText = block.text.trim();
      if (block.type === "toolCall")
        lastTool = commandFingerprint(block.name ?? "", block.arguments);
    }
    const turn = JSON.stringify([lastText ?? null, lastTool ?? null]);
    if (turn === this.lastTurn) return;
    this.lastTurn = turn;
    this.mark();
  }

  private mark(): void {
    this.progressAt = this.now();
  }
}
