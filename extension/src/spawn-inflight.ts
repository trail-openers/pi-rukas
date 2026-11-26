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
import { createInterface } from "node:readline";
import type { BudgetProgressSteer } from "./budget-progress.ts";
import { type ChildProgress, progressSilenceMs } from "./child-progress.ts";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import { type RunningState, ingestEvent, recordedDurationMs } from "./progress.ts";
import type { StallOpts } from "./request-stall-policy.ts";
import type { SkillReadGuard } from "./review-bounds.ts";
import type { CapSession } from "./spawn-caps.ts";
import { killProcessTree } from "./spawn-kill.ts";
import { inactivityTimeoutMs, toolInactivityTimeoutMs, willRetryAfter } from "./spawn-support.ts";
import { traceWarn } from "./trace.ts";

/** A span one event opens: the call's id, tool name and arguments. */
export interface SpanOpen {
  id: string;
  name: string;
  args: unknown;
}

/** The span edges of one event: the calls it opens, the call ids it closes. */
export interface SpanEdges {
  opens: SpanOpen[];
  closes: string[];
  /** The closed call's duration as Pi recorded it; absent when Pi sent none. */
  durationMs?: number;
}

const NO_EDGES: SpanEdges = { opens: [], closes: [] };

/**
 * The span edges one parsed child event carries. The single rule for what is
 * in flight, shared by `InFlightTools` and the progress tracker
 * (child-progress.ts) so the two cannot disagree about which calls run.
 */
export function spanEdges(event: PiJsonEvent): SpanEdges {
  // This open/delete covers BOTH call shapes: top-level calls, whose
  // flat events carry the same toolCallId as the toolCall block (so
  // the set/delete here is idempotent with the message-path close
  // below), and nested codemode calls (ctx.executeTool), whose
  // <callerId>/<n> ids never surface in a message. A span always
  // closes on its own tool_execution_end; an orphan dies with the
  // spawn.
  if (event.type === "tool_execution_start") {
    if (!event.toolCallId) return NO_EDGES;
    const open = { id: event.toolCallId, name: event.toolName ?? "unknown", args: event.args };
    return { opens: [open], closes: [] };
  }
  if (event.type === "tool_execution_end") return closeEdge(event.toolCallId, event.durationMs);
  const msg = event.message;
  if (!msg) return NO_EDGES;
  // A toolResult closes its span whether or not it is an error — a failed
  // tool that reported is no longer in flight. Pi stamps the same recorded
  // duration on it, so whichever close arrives first carries it.
  if (msg.role === "toolResult") return closeEdge(msg.toolCallId, msg.durationMs);
  // #1465 — only the assistant message_end opens spans. Pi's turn_end
  // re-carries the turn's assistant message AFTER its tool results, and
  // message_start / message_update carry it while it streams; opening on
  // those re-opened every completed call at turn end, so the set grew by
  // every call of every turn. An `error` / `aborted` message runs none of
  // its toolCalls (the agent loop returns before the tool batch), so its
  // blocks would never be closed either.
  if (event.type !== "message_end") return NO_EDGES;
  return assistantTurnEdges(msg);
}

function closeEdge(id: string | undefined, rawDurationMs: unknown): SpanEdges {
  if (!id) return NO_EDGES;
  const durationMs = recordedDurationMs(rawDurationMs);
  return { opens: [], closes: [id], ...(durationMs === undefined ? {} : { durationMs }) };
}

/**
 * The calls an assistant `message_end` opens — the message half of `spanEdges`,
 * split out because that function was carrying both the flat `tool_execution_*`
 * shapes and the message shapes, and `spawn.ts` has reached its size cap
 * (AGENTS.md §12). Same rule as before the split and one owner: **only** a
 * `message_end` whose role is `assistant` and whose turn was neither errored
 * nor aborted opens spans.
 */
function assistantTurnEdges(msg: NonNullable<PiJsonEvent["message"]>): SpanEdges {
  if (msg.stopReason === "error" || msg.stopReason === "aborted") return NO_EDGES;
  if (msg.role !== "assistant" || !msg.content) return NO_EDGES;
  const opens: SpanOpen[] = [];
  for (const block of msg.content) {
    if (block.type === "toolCall" && block.id) {
      opens.push({ id: block.id, name: block.name ?? "unknown", args: block.arguments });
    }
  }
  return { opens, closes: [] };
}

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
    const { opens, closes } = spanEdges(event);
    // Set semantics: re-observing an id (a retried turn re-emitting
    // the same block) does not change the state.
    for (const o of opens) this.open.set(o.id, o.name);
    for (const id of closes) this.open.delete(id);
  }
}

