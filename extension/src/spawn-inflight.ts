/**
 * spawn-inflight — #951 in-flight tool-call tracking for the inactivity
 * watchdog.
 *
 * The #296 watchdog treats ANY stdout line as life, so a child whose last
 * event is a toolCall whose toolResult never arrives — a silent in-flight
 * bash (a full offline gate, a CI watch) — reads as a hang and is killed,
 * losing work in progress. Pi's JSONL has no tool_execution_start/end, so
 * the in-flight window is derived from the event shapes themselves: a
 * `toolCall` content block inside an assistant `message_end` OPENS a span,
 * and a `toolResult` message carrying the matching `toolCallId` CLOSES it
 * (whether or not the result is an error — an erroring tool is still a
 * result). Multiple concurrent toolCall blocks in one assistant turn are
 * each tracked, so one toolResult never closes a sibling's span (a boolean
 * would — exactly the early-fire shape #772's #543 notes warned about).
 * Top-level calls are still derived from message shapes; nested codemode
 * calls carry their own tool_execution_start/end events (#1032).
 *
 * The state is a per-spawn Set of open toolCall ids. It dies with the spawn
 * (a killed child never receives its toolResult, and a module-level map
 * would leak across children — the #772 lesson).
 */

import type { ChildProcess } from "node:child_process";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { type RunningState, ingestEvent } from "./progress.ts";
import type { CapSession } from "./spawn-caps.ts";
import { inactivityTimeoutMs, toolInactivityTimeoutMs, willRetryAfter } from "./spawn-support.ts";

/** The per-spawn set of open toolCall ids. A toolCall block opens one; the
 * matching toolResult closes it. */
export class InFlightTools {
  private readonly open = new Map<string, string>();

  get size(): number {
    return this.open.size;
  }

  /** True when any toolCall has not yet received its toolResult. */
  get active(): boolean {
    return this.open.size > 0;
  }

  /** The tool names still open, for the kill report. */
  toolNames(): string[] {
    return [...this.open.values()];
  }

  /** Process one parsed child event against the in-flight state. */
  observe(event: PiJsonEvent): void {
    // Nested tool calls (codemode scripts via ctx.executeTool) emit flat
    // tool_execution_start / tool_execution_end events with their own
    // toolCallId ("<callerId>/<n>") and a parentToolCallId. They are not
    // message-bearing, so they are handled before the `msg` check below.
    // A nested span opens on tool_execution_start and closes on
    // tool_execution_end — the same open/close contract as top-level
    // toolCall/toolResult pairs. A nested span always closes on its own
    // tool_execution_end (Pi emits it in a finally, before the parent
    // toolResult); a span orphaned by a dying child dies with the spawn.
    if (event.type === "tool_execution_start") {
      if (event.toolCallId) this.open.set(event.toolCallId, event.toolName ?? "unknown");
      return;
    }
    if (event.type === "tool_execution_end") {
      if (event.toolCallId) this.open.delete(event.toolCallId);
      return;
    }
    const msg = event.message;
    if (!msg) return;
    if (msg.role === "toolResult") {
      // A toolResult closes its span whether or not it is an error — a
      // failed tool that reported is no longer in flight.
      if (msg.toolCallId) this.open.delete(msg.toolCallId);
      return;
    }
    if (msg.role === "assistant" && msg.content) {
      for (const block of msg.content) {
        if (block.type === "toolCall" && block.id) {
          // Set semantics: re-observing an id (a retried turn re-emitting
          // the same block) does not change the state.
          this.open.set(block.id, block.name ?? "unknown");
        }
      }
    }
  }
}

/**
 * #951 — the dual-budget inactivity watchdog. ONE poll, two budgets: while
 * the in-flight set (above) is non-empty the silence belongs to a running
 * tool, so the TOOL-inactivity bound applies (a long bash — the full offline
 * gate, a CI watch — is the NORMAL shape); when the set is empty the
 * model-silence bound applies (a stalled provider turn). Exactly one budget
 * is armed at any poll, so there is no both-expired race.
 *
 * The poll period takes the smaller positive budget (a tighter budget is
 * the tighter poll) so a test-shortened tool budget still fires promptly;
 * production clamps both to 30s. `toolInactivityKilled` / `inactivityKilled`
 * are exclusive by construction.
 */
