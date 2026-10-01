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
 *
 * The state is a per-spawn Set of open toolCall ids. It dies with the spawn
 * (a killed child never receives its toolResult, and a module-level map
 * would leak across children — the #772 lesson).
 */

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import type { CapSession } from "./spawn-caps.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { emptyRunningState, ingestEvent, type RunningState } from "./progress.ts";
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
  const interval = setInterval(() => {
    const budget = armedBudget();
    if (budget.ms <= 0) return; // this budget is disabled; the other is checked in its own branch
    if (Date.now() - lastActivityAt() >= budget.ms) {
      onKill(budget.cause, budget.ms, inFlightTools.toolNames());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }
  }, Math.min(30_000, Math.max(250, Math.floor(pollBudgetMs / 2))));
  interval.unref();
  return () => clearInterval(interval);
}

/**
 * #951 — the stdout line handler factory. Extracted from spawn.ts to keep
 * spawn.ts under the 500-line cap. Returns a function that processes one
 * stdout line, updating the in-flight state, running state, and activity
 * tracking.
 */
export function createStdoutLineHandler(opts: {
  start: number;
  inFlightTools: InFlightTools;
  appendStderr: (s: string) => void;
  runningState: RunningState;
  caps: CapSession;
  onProgress?: (snapshot: RunningState) => void;
  onRawEvent?: (event: PiJsonEvent) => void;
  willRetryAfter: (event: PiJsonEvent) => boolean;
  onAgentEnd: (parsed: PiJsonEvent) => void;
}) {
  const {
    start,
    inFlightTools,
    appendStderr,
    runningState,
    caps,
    onProgress,
    onRawEvent,
    willRetryAfter,
    onAgentEnd,
  } = opts;

  return (line: string, lastActivityKind: string): { kind: string; agentEnd: PiJsonEvent | null; assistantMessageEnd: PiJsonEvent | null } => {
    const trimmed = line.trim();
    if (!trimmed) return { kind: lastActivityKind, agentEnd: null, assistantMessageEnd: null };
    let kind = "unparsed stdout";
    let parsed: PiJsonEvent | null = null;
    try {
      parsed = JSON.parse(trimmed) as PiJsonEvent;
    } catch {
      appendStderr(`${trimmed}\n`);
      return { kind, agentEnd: null, assistantMessageEnd: null };
    }
    if (
      ingestEvent(
        runningState,
        parsed as Parameters<typeof ingestEvent>[1],
        start,
        caps.loopObserver,
        caps.toolResultObserver,
      )
    ) {
      caps.tokenBudgetTracker?.check(Date.now());
      caps.tokenBudgetTracker?.onMessageEnd(Date.now());
      caps.turnNudge?.(runningState.turns);
      onProgress?.({ ...runningState, usage: { ...runningState.usage } });
    }
    onRawEvent?.(parsed);
    inFlightTools.observe(parsed);
    kind = parsed.type ?? "unknown event";
    let agentEnd: PiJsonEvent | null = null;
    let assistantMessageEnd: PiJsonEvent | null = null;
    if (parsed.type === "agent_end") {
      agentEnd = parsed;
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
