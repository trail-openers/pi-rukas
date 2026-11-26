#!/usr/bin/env bun
/**
 * #2644 AC1 — the hung-request lever fires on a TIMER, not on a child line.
 *
 * The acceptance criterion is a request that emits NOTHING: "a model request with no stream
 * activity for N minutes is aborted and the step ends as a named stall outcome with a stable
 * reason; the run does not hang." A check that runs only when the child emits an assistant turn
 * can never fire on that shape — a silent request ticks nothing — and a fixture that reproduces
 * the pump's own arithmetic in the test pins the arithmetic, not the mechanism.
 *
 * Every case below drives the REAL objects the spawn builds: `createInactivityPoll` (the timer),
 * `createStdoutLineHandler` + `attachStdoutLinePump` (the stream), `InFlightTools` and
 * `ChildProgress` (the two readings). The only fakes are the child process, the clock and the
 * event source. Nothing here re-implements a decision: the assertions read what the poll called,
 * never a copy of the poll's rule.
 */

import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import { emptyRunningState } from "../src/progress.ts";
import { ChildProgress } from "../src/child-progress.ts";
import { createInactivityPoll, stallLever } from "../src/spawn-inactivity-poll.ts";
import { InFlightTools, attachStdoutLinePump, createStdoutLineHandler } from "../src/spawn-inflight.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

/** The budget env every case runs under: everything long except what the case arms. */
const BUDGET_ENV = {
  PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: "1800000",
  PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS: "3600000",
  PI_ENSEMBLE_PROGRESS_SILENCE_MS: undefined,
};

const env = process.env as Record<string, string | undefined>;

async function withEnv(overrides: Record<string, string | undefined>, body: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

/**
 * The child the poll supervises. `diesOnce` models a real process: the first kill ends it and
 * every later signal is a no-op, so a case that counts kills counts the supervision stack's
 * decision rather than how many paths reached a fake that always answers.
 */
function fakeChild(
  input?: Readable,
  diesOnce = true,
): { child: ChildProcess; kills: () => number } {
  let kills = 0;
  let dead = false;
  const child = {
    kill: () => {
      if (diesOnce && dead) return false;
      dead = true;
      kills++;
      return true;
    },
    ...(input === undefined ? {} : { stdout: input as unknown as NodeJS.ReadableStream }),
    on: () => undefined,
  } as unknown as ChildProcess;
  return { child, kills: () => kills };
}

const LINE = 250;
const WINDOW = 1200;

/** One assistant turn that opens `n` tool calls; no result follows them. */
function turnWithToolCalls(n: number): PiJsonEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: Array.from({ length: n }, (_, i) => ({
        type: "toolCall",
        id: `tc-${String(i)}`,
        name: "bash",
        arguments: { command: `sleep ${String(i)}` },
      })),
    },
  } as PiJsonEvent;
}

/** One assistant turn with no tool call — a line that is life without work in flight. Each call
 * says something NEW: the tracker counts a turn that repeats the previous one as nothing, so a
 * case that wants three pieces of progress needs three distinct turns. */
let turnSeq = 0;
function plainTurn(): PiJsonEvent {
  turnSeq++;
  return {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "endTurn",
      content: [{ type: "text", text: `ok ${String(turnSeq)}` }],
    },
  } as PiJsonEvent;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One case: the poll, the stream and the arm, all the objects `spawn.ts` builds, over a fake
 * clock the case advances and a fake stream the case feeds.
 */
