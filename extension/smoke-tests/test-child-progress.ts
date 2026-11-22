#!/usr/bin/env bun
/**
 * #1567 P1 — the per-spawn progress tracker (child-progress.ts).
 *
 * The policy defines progress as: a tool result / tool_execution_end, a
 * report_finding call, a live call emitting new update bytes, a turn whose
 * last text or tool differs, and a HEAD / dirty-tree change the driver
 * reports. Token growth, stdin echoes, steers, call starts and repeated
 * identical turns are not progress. Each case below drives a fake clock and
 * checks whether `lastProgressAt` moved. Cases 10–11 cover the opt-in
 * no-progress arm (`stall`, PI_ENSEMBLE_PROGRESS_SILENCE_MS) the inactivity
 * poll acts on.
 */

import type { ChildProcess } from "node:child_process";
import { ChildProgress, commandFingerprint, progressSilenceMs } from "../src/child-progress.ts";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import { emptyRunningState } from "../src/progress.ts";
import { InFlightTools, createInactivityPoll } from "../src/spawn-inflight.ts";
import { recordKillBudgets } from "../src/spawn-review-bounds.ts";
import { inactivityTimeoutMs, toolInactivityTimeoutMs } from "../src/spawn-support.ts";
import { armCapSession, declareKillFlags } from "../src/spawn-watchdog.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

let clock = 1_000;
function fresh(): ChildProgress {
  clock = 1_000;
  return new ChildProgress(() => clock);
}
/** Advance the clock, feed one event, and say whether it counted as progress. */
function moves(p: ChildProgress, e: PiJsonEvent): boolean {
  clock += 1_000;
  p.observe(e);
  return p.lastProgressAt === clock;
}

const bash = (command: string) => ({ command });
function assistantEnd(
  blocks: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>,
  extra: Record<string, unknown> = {},
): PiJsonEvent {
  return {
    type: "message_end",
    message: { role: "assistant", content: blocks, ...extra },
  } as PiJsonEvent;
}
const toolCall = (id: string, command: string) => ({
  type: "toolCall",
  id,
  name: "bash",
  arguments: bash(command),
});
const start = (id: string, command: string): PiJsonEvent => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: "bash",
  args: bash(command),
});
const update = (id: string, out: string): PiJsonEvent => ({
  type: "tool_execution_update",
  toolCallId: id,
  toolName: "bash",
  partialResult: { content: [{ type: "text", text: out }] },
});
const end = (id: string): PiJsonEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "bash",
  result: "ok",
  isError: false,
});
const result = (id: string): PiJsonEvent => ({
  type: "message_end",
  message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false },
});

// 1 — the spawn start is the first progress mark.
{
  const p = fresh();
  assert(p.lastProgressAt === 1_000, "lastProgressAt starts at construction");
}

// 2 — results and ends are progress; a call's start is not.
{
  const p = fresh();
  assert(
    moves(p, assistantEnd([toolCall("c1", "bun test")])),
    "a new turn with a tool call is progress",
  );
  assert(!moves(p, start("c1", "bun test")), "tool_execution_start is not progress");
  assert(moves(p, end("c1")), "tool_execution_end is progress");
  assert(moves(p, result("c1")), "a toolResult message is progress");
}

// 3 — updates are progress only when they carry new bytes.
{
  const p = fresh();
  p.observe(assistantEnd([toolCall("c1", "bun test")]));
  p.observe(start("c1", "bun test"));
  assert(moves(p, update("c1", "line 1")), "an update with new bytes is progress");
  const firstUpdateAt = clock;
  assert(!moves(p, update("c1", "line 1")), "an update repeating the same bytes is not progress");
  const live = p.inFlightCalls();
  assert(
    live.length === 1 && live[0]?.lastUpdateAt === firstUpdateAt,
    "lastUpdateAt is the last update with new bytes",
  );
  assert(!moves(p, update("unknown", "x")), "an update for a call not in flight is not progress");
}

