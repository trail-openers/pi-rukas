#!/usr/bin/env bun
/**
 * #2484 — the child's `agent_settled.aborted` bit (Pi >= 1.1.0) decides
 * whether a reported child is done. A cancelled run is reaped as nothing, a
 * finished one as done, and without the bit `agent_end` alone decides — the
 * behaviour on a Pi that does not stamp it.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { ChildProgress } from "../src/child-progress.ts";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import { emptyRunningState } from "../src/progress.ts";
import { armChildBound, settledAborted } from "../src/spawn-child-bound.ts";
import { InFlightTools, createStdoutLineHandler } from "../src/spawn-inflight.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The parse: only a boolean on agent_settled is evidence.
assert(settledAborted({ type: "agent_settled", aborted: true }) === true, "aborted: true parses");
assert(
  settledAborted({ type: "agent_settled", aborted: false }) === false,
  "aborted: false parses",
);
assert(
  settledAborted({ type: "agent_settled" }) === undefined,
  "an unstamped settle is no evidence",
);
assert(
  settledAborted({ type: "agent_end", aborted: true }) === undefined,
  "the bit counts only on agent_settled",
);
assert(
  settledAborted({ type: "agent_settled", aborted: "yes" } as unknown as PiJsonEvent) === undefined,
  "a non-boolean bit is no evidence",
);

// ── The reap: a reported child that lingers, after each settle shape.
process.env.PI_ENSEMBLE_SETTLED_REAP_MS = "20";
async function reap(settles: PiJsonEvent[]) {
  const c = new EventEmitter() as unknown as ChildProcess & { kills: string[] };
  c.kills = [];
  (c as unknown as { kill: () => boolean }).kill = () => c.kills.push("SIGTERM") > 0;
  const bound = armChildBound({
    child: c,
    boundMs: undefined,
    cwd: "/nowhere",
    stdin: new PassThrough(),
    reported: () => true,
    childExited: () => false,
    preempted: () => false,
    commits: false,
  });
  bound.onReported();
  for (const e of settles) bound.onSettled(e);
  await wait(60);
  bound.stop();
  return { killed: c.kills.length > 0, done: bound.endedAsDone() };
}
{
  const r = await reap([{ type: "agent_settled", aborted: true }]);
  assert(r.killed && r.done === undefined, "a cancelled child is reaped, not as done");
}
{
  const r = await reap([{ type: "agent_settled", aborted: false }]);
  assert(r.killed && r.done === "reported", "a finished child is reaped as done");
}
{
  const r = await reap([]);
  assert(r.killed && r.done === "reported", "without a settle agent_end decides, as before");
}
{
  const r = await reap([{ type: "agent_settled", aborted: true }, { type: "agent_settled" }]);
  assert(r.done === undefined, "an unstamped settle does not erase a cancel");
}

// ── The backstop: a cancelled child is a timeout, whether or not it commits.
async function backstop(commits: boolean) {
  const c = new EventEmitter() as unknown as ChildProcess;
  (c as unknown as { kill: () => boolean }).kill = () => true;
  const bound = armChildBound({
    child: c,
    boundMs: undefined,
    cwd: "/nowhere",
    stdin: new PassThrough(),
    reported: () => true,
    childExited: () => false,
    preempted: () => false,
    commits,
    head: async () => "same",
  });
  bound.onSettled({ type: "agent_settled", aborted: true });
  let timedOut = false;
  const deferred = bound.atBackstop(() => {
    timedOut = true;
  });
  await wait(10);
  bound.stop();
  return timedOut && bound.endedAsDone() === undefined && deferred === commits;
}
assert(await backstop(false), "the backstop times out a cancelled child at once");
assert(await backstop(true), "the backstop times out a cancelled committing child");

// ── The wiring: the stdout handler hands every agent_settled to the bound.
{
  const seen: PiJsonEvent[] = [];
  const handle = createStdoutLineHandler({
    start: Date.now(),
    inFlightTools: new InFlightTools(),
    childProgress: new ChildProgress(),
    appendStderr: () => undefined,
    runningState: emptyRunningState("developer"),
    caps: {} as never,
    budgetProgress: {} as never,
    onAgentEnd: () => undefined,
    onAgentSettled: (e) => seen.push(e),
  });
  handle(JSON.stringify({ type: "agent_settled", aborted: true }));
  handle(JSON.stringify({ type: "message_update" }));
  assert(
    seen.length === 1 && settledAborted(seen[0]) === true,
    "the line handler routes agent_settled to onAgentSettled",
  );
}

assert(
  /onAgentSettled:\s*\(\w+\)\s*=>\s*childBound\.onSettled\(/.test(
    readFileSync(new URL("../src/spawn.ts", import.meta.url), "utf8"),
  ),
  "spawn.ts hands agent_settled to the child bound",
);

process.exit(exit);
