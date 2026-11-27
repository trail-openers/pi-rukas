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
import { ChildProgress } from "../src/child-progress.ts";
import { emptyRunningState } from "../src/progress.ts";
import { createInactivityPoll, stallLever } from "../src/spawn-inactivity-poll.ts";
import { InFlightTools } from "../src/spawn-inflight.ts";
import {
  BUDGET_ENV,
  LINE,
  WINDOW,
  drive,
  fakeChild,
  plainTurn,
  turnWithToolCalls,
  wait,
  withEnv,
} from "./lib/lean-stall-poll-drive.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

const WINDOW_ENV = { ...BUDGET_ENV, PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: String(LINE * 10) };



// ── (1) THE FIELD SHAPE: a request that emits NOTHING is ended by the timer.
{
  let r: Awaited<ReturnType<typeof drive>> | undefined;
  await withEnv(WINDOW_ENV, async () => {
    r = await drive({ windowMs: WINDOW, silenceMs: 0, afterEmitMs: WINDOW });
  });
  assert(r!.checks === 1, `(1) a silent child's stall lever fired on the timer (got ${String(r!.checks)} checks)`);
  assert(
    r!.fires === 1,
    `(1) the arm was consulted EXACTLY ONCE per breach — the poll stands itself down instead of re-killing a dead child on every later pass (got ${String(r!.fires)} fires over ${String(r!.ticks)} ms of supervision)`,
  );
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
      // The caller's freezing of the verdict does nothing on purpose in this cell: the cell asks
      // what the POLL contributes when the lever fires — a named cause, and a guarded kill of its
      // own — with the step's own hook absent, as it is for every caller that only forwards a window.
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

// ── (8) the turn tick after a long quiet is never a stall, whatever the child had done.
await withEnv(WINDOW_ENV, async () => {
  // The exact shape the removed guard was imitating: the child worked for turns and tokens, went
  // quiet past the window, and its FIRST message back carries a tool call. On that tick the
  // tracker has not yet seen the line, so the reader still reports the whole silence — and the
  // turn carries counts. Neither may make it a stall, because a turn tick is not the poll's tick.
  const r = await drive({
    windowMs: WINDOW,
    silenceMs: 0,
    // Silence well past the window, then the reply; the poll ticks inside the window first, so the
    // only thing that could end this child is the reply itself being misread.
    afterEmitMs: 0,
    lateTurnAfterQuiet: 3,
    beforeLateMs: WINDOW,
    worked: { turns: 12, totalTokens: 40_000 },
    // The reply's tool calls are never answered, so the child is left with work in flight — the
    // case asserts the child is still alive below rather than counting kills alone.
  });
  assert(
    r!.progress >= 3,
    `(8) the late turns really reached the spawn's own progress hook (progress ${String(r!.progress)})`,
  );
  assert(
    r!.checks === 0,
    `(8) a turn tick after a long quiet fires no stall — the tracker has not seen this line (got ${String(r!.checks)} checks)`,
  );
  assert(
    r!.inFlight.active === true,
    "(8) and the child is the shape it was: a tool call of its own still open",
  );
});

process.exit(failed);