// 4 — repeated identical turns, steers, token growth and stdin echoes are not progress.
{
  const p = fresh();
  const same = assistantEnd(
    [{ type: "text", text: "Running the suite." }, toolCall("c1", "bun test")],
    {
      usage: { input: 10, output: 10 },
    },
  );
  assert(moves(p, same), "the first turn is progress");
  const again = assistantEnd(
    [{ type: "text", text: "Running the suite." }, toolCall("c2", "bun test")],
    {
      usage: { input: 99_999, output: 99_999 },
    },
  );
  assert(
    !moves(p, again),
    "a turn with the same last text and tool, and more tokens, is not progress",
  );
  assert(
    !moves(p, {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "wrap up" }] },
    }),
    "a steer (user message) is not progress",
  );
  assert(!moves(p, { type: "response" } as PiJsonEvent), "a stdin echo (response) is not progress");
  assert(
    !moves(p, { type: "queue_update" } as PiJsonEvent),
    "a stdin echo (queue_update) is not progress",
  );
  assert(
    !moves(p, { type: "turn_end", message: again.message } as PiJsonEvent),
    "turn_end re-carrying the turn's message is not a new turn",
  );
  assert(
    moves(
      p,
      assistantEnd([
        { type: "text", text: "Running the suite." },
        toolCall("c3", "bun test --bail"),
      ]),
    ),
    "the same text with a different tool call is progress",
  );
  assert(
    moves(
      p,
      assistantEnd([{ type: "text", text: "Two failures." }, toolCall("c4", "bun test --bail")]),
    ),
    "a different last text with the same tool call is progress",
  );
  assert(
    !moves(
      p,
      assistantEnd([{ type: "text", text: "New words" }, toolCall("c5", "x")], {
        stopReason: "aborted",
      }),
    ),
    "an aborted assistant message is not a turn of work",
  );
}

// 5 — report_finding is progress even inside a repeated turn shape.
{
  const p = fresh();
  const finding = (id: string) =>
    assistantEnd([{ type: "toolCall", id, name: "report_finding", arguments: { title: "same" } }]);
  p.observe(finding("f1"));
  assert(moves(p, finding("f2")), "a report_finding call is progress");
}

// 6 — the driver's workspace sample.
{
  const p = fresh();
  clock += 5_000;
  p.recordWorkspaceChange();
  assert(p.lastProgressAt === clock, "recordWorkspaceChange marks progress");
}

// 7 — in-flight calls and the longest completed call per fingerprint.
{
  const p = fresh();
  p.observe(assistantEnd([toolCall("a", "bun  test\n --bail"), toolCall("b", "ls")]));
  p.observe(start("a", "bun  test\n --bail"));
  const startedA = 1_000;
  let calls = p.inFlightCalls();
  assert(
    calls.length === 2,
    `the toolCall block and its execution start are one call each (got ${calls.length})`,
  );
  const a = calls.find((c) => c.toolCallId === "a");
  assert(a?.startedAt === startedA, "startedAt is the first sighting of the call");
  assert(
    a?.fingerprint === commandFingerprint("bash", { command: "bun test --bail" }),
    "the fingerprint collapses whitespace",
  );
  assert(
    (a?.args as { command?: string })?.command === "bun  test\n --bail",
    "args are kept as the child sent them",
  );
  clock = 61_000;
  p.observe(end("a"));
  p.observe(result("a"));
  clock = 62_000;
  p.observe(end("b"));
  calls = p.inFlightCalls();
  assert(calls.length === 0, "every closed call leaves the in-flight list");
  const fp = commandFingerprint("bash", { command: "bun test --bail" });
  assert(
    p.longestCompletedMs(fp) === 60_000,
    `longest same-command call is 60s (got ${p.longestCompletedMs(fp)})`,
  );
  // A shorter run of the same command does not lower the longest.
  p.observe(assistantEnd([toolCall("a2", "bun test --bail")]));
  clock = 70_000;
  p.observe(end("a2"));
  assert(p.longestCompletedMs(fp) === 60_000, "a shorter same-command call keeps the longest");
  assert(
    p.longestCompletedMs("bash never-ran") === undefined,
    "a command never completed has no longest",
  );
  assert(p.longestCompleted().size === 2, "longestCompleted lists every completed fingerprint");
}