/**
 * Stdout lines that are the child's rpc layer answering OUR stdin write, not
 * the agent doing anything: Pi acks every command with a `response` line and
 * reports the queued steer with `queue_update`, and it does both while the
 * agent is stuck inside a tool call. Counted as life, they let every steer
 * re-arm the watchdog: a review child hung in one bash call was steered by
 * the slow-run watch at 20 / 40 / 80 min (and by the PM in between), so the
 * 60-min tool-inactivity bound could first be met at 140 min.
 */
export function isStdinEcho(kind: string): boolean {
  return kind === "response" || kind === "queue_update";
}

/** The cause the poll's own budgets name; `stall` is the caller's lever, fired on the same tick. */
export type PollKillCause = "inactivity" | "tool-inactivity" | "no-progress" | "stall";

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
 *
 * The same tick carries the opt-in no-progress arm (`ChildProgress.stall`,
 * PI_ENSEMBLE_PROGRESS_SILENCE_MS): a child that still emits lines but makes
 * no progress. Silence is checked first, so a silent child keeps its silence
 * cause; with the knob unset the arm never fires and the poll is unchanged.
 *
 * #2644 — the same tick is ALSO the only place the caller's hung-request lever can be read: a
 * request that hangs emits no line at all, so a check on the stream's own cadence is a check that
 * never runs on exactly the shape the lever exists for. `stall` is the step's armed window and the
 * caller's `check` (the abort); the poll fires it on a timer tick, after its own budgets, so a
 * silence the poll itself ends keeps its own cause.
 */
export interface InactivityPoll {
  /** Stop the timer. */
  stop: () => void;
  /** One supervision pass, the body the timer runs. */
  tick: () => void;
}

export function createInactivityPoll(opts: {
  /** Headless S4 (#1024): the child leads its own process group (spawn-kill.ts). */
  child: ChildProcess;
  inFlightTools: InFlightTools;
  lastActivityAt: () => number;
  childProgress: ChildProgress;
  onKill: (cause: PollKillCause, budgetMs: number, toolNames: string[]) => void;
  /** #2644 — the caller's hung-request lever: the enforced window in ms, the reader of THIS
   *  child's stream, and the hook that aborts the child. Absent means no stall arm, which is
   *  every caller that bounds its child some other way. */
  stall?: StallOpts;
  /** The two silence budgets, in the shape the operator's knobs arrive in. The spawn passes none and
   *  gets `PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS` / `PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS`; a case that
   *  supervises a child the lever alone must end says so here, so the poll cannot reach a cause it
   *  was never asked to own. Read per tick, because the knobs are read at CALL time everywhere in
   *  this stack. */
  budgets?: () => { inactivityMs: number; toolInactivityMs: number };
}): InactivityPoll {
  const { child, inFlightTools, lastActivityAt, childProgress, onKill, stall } = opts;
  const budgets =
    opts.budgets ??
    (() => ({
      inactivityMs: inactivityTimeoutMs(),
      toolInactivityMs: toolInactivityTimeoutMs(),
    }));
  const armedBudget = () => {
    const { inactivityMs, toolInactivityMs } = budgets();
    return inFlightTools.active
      ? { ms: toolInactivityMs, cause: "tool-inactivity" as const }
      : { ms: inactivityMs, cause: "inactivity" as const };
  };
  /** The tick cadence: half the tightest bound that can end this child, floored so a case with a
   *  one-minute budget still ticks, and capped so a child with only a wide lever is still watched. */
  const pollBudgetMs = () =>
    Math.min(
      (() => {
        const b = budgets();
        return b.inactivityMs > 0 ? b.inactivityMs : Number.POSITIVE_INFINITY;
      })(),
      (() => {
        const b = budgets();
        return b.toolInactivityMs > 0 ? b.toolInactivityMs : Number.POSITIVE_INFINITY;
      })(),
      progressSilenceMs(false) || Number.POSITIVE_INFINITY,
      stall !== undefined && stall.windowMs > 0 ? stall.windowMs : Number.POSITIVE_INFINITY,
    );
  const period = pollBudgetMs();
  if (period === Number.POSITIVE_INFINITY) return { stop: () => undefined, tick: () => undefined };
  /** One supervision pass: the poll's own budgets first, then the caller's lever. The timer below
   *  is the production driver; it is also the seam a case calls when a host's timer cadence cannot
   *  be relied on to land a verdict inside the case's wait. */
  const tick = (): void => {
    const armed = armedBudget();
    const now = Date.now();
    // A disabled budget (ms <= 0) never fires; the other is checked in its own branch.
    const budget =
      armed.ms > 0 && now - lastActivityAt() >= armed.ms
        ? armed
        : childProgress.stall(now, inFlightTools.active);
    if (budget) {
      onKill(budget.cause, budget.ms, inFlightTools.toolNames());
      // #1510 — this runs on its OWN setInterval, so a throw here is an
      // uncaught exception at timer level: it aborts the parent and takes
      // down every sibling child still in flight, exactly the shape the
      // budget kill guards. `onKill` has already recorded the cause, so the
      // kill is attributed even when the signal cannot land — the failure is
      // reported at default log level, never swallowed.
      try {
        killProcessTree(child);
      } catch (err) {
        traceWarn(`inactivity killProcessTree failed: ${String(err)}`);
      }
      return;
    }
    // #2644 — the caller's hung-request lever, on this tick and nowhere else: a hung request
    // emits nothing, so nothing else ticks. A tool in flight is a running bash — work, not
    // silence — and is never a stall (#951). The caller owns the abort, so the poll contributes
    // only the reading and the cadence.
    if (stall !== undefined && !inFlightTools.active) {
      const quiet = stall.silence();
      // The caller's abort is one-shot, so the arm stands itself down after it fires: the poll
      // has no reason to keep reading a stream whose child is already being ended. The kill is
      // the poll's own — same guarded path as its silence budgets — and the cause is NAMED, so
      // the report says a stalled request ended this child rather than leaving it unattributed.
      if (quiet.sinceMs >= stall.windowMs) {
        clearInterval(interval);
        stall.check?.();
        onKill("stall", stall.windowMs, inFlightTools.toolNames());
        try {
          killProcessTree(child);
        } catch (err) {
          traceWarn(`stall killProcessTree failed: ${String(err)}`);
        }
      }
    }
  };
  const interval = setInterval(tick, Math.min(30_000, Math.max(250, Math.floor(period / 2))));
  interval.unref();
  return { stop: () => clearInterval(interval), tick };
}

