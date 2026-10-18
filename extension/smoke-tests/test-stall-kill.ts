#!/usr/bin/env bun
/**
 * #1313 (#1567 P5) — the driver's stall action (spawn-stall.ts).
 *
 * Policy item 4: a driver child with no progress (child-progress.ts) across a
 * whole slow-run level is ended with kill cause `no-progress` when no tool
 * call is in flight; with a call in flight it is left to the call-kill (P2).
 * A worktree change sampled at the level counts as progress. A PM's child is
 * never armed. The driver parks the kill, never re-runs it, and the notice a
 * PM reads for a driver child says the driver handles stalls.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import { DRIVER_OWNED_NOTICE } from "../src/async-jobs-registry.ts";
import { ChildProgress } from "../src/child-progress.ts";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import { applyStallKill, armStallKill } from "../src/spawn-stall.ts";
import type { DispatchResult } from "../src/types.ts";
import { classifyFailureCause, stepRetryBudget } from "../src/work-driver-failure-taxonomy.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = 40;

const base = (): DispatchResult => ({
  role: "developer",
  ok: false,
  text: "",
  toolUses: [],
  ms: 1,
  exitCode: 143,
});

const turn = (text: string, call?: { id: string; name: string }): PiJsonEvent =>
  ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...(call ? [{ type: "toolCall", id: call.id, name: call.name, arguments: {} }] : []),
      ],
    },
  }) as unknown as PiJsonEvent;

function arm(opts: {
  enabled?: boolean;
  prints?: () => string | undefined;
  settled?: () => boolean;
}) {
  const progress = new ChildProgress();
  let kills = 0;
  const stall = armStallKill({
    child: new EventEmitter() as unknown as ChildProcess,
    progress,
    cwd: "/nowhere",
    enabled: opts.enabled ?? true,
    settled: opts.settled ?? (() => false),
    baseMs: BASE,
    fingerprint: async () => (opts.prints ? opts.prints() : "same"),
    kill: () => {
      kills++;
    },
  });
  return { progress, stall, kills: () => kills };
}

// ------------------------------------------------ 1. frozen, nothing in flight
{
  const { stall, kills } = arm({});
  await wait(BASE * 2 + 30);
  assert(kills() === 1 && stall.killed(), "a child frozen across two levels is ended");
  const r = base();
  applyStallKill(stall, r);
  assert(r.killCause === "no-progress", "its kill cause is no-progress");
  stall.stop();
}

// ------------------------------------------------ 2. progress between levels
{
  const { progress, stall, kills } = arm({});
  await wait(BASE + 10);
  progress.observe(turn("status: half done"));
  await wait(BASE + 10);
  assert(kills() === 0, "a new turn between the levels is progress — no kill");
  progress.observe(turn("status: half done"));
  await wait(BASE * 2 + 20);
  assert(kills() === 1, "a repeated identical turn is not progress — killed at the next level");
  stall.stop();
}

// ------------------------------------------------ 3. a worktree change is progress
{
  let n = 0;
  const { stall, kills } = arm({ prints: () => `tree-${n++}` });
  await wait(BASE * 4 + 30);
  assert(kills() === 0 && !stall.killed(), "a changing worktree keeps the child alive");
  stall.stop();
}

// ------------------------------------------------ 4. a call in flight is P2's
{
  const { progress, stall, kills } = arm({});
  progress.observe(turn("running the suite", { id: "c1", name: "bash" }));
  await wait(BASE * 2 + 30);
  assert(kills() === 0, "a frozen child with a call in flight is not no-progress killed");
  stall.stop();
}

// ------------------------------------------------ 5. not armed
{
  const pm = arm({ enabled: false });
  const done = arm({ settled: () => true });
  await wait(BASE * 2 + 30);
  assert(pm.kills() === 0, "a PM's child is never armed");
  assert(done.kills() === 0, "a child already ending is left alone");
  const prev = process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
  const off = arm({});
  await wait(BASE * 2 + 30);
  assert(off.kills() === 0, "PI_ENSEMBLE_DISPATCH_CAPS=0 turns it off");
  if (prev === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DISPATCH_CAPS");
  else process.env.PI_ENSEMBLE_DISPATCH_CAPS = prev;
  for (const a of [pm, done, off]) a.stall.stop();
}

// ------------------------------------------------ 6. attribution and routing
{
  const killed = { killed: () => true, frozenMs: () => 5, stop: () => {} };
  const loop = { ...base(), killCause: "loop" as const };
  applyStallKill(killed, loop);
  assert(loop.killCause === "loop", "a structural cap keeps its cause");
  const bound = { ...base(), killCause: "child-bound" as const };
  applyStallKill(killed, bound);
  assert(bound.killCause === "no-progress", "no-progress outranks child-bound");
  const c = classifyFailureCause({ killCause: "no-progress" } as never);
  assert(
    c.cause === "self-killed:no-progress" && !c.shouldRetry,
    "the driver parks a no-progress kill and never re-runs it",
  );
  assert(stepRetryBudget(c, false) === 0, "a RETRY_ONCE step spends no retry on a stall kill");
  const finished = { ...base(), ok: true };
  applyStallKill(killed, finished);
  assert(finished.killCause === undefined, "a child that finished before the kill landed is done");
  const adv = classifyDispatchOutcome({ ...base(), killCause: "no-progress" });
  assert(
    adv.cause === "self-killed:no-progress" && !adv.shouldRetry,
    "an adversarial round child killed for no progress is not retried as a crash",
  );
  assert(
    /handles its stalls by itself/.test(DRIVER_OWNED_NOTICE) &&
      /do not ask the operator/.test(DRIVER_OWNED_NOTICE),
    "the driver-owned notice says the driver handles stalls",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