async function drive(opts: {
  windowMs: number;
  /** Seconds of simulated silence before the case stops waiting. */
  silenceMs: number;
  /** Events the child emits, spread evenly across the silence window. */
  events?: PiJsonEvent[];
  /** Called on each emitted event so a case can advance the clock between them. */
  onEmit?: (i: number) => void;
  /** Advance the clock once the stream has gone quiet, before the final wait. */
  afterEmitMs?: number;
  /** Wait between the lines, so each turn is stamped at its own real instant. The poll measures
   *  silence on `Date.now()`, and a batch delivered inside one tick leaves the child measured
   *  from its spawn start however many lines the case pushed. */
  betweenEventsMs?: number;
  /** Let the child die exactly once, as a real one does: whichever path ends it first wins, and
   *  the other kill is a no-op on a dead process. Without this the two paths double-count, and
   *  the tally measures the fake child rather than the supervision stack. */
  diesOnce?: boolean;
}): Promise<{ checks: number; kills: number; budgetMs: number; progress: number; inFlight: InFlightTools }> {
  const inFlightTools = new InFlightTools();
  // The case's simulated clock, stated as an offset from the real instant the child started:
  // `ChildProgress` and the poll both stamp with `Date.now()`, and a clock that starts at 0 would
  // read as decades of silence against the poll's budgets.
  const t0 = Date.now();
  let now = t0;
  const childProgress = new ChildProgress(() => now);
  let checks = 0;
  let budgetMs = 0;
  let progress = 0;
  const armed = {
    windowMinutes: opts.windowMs / 60_000,
    windowMs: opts.windowMs,
    silence: () => ({
      sinceMs: now - childProgress.lastProgressAt,
      toolInFlight: inFlightTools.active,
    }),
    // The caller's progress hook — `armBudget`'s hook is what aborts, and the poll calls THIS.
    // Counted as fired-or-not, not as a tally: the caller's abort is one-shot, and the poll ticks
    // several times inside a case's wait, so a count would assert on the harness's timing.
    // It ends the child too, because in production this hook IS the abort (`armBudget`'s
    // `controller.abort()`, which `attachAbortKill` turns into a kill).
    check: () => {
      if (checks === 1) return; // the caller's abort is one-shot
      checks = 1;
      void (child as { kill?: () => boolean }).kill?.();
    },
  };
  const runningState = emptyRunningState("developer");
  const handler = createStdoutLineHandler({
    start: now,
    inFlightTools,
    childProgress,
    appendStderr: () => undefined,
    runningState,
    caps: {},
    budgetProgress: { onAssistantTurn: () => undefined },
    onProgress: () => {
      progress++;
    },
    onAgentEnd: () => undefined,
  });
  const input = new Readable({ read() {} });
  const { child, kills } = fakeChild(input, opts.diesOnce !== false);
  const pump = attachStdoutLinePump({ child, handler, onLine: () => undefined });
  const events = opts.events ?? [];
  const stepMs = events.length > 0 ? Math.floor(opts.silenceMs / (events.length + 1)) : 0;
  const emit = async (): Promise<void> => {
    for (let i = 0; i < events.length; i++) {
      opts.onEmit?.(i);
      input.push(`${JSON.stringify(events[i])}\n`);
      // The pump reads synchronously on push; the clock moves after each line.
      now += stepMs;
      if (opts.betweenEventsMs !== undefined) await wait(opts.betweenEventsMs);
    }
    opts.onEmit?.(events.length);
  };
  const poll = createInactivityPoll({
    child,
    inFlightTools,
    // The pump stamps this clock with `Date.now()` on the child's own lines, so the case states
    // its silence on the same clock: the child's last line was `sinceMs` of simulated time ago.
    // A fixture clock that is not an offset of the real one reads as decades of silence, and the
    // poll's own budgets fire on the first tick — the wrong cause for the wrong reason.
    lastActivityAt: () => Date.now() - (now - childProgress.lastProgressAt),
    childProgress,
    onKill: (_cause, ms) => {
      budgetMs = ms;
    },
    stall: armed,
  });
  await emit();
  if (opts.afterEmitMs !== undefined) now += opts.afterEmitMs;
  await wait(4 * LINE + 100);
  poll.stop();
  pump.close();
  input.destroy();
  return { checks, kills: kills(), budgetMs, progress, inFlight: inFlightTools };
}

const WINDOW_ENV = { ...BUDGET_ENV, PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: String(LINE * 10) };

// ── (1) THE FIELD SHAPE: a request that emits NOTHING is ended by the timer.
{
  let r: Awaited<ReturnType<typeof drive>> | undefined;
  await withEnv(WINDOW_ENV, async () => {
    r = await drive({ windowMs: WINDOW, silenceMs: 0, afterEmitMs: WINDOW });
  });
  assert(r!.checks === 1, `(1) a silent child's stall lever fired on the timer (got ${String(r!.checks)} checks)`);
  assert(r!.kills === 1, `(1) and the silent child was actually killed (got ${String(r!.kills)} kills)`);
  assert(
    r!.progress === 0,
    `(1) nothing ticked: the child emitted no line at all, so only a timer could have fired it (progress calls ${String(r!.progress)})`,
  );
}

