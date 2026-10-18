#!/usr/bin/env bun
/**
 * #1567 P1 — the per-spawn progress tracker (child-progress.ts).
 *
 * The policy defines progress as: a tool result / tool_execution_end, a
 * report_finding call, a live call emitting new update bytes, a turn whose
 * last text or tool differs, and a HEAD / dirty-tree change the driver
 * reports. Token growth, stdin echoes, steers, call starts and repeated
 * identical turns are not progress. Each case below drives a fake clock and
 * checks whether `lastProgressAt` moved.
 */

import { ChildProgress, commandFingerprint } from "../src/child-progress.ts";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";

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

process.exit(exit);