// 8 — completed turns leave no call in flight (the #1465 leak shape).
{
  const p = fresh();
  for (let i = 0; i < 13; i++) {
    const msg = assistantEnd([toolCall(`c${i}`, `cmd ${i}`)]);
    p.observe(msg);
    p.observe(start(`c${i}`, `cmd ${i}`));
    p.observe(end(`c${i}`));
    p.observe(result(`c${i}`));
    p.observe({ type: "turn_end", message: msg.message } as PiJsonEvent);
  }
  assert(p.inFlightCalls().length === 0, "13 completed turns leave no call in flight");
}

// 9 — Pi's recorded durationMs on tool_execution_end is a completed call's
// length; a value that is not a usable ms count falls back to wall-clock.
{
  const p = fresh();
  p.observe(assistantEnd([toolCall("d", "make"), toolCall("w", "make all")]));
  clock += 60_000;
  p.observe({ ...end("d"), durationMs: 5_000 });
  p.observe({ ...end("w"), durationMs: "5000" });
  const d = p.longestCompletedMs(commandFingerprint("bash", bash("make")));
  const w = p.longestCompletedMs(commandFingerprint("bash", bash("make all")));
  assert(d === 5_000, `recorded durationMs is preferred over wall-clock (got ${d})`);
  assert(w === 60_000, `a non-number durationMs falls back to wall-clock (got ${w})`);
  const q = fresh();
  q.observe(assistantEnd([toolCall("m", "make")]));
  clock += 60_000;
  const r = result("m");
  q.observe({ ...r, message: { ...r.message, durationMs: 7_000 } });
  const m = q.longestCompletedMs(commandFingerprint("bash", bash("make")));
  assert(m === 7_000, `a toolResult closing first carries the recorded duration (got ${m})`);
}

// 10 — the no-progress window: off by default, floored at the silence
// defaults, and measured from the last CHANGED signal, never from a tick.
{
  const KNOB = "PI_ENSEMBLE_PROGRESS_SILENCE_MS";
  const saved = [
    KNOB,
    "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS",
    "PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS",
  ].map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) delete process.env[k];
  const MIN = 60_000;
  const off = fresh();
  clock += 10 * 60 * MIN;
  assert(off.stall(clock, false) === undefined, "knob unset: no child is ever stalled");
  process.env[KNOB] = "0";
  assert(off.stall(clock, true) === undefined, "knob 0: no child is ever stalled");

  process.env[KNOB] = "1";
  assert(
    progressSilenceMs(false) === inactivityTimeoutMs(),
    `a short window is floored at the model-silence default (got ${progressSilenceMs(false)})`,
  );
  assert(
    progressSilenceMs(true) === toolInactivityTimeoutMs(),
    `with a call in flight it is floored at the tool-silence default (got ${progressSilenceMs(true)})`,
  );
  process.env[KNOB] = String(45 * MIN);
  assert(progressSilenceMs(false) === 45 * MIN, "a window above the floor is kept");
  process.env[KNOB] = "1";
  const W = progressSilenceMs(false);

  // A child that has emitted nothing is stalled at the window, not exempt.
  const silent = fresh();
  clock += W - 1;
  assert(
    silent.stall(clock, false) === undefined,
    "an unstarted child is not stalled before the window",
  );
  clock += 1;
  const s = silent.stall(clock, false);
  assert(s?.cause === "no-progress" && s.ms === W, "an unstarted child is stalled at the window");

  // A frozen child: every non-progress signal, every minute, for the whole window.
  const frozen = fresh();
  const turn = () =>
    assistantEnd([{ type: "text", text: "Checking." }, toolCall("f", "git status")], {
      usage: { input: clock, output: clock },
    });
  frozen.observe(turn());
  const markedAt = clock;
  const noise: PiJsonEvent[] = [
    turn(),
    { type: "response" } as PiJsonEvent,
    { type: "queue_update" } as PiJsonEvent,
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "go on" }] } },
    start("f", "git status"),
  ];
  while (clock - markedAt < W) {
    clock += MIN;
    for (const e of noise) frozen.observe(e);
  }
  assert(
    frozen.lastProgressAt === markedAt,
    "identical turns, token growth, echoes, steers and call starts never reset the window",
  );
  assert(
    frozen.stall(clock, false)?.cause === "no-progress",
    "a frozen child is stalled at the window",
  );
  // With a call in flight the same child runs on to the tool-silence floor.
  assert(
    frozen.stall(clock, true) === undefined,
    "a call in flight is not ended at the 30-min window",
  );
  assert(
    frozen.stall(markedAt + progressSilenceMs(true), true)?.cause === "no-progress",
    "a call in flight is ended at the 60-min floor",
  );

  // An advancing child: a changed turn every 20 min for 3 h is never stalled.
  const live = fresh();
  let stalled = false;
  for (let i = 0; i < 9; i++) {
    clock += 20 * MIN;
    live.observe(assistantEnd([{ type: "text", text: `step ${i}` }]));
    stalled ||= live.stall(clock + W - 1, false) !== undefined;
  }
  assert(!stalled, "a child whose progress advances is never stalled");

  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// 11 — the inactivity poll ends a stalled child as `no-progress`, and a silent