// ── (2) the window is honoured: not before, and at the boundary.
{
  let before: Awaited<ReturnType<typeof drive>> | undefined;
  let at: Awaited<ReturnType<typeof drive>> | undefined;
  await withEnv(WINDOW_ENV, async () => {
    before = await drive({ windowMs: WINDOW, silenceMs: 0, afterEmitMs: WINDOW - LINE });
    at = await drive({ windowMs: WINDOW, silenceMs: 0, afterEmitMs: WINDOW });
  });
  assert(
    before!.checks === 0,
    `(2) inside the window the lever holds its fire (got ${String(before!.checks)} checks at ${String(WINDOW - LINE)} ms)`,
  );
  assert(
    at!.checks === 1,
    `(2) at the window it fires (got ${String(at!.checks)} checks at ${String(WINDOW)} ms)`,
  );
}

// ── (3) a tool call in flight is work, not silence (#951) — fed through the real stream.
{
  let r: Awaited<ReturnType<typeof drive>> | undefined;
  await withEnv(WINDOW_ENV, async () => {
    r = await drive({
      windowMs: WINDOW,
      silenceMs: WINDOW + LINE,
      events: [turnWithToolCalls(1)],
      afterEmitMs: LINE,
    });
  });
  assert(
    r!.inFlight.active === true,
    "(3) canary: the case really left a tool call open through the real InFlightTools",
  );
  assert(
    r!.checks === 0,
    `(3) a silent child with a tool in flight is never a stall (got ${String(r!.checks)} checks)`,
  );
}

// ── (4) lines arriving inside the window keep the child clear.
{
  let r: Awaited<ReturnType<typeof drive>> | undefined;
  await withEnv(WINDOW_ENV, async () => {
    r = await drive({
      windowMs: WINDOW,
      silenceMs: WINDOW + LINE,
      events: [plainTurn(), plainTurn(), plainTurn()],
      betweenEventsMs: LINE,
      afterEmitMs: LINE,
    });
  });
  assert(r!.progress >= 3, "(4) the child really emitted turns, so progress arrived inside it");
  assert(
    r!.checks === 0,
    `(4) a child that keeps answering is never stalled (got ${String(r!.checks)} checks)`,
  );
  // The canary that keeps the two cells above from being vacuous: the poll does tick on this
  // harness, and the same child silent past the window is fired by it. Same shape as cell (1),
  // which passes, so a failure here means the poll stopped supervising a live child — not that the
  // case raced a boundary.
  let fired: Awaited<ReturnType<typeof drive>> | undefined;
  await withEnv(WINDOW_ENV, async () => {
    fired = await drive({ windowMs: WINDOW, silenceMs: 0, afterEmitMs: WINDOW });
  });
  assert(
    fired!.checks === 1,
    `(4) canary, the poll really runs here: the same child silent past the window IS fired (got ${String(fired!.checks)} checks, kills ${String(fired!.kills)}, budget ${String(fired!.budgetMs)})`,
  );
}

// ── (5) the poll's own arms keep precedence over the lever.
{
  let r: Awaited<ReturnType<typeof drive>> | undefined;
  await withEnv({ ...WINDOW_ENV, PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: String(LINE) }, async () => {
    r = await drive({ windowMs: WINDOW, silenceMs: 0, afterEmitMs: WINDOW });
  });
  assert(
    r!.budgetMs === LINE,
    `(5) with a tighter model-silence budget the poll still names the silence cause, not the stall (budgetMs ${String(r!.budgetMs)})`,
  );
  assert(
    r!.checks === 0,
    `(5) and the stall lever does not also fire once the poll has already ended the child (got ${String(r!.checks)} checks)`,
  );
}

