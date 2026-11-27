/**
 * lib/lean-stall-poll-drive — the child, the clock and the poll one #2644 case drives.
 *
 * `test-lean-request-stall-poll.ts` pins that the hung-request lever fires on a TIMER and never
 * on a child line, and the only honest way to pin that is to build the objects `spawn.ts` builds:
 * `createInactivityPoll`, the stdout line handler and pump, `InFlightTools` and `ChildProgress`.
 * The fakes are the child process, the clock and the event source. The module sits beside the case
 * because a supervision stack with a pump, two trackers and a driver loop is one seam, and the
 * assertions below it are what the case reads — never a copy of the poll's rule.
 */

import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ChildProgress } from "../../src/child-progress.ts";
import type { PiJsonEvent } from "../../src/pi-event-shapes.ts";
import { emptyRunningState } from "../../src/progress.ts";
import { createInactivityPoll } from "../../src/spawn-inactivity-poll.ts";
import { InFlightTools, attachStdoutLinePump, createStdoutLineHandler } from "../../src/spawn-inflight.ts";

/** The budget env every case runs under: everything long except what the case arms. */
export const BUDGET_ENV = {
  PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: "1800000",
  PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS: "3600000",
  PI_ENSEMBLE_PROGRESS_SILENCE_MS: undefined,
};

const env = process.env as Record<string, string | undefined>;

export async function withEnv(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
) {
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
export function fakeChild(
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

export const LINE = 250;
export const WINDOW = 1200;

/** One assistant turn that opens `n` tool calls; no result follows them. */
export function turnWithToolCalls(n: number): PiJsonEvent {
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
export function plainTurn(): PiJsonEvent {
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

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One case: the poll, the stream and the arm, all the objects `spawn.ts` builds, over a fake
 * clock the case advances and a fake stream the case feeds.
 */
export async function drive(opts: {
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
  /** Deliver assistant turns through the real pump AFTER the stream went quiet past the window —
   *  the first message back, each carrying a tool call. The tracker has not seen those lines when
   *  the tick that carries them runs, so the reader still reports the stale silence; the turn tick
   *  must not be read as a stall. */
  lateTurnAfterQuiet?: number;
  /** The turn/token counts that late turn carries — the field shape #2644 lost cells with. */
  worked?: { turns: number; totalTokens: number };
  /** Advance the clock past the window BEFORE the late turn, so the case is the quiet-then-reply
   *  shape rather than a live child. */
  beforeLateMs?: number;
}): Promise<{
  checks: number;
  /** Every time the poll handed this arm a breach. `checks` is one-shot; this is not — it is what
   *  tells one breach from four, i.e. whether the poll stood itself down after ending its child. */
  fires: number;
  kills: number;
  budgetMs: number;
  progress: number;
  inFlight: InFlightTools;
  /** How long the case drove the poll, so a canary can tell a missing tick from a missing decision. */
  ticks: number;
}> {
  const inFlightTools = new InFlightTools();
  // The tick cadence the case drives below: the poll's own interval is unref'd, and Bun's runner
  // does not deliver one inside a case's wait, so the case takes the supervision passes itself.
  let pollMs = 0;
  // The case's simulated clock, stated as an offset from the real instant the child started:
  // `ChildProgress` and the poll both stamp with `Date.now()`, and a clock that starts at 0 would
  // read as decades of silence against the poll's budgets.
  const t0 = Date.now();
  let now = t0;
  const childProgress = new ChildProgress(() => now);
  let checks = 0;
  let budgetMs = 0;
  let progress = 0;
  const input = new Readable({ read() {} });
  const { child, kills } = fakeChild(input, opts.diesOnce !== false);
  // The step's side of the lever: freezing the breach and aborting. In production that is
  // `armBudget`'s freezing of the verdict — one-shot, and it ends the child through the
  // controller's kill. Here it is a COUNTER behind no one-shot guard, because the guard is what
  // hides a poll that never stood itself down: `armBudget`'s `fire` returns early on a repeat, so a
  // still-ticking poll re-firing a dead child is invisible through it. `fires` is the honest tally;
  // `checks` keeps its one-shot meaning (did the breach reach the step at all).
  let fires = 0;
  const fire = () => {
    // Count the BREACHES the poll handed here, not the passes: the case drives the passes at a
    // cadence no real timer could keep, so a pass that arrives after the poll stood down is the
    // thing under test, and the number the case asserts is how many of them carried work to do.
    if (armed.silence().sinceMs >= opts.windowMs && !inFlightTools.active) fires++;
    if (checks === 1) return; // the caller's abort is one-shot
    checks = 1;
    void (child as { kill?: () => boolean }).kill?.();
  };
  const armed = {
    windowMinutes: opts.windowMs / 60_000,
    windowMs: opts.windowMs,
    silence: () => ({
      sinceMs: now - childProgress.lastProgressAt,
      toolInFlight: inFlightTools.active,
    }),
    // The poll decides on its own tick and hands the breach here; counted as fired-or-not, not as
    // a tally: the abort is one-shot and the poll ticks several times inside a case's wait.
    fire,
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
  // One supervision pass, then a short real wait — the body the poll's `setInterval` would run.
  // One supervision pass, then a short real wait — the body the poll's `setInterval` would run.
  // The case drives these passes itself because the poll's timer is unref'd and a test runner does
  // not deliver one inside a case's wait. The cadence is the case's and deliberately short: a real
  // timer could not land this many passes, which is why `fires` (above) counts BREACHES rather than
  // passes — that is what lets a suite stay under the CI ceiling and still see a stand-down that
  // never happened.
  const runTicks = async (n: number, ms: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      poll.tick();
      await wait(ms);
      pollMs += ms;
    }
  };
  await emit();
  if (opts.afterEmitMs !== undefined) {
    // The clock moves first, then the passes: a case that means "quiet for WINDOW - LINE" must be
    // ticked inside the window, not fired by a pass that landed before the move.
    now += opts.afterEmitMs;
    await runTicks(4, Math.max(20, LINE / 2));
  }
  if (opts.lateTurnAfterQuiet !== undefined && opts.lateTurnAfterQuiet > 0) {
    // The child was quiet past the window. Its first message back arrives through the real pump:
    // that tick is the stream's, and the tracker has not seen the line yet, so the reader still
    // reports the stale silence. A lever that decided off the turn's counts, or off the reader on
    // a turn tick, would end this child — the field shape the guard at issue here got wrong.
    if (opts.beforeLateMs !== undefined) now += opts.beforeLateMs;
    const worked = opts.worked ?? { turns: 1, totalTokens: 0 };
    for (let i = 0; i < opts.lateTurnAfterQuiet; i++) {
      turnSeq++;
      const line = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: `still here ${String(turnSeq)}` },
            {
              type: "toolCall",
              id: `late-${String(i)}`,
              name: "bash",
              arguments: { command: `sleep ${String(turnSeq)}` },
            },
          ],
          usage: {
            input: Math.floor(worked.totalTokens / 2),
            output: Math.ceil(worked.totalTokens / 2),
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
          },
        },
      });
      input.push(`${line}\n`);
      // The pump reads synchronously on push; the reply itself is one instant.
      await wait(20);
    }
  }
  await runTicks(4, LINE);
  poll.stop();
  pump.close();
  input.destroy();
  return { checks, fires, kills: kills(), budgetMs, progress, inFlight: inFlightTools, ticks: pollMs };
}