export function createInactivityPoll(opts: {
  child: ChildProcess;
  inFlightTools: InFlightTools;
  lastActivityAt: () => number;
  onKill: (cause: "inactivity" | "tool-inactivity", budgetMs: number, toolNames: string[]) => void;
}): () => void {
  const { child, inFlightTools, lastActivityAt, onKill } = opts;
  const inactivityMs = inactivityTimeoutMs();
  const toolInactivityMs = toolInactivityTimeoutMs();
  const armedBudget = () =>
    inFlightTools.active
      ? { ms: toolInactivityMs, cause: "tool-inactivity" as const }
      : { ms: inactivityMs, cause: "inactivity" as const };
  const pollBudgetMs = Math.min(
    inactivityMs > 0 ? inactivityMs : Number.POSITIVE_INFINITY,
    toolInactivityMs > 0 ? toolInactivityMs : Number.POSITIVE_INFINITY,
  );
  if (pollBudgetMs === Number.POSITIVE_INFINITY) return () => undefined;
  const interval = setInterval(
    () => {
      const budget = armedBudget();
      if (budget.ms <= 0) return; // this budget is disabled; the other is checked in its own branch
      if (Date.now() - lastActivityAt() >= budget.ms) {
        onKill(budget.cause, budget.ms, inFlightTools.toolNames());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }
    },
    Math.min(30_000, Math.max(250, Math.floor(pollBudgetMs / 2))),
  );
  interval.unref();
  return () => clearInterval(interval);
}

/**
 * The stdout line handler, moved verbatim from spawn.ts (AGENTS.md §12
 * file-size limit; the comment-retention gate #948 enforces verbatim
 * moves). Processes one stdout line: resets activity tracking, parses the
 * JSONL event, streams into the running state, and advances the in-flight
 * tool state.
 */
export function createStdoutLineHandler(opts: {
  start: number;
  inFlightTools: InFlightTools;
  appendStderr: (s: string) => void;
  runningState: RunningState;
  caps: CapSession;
  onProgress?: (snapshot: RunningState) => void;
  onRawEvent?: (event: PiJsonEvent) => void;
  onAgentEnd: (parsed: PiJsonEvent) => void;
}): (line: string) => {
  kind: string;
  agentEnd: PiJsonEvent | null;
  assistantMessageEnd: PiJsonEvent | null;
} {
  const {
    start,
    inFlightTools,
    appendStderr,
    runningState,
    caps,
    onProgress,
    onRawEvent,
    onAgentEnd,
  } = opts;
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return { kind: "", agentEnd: null, assistantMessageEnd: null };
    let kind = "unparsed stdout";
    let parsed: PiJsonEvent | null = null;
    try {
      parsed = JSON.parse(trimmed) as PiJsonEvent;
    } catch {
      appendStderr(`${trimmed}\n`);
      return { kind, agentEnd: null, assistantMessageEnd: null };
    }
    // Stream into the running state. ingestEvent returns true only when an
    // assistant turn completed (the right cadence to surface to the user).
    // #543 F1 — pass the full block list to the loop detector (ops-role
    // children are exempt: the cap session returns no observer for them).
    // #772 — the 5th argument feeds the success-keyed counter with the
    // toolResult events the streak observer never sees. Without it the
    // counter's only input is invisible in production: the session eagerly
    // builds the observer, but nothing routes the event stream to it
    // (the "second detector that silently does not fire" class — exactly
    // what the ticket's gap gate condemned).
    if (
      ingestEvent(
        runningState,
        parsed as Parameters<typeof ingestEvent>[1],
        start,
        caps.loopObserver,
        caps.toolResultObserver,
      )
    ) {
      // #543 F6 — check the token budget on every assistant turn end.
      caps.tokenBudgetTracker?.check(Date.now());
      caps.tokenBudgetTracker?.onMessageEnd(Date.now());
      caps.turnNudge?.(runningState.turns);
      onProgress?.({ ...runningState, usage: { ...runningState.usage } });
    }
    // #839 — raw-event observer for the dispatch deck's live view. Fires
    // for EVERY parsed child event; the observer (dispatch-deck-live.ts)
    // keeps only assistant message_end blocks and toolResult messages.
    onRawEvent?.(parsed);
    // #951 — advance the in-flight tool state (toolCall opens, toolResult
    // closes). Runs on the SAME hot path where lastActivityAt resets, so the
    // watchdog's poll below sees the current set at every tick.
    inFlightTools.observe(parsed);
    // Retain only the two events collapseEvents actually reads (the latest
    // agent_end + the latest assistant message_end as fallback). Everything
    // else is already absorbed by ingestEvent into runningState above, and
    // dropping the rest keeps per-spawn memory bounded.
    kind = parsed.type ?? "unknown event";
    let agentEnd: PiJsonEvent | null = null;
    let assistantMessageEnd: PiJsonEvent | null = null;
    if (parsed.type === "agent_end") {
      agentEnd = parsed;
      // Not while the child is retrying — see `willRetryAfter`.
      if (!willRetryAfter(parsed)) onAgentEnd(parsed);
    } else if (
      parsed.type === "message_end" &&
      (parsed as { message?: { role?: string } }).message?.role === "assistant"
    ) {
      assistantMessageEnd = parsed;
    }
    return { kind, agentEnd, assistantMessageEnd };
  };
}