export function stallLever(
  opts: SpawnOptions,
  childProgress: ChildProgress,
  inFlightTools: InFlightTools,
  runningState: RunningState,
): SpawnOptions["stall"] {
  if (opts.stall === undefined) return undefined;
  const windowMs = opts.stall.windowMs ?? opts.stall.windowMinutes * 60_000;
  return {
    windowMinutes: opts.stall.windowMinutes,
    // The enforced threshold rides through the spawn so the poll measures the same window the
    // step froze; a caller that forwards only the whole minutes (`runLensChild`, the adversarial
    // phase) gets those minutes as the threshold, which is the coarser of the two.
    windowMs,
    silence: () => ({
      sinceMs: Date.now() - childProgress.lastProgressAt,
      toolInFlight: inFlightTools.active,
    }),
    check: () => opts.onProgress?.({ ...runningState, usage: { ...runningState.usage } }),
  };
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
  /** #1567 — the per-spawn progress tracker (child-progress.ts). */
  childProgress: ChildProgress;
  appendStderr: (s: string) => void;
  runningState: RunningState;
  /** The #543 F1/F6 cap session; owns the per-spawn observers and caps. */
  caps: CapSession;
  /**
   * #1991 — the budget-progress steer (budget-progress.ts), driven on the same
   * per-assistant-turn seam as `turnNudge`: the only place the spawn's turn
   * count and the child's own clock are both current. Inert and cheap for a
   * child with no bound armed, so the call site stays unconditional.
   */
  budgetProgress: BudgetProgressSteer;
  onProgress?: (snapshot: RunningState) => void;
  onRawEvent?: (event: PiJsonEvent) => void;
  onAgentEnd: (parsed: PiJsonEvent) => void;
  /** Every `agent_settled`, for the child bound's cancel-vs-done bit. */
  onAgentSettled?: (parsed: PiJsonEvent) => void;
  /**
   * #1827 — the reviewer skill re-read guard, fed from the same hot path as the
   * cap observers. Absent (every non-reviewer role, or no driver-supplied skill
   * path) means the guard observes nothing and can neither steer nor kill.
   */
  skillRead?: SkillReadGuard;
}): (line: string) => {
  kind: string;
  agentEnd: PiJsonEvent | null;
  assistantMessageEnd: PiJsonEvent | null;
} {
  const {
    start,
    inFlightTools,
    childProgress,
    appendStderr,
    runningState,
    caps,
    budgetProgress,
    onProgress,
    onRawEvent,
    onAgentEnd,
    onAgentSettled,
    skillRead,
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
      // #543 F6 — check the token budget on every assistant turn end. There is
      // deliberately NO onMessageEnd() call here: the budget's grace window is
      // absolute from the trigger, because new turns ARE the violation (each
      // one costs tokens). Resetting it per turn made the kill unreachable for
      // exactly the chatty child the cap exists to stop.
      caps.tokenBudgetTracker?.check(Date.now());
      // #1991 — the two advisories on this seam are mutually exclusive by
      // construction: the nudge stands down when a bound is armed (inside
      // `turnNudge`), and the progress steer is inert when none is.
      caps.turnNudge?.(runningState.turns);
      budgetProgress.onAssistantTurn(runningState.turns, Date.now());
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
    // #1567 — record progress (child-progress.ts); the poll's no-progress arm reads it.
    childProgress.observe(parsed);
    // #1827 — count this child's reads of its OWN skill file. Observation only
    // here: the caller decides when the count becomes a steer and when it
    // becomes a kill, because only the caller holds the stdin handle, the steer
    // seam and the kill path.
    skillRead?.observe(parsed);
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
    } else if (parsed.type === "agent_settled") {
      onAgentSettled?.(parsed);
    } else if (
      parsed.type === "message_end" &&
      (parsed as { message?: { role?: string } }).message?.role === "assistant"
    ) {
      assistantMessageEnd = parsed;
    }
    return { kind, agentEnd, assistantMessageEnd };
  };
}

