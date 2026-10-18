#!/usr/bin/env bun
/**
 * #1560 (#1567 P3) — the per-child run bound (spawn-child-bound.ts).
 *
 * Policy item 1: at the bound the child is steered to wrap up; a grace period
 * later it is ended with kill cause `child-bound` — unless it has committed or
 * reported completion by then, in which case it is ended as DONE, with no kill
 * cause. The kill never lands past the cycle deadline. The driver parks a
 * bound kill as `child-timeout:<step>` and never re-runs it; the 2-h
 * backstop's cap is `spawn-backstop` (policy item 7).
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { noteCycleDeadline, runWithCycleClock } from "../src/cycle-deadline-clock.ts";
import { capVocabulary } from "../src/headless/caps.ts";
import {
  applyChildBound,
  armChildBound,
  childBoundSchedule,
  developChildBoundMs,
  exploreChildBoundMs,
} from "../src/spawn-child-bound.ts";
import type { DispatchResult } from "../src/types.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { terminalReasonAtHandoff } from "../src/work-driver-terminal-reason.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeChild(): ChildProcess & { kills: string[] } {
  const c = new EventEmitter() as unknown as ChildProcess & { kills: string[] };
  c.kills = [];
  (c as unknown as { kill: (s?: string) => boolean }).kill = (s?: string) => {
    c.kills.push(s ?? "SIGTERM");
    return true;
  };
  return c;
}
const base = (): DispatchResult => ({
  role: "developer",
  ok: false,
  text: "",
  toolUses: [],
  ms: 1,
  exitCode: 143,
});

async function run(opts: {
  reported?: boolean;
  heads?: (string | undefined)[];
  onSteer?: boolean;
  commits?: boolean;
  preempted?: boolean;
}) {
  const child = fakeChild();
  const steers: string[] = [];
  const stdin = new PassThrough();
  let stdinText = "";
  stdin.on("data", (d) => {
    stdinText += String(d);
  });
  const heads = [...(opts.heads ?? ["a", "a"])];
  const bound = armChildBound({
    child,
    boundMs: 30,
    graceMs: 30,
    cwd: "/nowhere",
    onSteer: opts.onSteer === false ? undefined : (m) => steers.push(m),
    stdin,
    reported: () => opts.reported === true,
    childExited: () => false,
    preempted: () => opts.preempted === true,
    commits: opts.commits !== false,
    head: async () => heads.shift(),
  });
  await wait(45);
  const steeredAtBound = steers.length + (stdinText.includes('"steer"') ? 1 : 0);
  const killedBeforeGrace = child.kills.length > 0;
  await wait(60);
  bound.stop();
  return { child, steers, stdinText, bound, steeredAtBound, killedBeforeGrace };
}

// ── Defaults are the policy's.
assert(developChildBoundMs() === 90 * 60_000, "develop bound defaults to 90 min");
assert(exploreChildBoundMs() === 30 * 60_000, "explore bound defaults to 30 min");

// ── Schedule: wrap-up at the bound, kill at bound + grace; the deadline wins.
{
  const s = childBoundSchedule(1_000, 500, Date.now());
  assert(
    s.wrapAtMs === 1_000 && s.killAtMs === 1_500,
    "outside a cycle: wrap at bound, kill at +grace",
  );
  await runWithCycleClock(async () => {
    noteCycleDeadline(Date.now() + 1_200, 0, "develop");
    const c = childBoundSchedule(1_000, 500, Date.now());
    assert(
      c.killAtMs === undefined,
      "a deadline before bound + grace leaves the kill to the deadline backstop",
    );
    assert(
      c.wrapAtMs <= 700 && c.wrapAtMs >= 600,
      "…and the wrap-up moves to a grace period before the deadline",
    );
  });
}

// ── A working child: steered at the bound, killed after the grace.
{
  const r = await run({});
  assert(r.steeredAtBound === 1, "the child is steered to wrap up at its bound");
  assert(/wrap up/i.test(r.steers[0] ?? ""), "the steer asks it to wrap up");
  assert(!r.killedBeforeGrace, "it is not killed at the bound itself");
  assert(r.child.kills.length > 0 && r.bound.killed(), "it is killed at bound + grace");
  const res = base();
  applyChildBound(r.bound, res);
  assert(
    res.killCause === "child-bound" && res.killBudgetMs === 30,
    "kill cause child-bound, budget = the bound",
  );
}

// ── No driver steer seam: the steer goes straight to the child's stdin.
{
  const r = await run({ onSteer: false });
  assert(
    r.stdinText.includes('"type":"steer"'),
    "without onSteer the wrap-up is an RPC steer on stdin",
  );
}

// ── Reported completion: ended as done, not killed.
{
  const r = await run({ reported: true });
  assert(r.steeredAtBound === 0, "a child that already reported is not steered");
  assert(
    !r.bound.killed() && r.bound.endedAsDone() === "reported",
    "a child that reported is ended as done",
  );
  const res = base();
  applyChildBound(r.bound, res);
  assert(
    res.killCause === undefined && res.ok && res.endedAsDone === "reported",
    "its result is a completion",
  );
}

// ── Committed: HEAD moved since spawn → done.
{
  const r = await run({ heads: ["a", "b"] });
  assert(
    !r.bound.killed() && r.bound.endedAsDone() === "committed",
    "a child that committed is ended as done",
  );
  const ro = await run({ heads: ["a", "b"], commits: false });
  assert(ro.bound.killed(), "a child that cannot commit is killed even when HEAD moved under it");
  const unreadable = await run({ heads: [undefined, "b"] });
  assert(
    unreadable.bound.killed(),
    "an unreadable start HEAD proves no commit: the child is killed",
  );
}

// ── Another kill (abort, backstop) already ended the child: no bound kill.
{
  const r = await run({ preempted: true });
  assert(!r.bound.killed() && r.child.kills.length === 0, "a preempted child keeps its own cause");
}

// ── The caps master switch turns it off.
{
  process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
  const r = await run({});
  delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  assert(
    r.steers.length === 0 && r.child.kills.length === 0,
    "PI_ENSEMBLE_DISPATCH_CAPS=0 makes it inert",
  );
}

// ── Priority: replaces the backstop's timeout, never a structural cap.
{
  const r = await run({});
  const t = { ...base(), killCause: "timeout" as const };
  applyChildBound(r.bound, t);
  assert(t.killCause === "child-bound", "child-bound outranks the backstop timeout");
  const l = { ...base(), killCause: "loop" as const };
  applyChildBound(r.bound, l);
  assert(l.killCause === "loop", "a loop kill keeps its cause");
}

// ── Driver: never retried; parks as child-timeout:<step>.
{
  const c = classifyFailureCause({ killCause: "child-bound" } as never);
  assert(
    c.shouldRetry === false && c.cause === "self-killed:child-bound",
    "a bound kill is not retried",
  );
  let s = initialState(7);
  const at = Date.now();
  s = {
    ...s,
    eventLog: [
      { kind: "step-started", step: "develop", at },
      {
        kind: "dispatch-failed",
        step: "develop",
        role: "developer",
        jobId: "j",
        label: "developer",
        ms: 1,
        at,
        exitCode: 143,
        killCause: "child-bound",
      },
      { kind: "cap-hit", at, cap: "verify-failed:develop", reviewRound: 0, nextStep: "handoff" },
    ] as never,
  };
  const out = terminalReasonAtHandoff(s, undefined, at);
  const last = out.eventLog[out.eventLog.length - 1];
  assert(
    last?.kind === "cap-hit" && last.cap === "child-timeout:develop",
    "a verdict after a bound kill is replaced by child-timeout:develop",
  );
}

// ── Vocabulary: spawn-backstop replaces developer-timeout; the template is published.
{
  const v = capVocabulary();
  assert(v.fixed.includes("spawn-backstop"), "spawn-backstop is a published cap");
  assert(
    !(v.fixed as readonly string[]).includes("developer-timeout"),
    "developer-timeout is gone",
  );
  assert(
    v.templates.some((t) => t.prefix === "child-timeout:"),
    "child-timeout:<step> is a published template",
  );
}

process.exit(exit);