// ── (6) the lever's own kill is named `stall` and carries its window.
{
  const seen: string[] = [];
  const { child, kills } = fakeChild();
  const inFlightTools = new InFlightTools();
  // The case's simulated clock, stated as an offset from the real instant the child started:
  // `ChildProgress` and the poll both stamp with `Date.now()`, and a clock that starts at 0 would
  // read as decades of silence against the poll's budgets.
  const t0 = Date.now();
  let now = t0;
  const childProgress = new ChildProgress(() => now);
  const poll = createInactivityPoll({
    child,
    inFlightTools,
    // The pump stamps this clock with `Date.now()` on the child's own lines, so the case states
    // its silence on the same clock: the child's last line was `sinceMs` of simulated time ago.
    // A fixture clock that is not an offset of the real one reads as decades of silence, and the
    // poll's own budgets fire on the first tick — the wrong cause for the wrong reason.
    lastActivityAt: () => Date.now() - (now - childProgress.lastProgressAt),
    childProgress,
    onKill: (cause, ms) => seen.push(`${cause}:${String(ms)}`),
    stall: {
      windowMinutes: WINDOW / 60_000,
      windowMs: WINDOW,
      silence: () => ({ sinceMs: now - childProgress.lastProgressAt, toolInFlight: inFlightTools.active }),
      // The caller's hook in this cell does nothing on purpose: the cell asks what the POLL
      // contributes when the lever fires — a named cause, and a guarded kill of its own.
    },
  });
  now = t0 + WINDOW;
  await wait(4 * LINE + 100);
  poll.stop();
  assert(
    seen.length >= 1 && seen[0] === `stall:${String(WINDOW)}`,
    `(6) the poll's stall arm is a NAMED cause carrying its own window (got ${JSON.stringify(seen)})`,
  );
  assert(kills() >= 1, `(6) and the stalled child was ended, not left running (kills ${String(kills())})`);
}

// ── (7) the spawn's own reader is what the poll reads (no placeholder reading).
await withEnv(BUDGET_ENV, async () => {
  const inFlightTools = new InFlightTools();
  const childProgress = new ChildProgress();
  const arm = stallLever(
    { stall: { windowMinutes: 2, silence: () => ({ sinceMs: 0, toolInFlight: false }) } } as never,
    childProgress,
    inFlightTools,
    emptyRunningState("developer"),
  );
  assert(arm !== undefined, "(7) the spawn builds a lever from the caller's armed window");
  assert(
    arm!.silence().sinceMs < 1_000 && arm!.silence().toolInFlight === false,
    `(7) a child that has just started is quiet for nothing and has nothing in flight (${String(arm!.silence().sinceMs)} ms)`,
  );
  childProgress.observe(turnWithToolCalls(1));
  inFlightTools.observe(turnWithToolCalls(1));
  assert(arm!.silence().toolInFlight === true, "(7) the reader reports the stream's own in-flight bit");
  // The event production closes a span with: the tool's result message. Its arrival is itself
  // progress, so the reader's silence restarts there — which is the whole reason the poll can
  // tell a wedged tool from a quiet model.
  const toolResult = {
    type: "message_end",
    message: { role: "toolResult", toolCallId: "tc-0", toolName: "bash", isError: false },
  } as PiJsonEvent;
  // Both trackers see it, as both do in production: the call leaves the stream's open set and the
  // result counts as progress, which restarts the silence the reader reports.
  childProgress.observe(toolResult);
  inFlightTools.observe(toolResult);
  // ONE reading per moment: the reader is a live measurement, and re-calling it inside the
  // message after an `await` would report time the case itself spent between the two calls.
  // The bounds are what the wait leaves room for on a loaded host, not a claim about the tracker.
  const justClosed = arm!.silence();
  assert(
    justClosed.toolInFlight === false && justClosed.sinceMs < 1_000,
    `(7) and once the result lands the reader reports the tracker's own silence (${String(justClosed.sinceMs)} ms)`,
  );
  await wait(700);
  const quiet = arm!.silence();
  assert(
    quiet.toolInFlight === false && quiet.sinceMs >= justClosed.sinceMs,
    `(7) and the silence it reports grows with the wall clock since that last piece of progress (${String(quiet.sinceMs)} ms, from ${String(justClosed.sinceMs)} ms)`,
  );
});

process.exit(failed);