/**
 * #1827 — the stdout line pump for one child, moved out of `spawn.ts` for the
 * §12 size cap (spawn.ts sits at the limit and the reviewer bounds had to add
 * lines somewhere).
 *
 * The body is the same one spawn ran: count the line, run it through
 * `createStdoutLineHandler`, ignore our own steered-stdin echo, and record what
 * the handler saw. The one addition is the reviewer-bounds hook, and it is
 * wrapped in a try/catch that spawn did not have: this is the hot path of a
 * live child, so a bound that throws must not take the handler — and with it
 * the child's entire event stream, activity tracking and every watchdog that
 * reads it — down. A broken cap becomes a traced line and a child that its
 * ordinary timeouts still end.
 */
export function attachStdoutLinePump(opts: {
  child: ChildProcess;
  handler: (line: string) => {
    kind: string;
    agentEnd: PiJsonEvent | null;
    assistantMessageEnd: PiJsonEvent | null;
  };
  /** Called with every non-echo line's outcome; must not throw (it is ours). */
  onLine: (res: {
    kind: string;
    agentEnd: PiJsonEvent | null;
    assistantMessageEnd: PiJsonEvent | null;
  }) => void;
}): {
  lines: () => number;
  /** The instant the last non-echo line arrived — the inactivity poll's clock. */
  lastActivityAt: () => number;
  /**
   * The SHAPE of the silence, so a kill can be attributed rather than merely
   * tuned: `linesSeen: 0` is a provider stall or auth failure, not a hang.
   * Full reasoning in test-kill-attribution.ts.
   */
  lastActivityKind: () => string;
  /**
   * #951 — the one seam that lets a tool-inactivity kill name the tools it found
   * in flight. The pump owns the shape (it is the only writer from the stream),
   * so the poll's kill and the stream's last line can never disagree about which
   * silence the report names.
   */
  setActivityKind: (kind: string) => void;
  close: () => void;
} {
  let lines = 0;
  let lastActivityAt = Date.now();
  let lastActivityKind = "nothing yet";
  // `child.stdout` is null before the stdio pipes are up; the readline options
  // require a stream, so a child without one simply never pumps (the same
  // shape spawn relied on when it passed the handle directly).
  const rl = createInterface({ input: opts.child.stdout as NodeJS.ReadableStream });
  // #1827 round 2 — `close` is called from the spawn's `finally`. It is not
  // strictly required: readline listens on its INPUT stream, so the child's
  // exit closes stdout and releases the interface with its `line` listener —
  // which is why the pump worked without it. It is called anyway because a
  // child that lingers after `exit` (a grandchild holding the pipe) otherwise
  // keeps the interface and its listener alive past the spawn that made them.
  rl.on("line", (line) => {
    lines += 1;
    const res = opts.handler(line);
    // Our own steer acked back — not life, and not a bound's business.
    if (isStdinEcho(res.kind)) return;
    // The clock resets on any line the child itself produced, parseable or not —
    // which is what makes the watchdog a SILENCE detector rather than a parser.
    lastActivityAt = Date.now();
    if (res.kind) lastActivityKind = res.kind;
    try {
      opts.onLine(res);
    } catch (err) {
      // The one caller of this pump feeds the reviewer bounds. A bound that
      // throws is a broken cap, not a broken child: the stream keeps flowing,
      // the watchdogs keep their notion of life, and the trace names the fault.
      traceWarn(`stdout pump: observer failed: ${String(err)}`);
    }
  });
  return {
    lines: () => lines,
    lastActivityAt: () => lastActivityAt,
    lastActivityKind: () => lastActivityKind,
    setActivityKind: (kind: string) => {
      lastActivityKind = kind;
    },
    close: () => rl.close(),
  };
}