// child keeps its silence cause.
{
  const IDLE = "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS";
  const saved = process.env[IDLE];
  process.env[IDLE] = "300"; // a 250 ms poll period
  const fakeChild = { kill: () => true } as unknown as ChildProcess;
  let toolInFlight: boolean | undefined;
  const stalledProgress = {
    stall: (_now: number, inFlight: boolean) => {
      toolInFlight = inFlight;
      return { cause: "no-progress", ms: 7 };
    },
  } as unknown as ChildProgress;
  const poll = async (lastActivityAt: () => number, inFlightTools = new InFlightTools()) => {
    let seen = "";
    const stop = createInactivityPoll({
      child: fakeChild,
      inFlightTools,
      lastActivityAt,
      childProgress: stalledProgress,
      onKill: (cause, ms) => {
        seen ||= `${cause}:${ms}`;
      },
    });
    await new Promise((r) => setTimeout(r, 600));
    stop();
    return seen;
  };
  const emitting = await poll(() => Date.now());
  assert(
    emitting === "no-progress:7",
    `an emitting but stalled child is ended as no-progress (got ${emitting})`,
  );
  // The poll hands the tracker the in-flight state, so a silent long tool gets its floor.
  const busy = new InFlightTools();
  busy.observe(start("t", "sleep 3600"));
  await poll(() => Date.now(), busy);
  assert(toolInFlight === true, "the poll tells the tracker a tool call is in flight");
  const quiet = await poll(() => 0);
  assert(quiet === "inactivity:300", `a silent child keeps the inactivity cause (got ${quiet})`);
  // The flag the spawn sets on that kill names the child's end.
  const flags = declareKillFlags();
  const child = { on: () => undefined } as unknown as ChildProcess;
  const caps = armCapSession(child, flags, {
    role: "developer",
    runningState: emptyRunningState("developer"),
  });
  flags.setNoProgressKilled(true);
  assert(
    caps.killCause() === "no-progress",
    `the no-progress flag resolves to its cause (got ${caps.killCause()})`,
  );
  const result = { killCause: "no-progress" } as DispatchResult;
  recordKillBudgets(result, { timeoutMs: 1, clamped: false, killedBudgetMs: () => 7 });
  assert(
    result.killBudgetMs === 7,
    `a no-progress kill records the window it fired on (got ${result.killBudgetMs})`,
  );
  if (saved === undefined) delete process.env[IDLE];
  else process.env[IDLE] = saved;
}

process.exit(exit);
