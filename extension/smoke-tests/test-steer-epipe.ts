#!/usr/bin/env bun
/**
 * #932 — the EPIPE crash: a steer written to a child whose stdin pipe has
 * closed fires an ASYNCHRONOUS `error` event (Node destroys the stream,
 * `write` returns normally), which with no `error` listener becomes an
 * uncaughtException that kills the whole pi process.
 *
 * This file reproduces the incident shape with a REAL child process:
 *   (a) a child that exits immediately, its stdin guarded + registered; a
 *       2 MB write before exit queues data that EPIPEs asynchronously;
 *       three steerChild calls all return delivered:false with zero
 *       uncaughtException / unhandledRejection.
 *   (b) the orchestrator branch with a closed active-child stdin.
 *   (c) the slow-notice deliver path: watchSlowDispatch WITHOUT steerFn,
 *       the real job registered with a closed stdin, threshold crossed via
 *       feedSlowProgress with an injected clock — no crash, PM notice fires.
 *   (d) source canary: spawn.ts attaches the stdin error listener BEFORE
 *       the onStdin handoff.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { attachStdinErrorGuard } from "../src/stdin-guard.ts";
import {
  jobs,
  markOrchestrator,
  registerChildHandle,
  setOrchestratorActiveChild,
  setParentExtensionApi,
  clearParentExtensionApiForTesting,
} from "../src/async-jobs-registry.ts";
import { clearJobsForTesting } from "../src/async-jobs-lifecycle.ts";
import { steerChild } from "../src/dispatch-steer.ts";
import {
  clearSlowWatchesForTesting,
  feedSlowProgress,
  watchSlowDispatch,
} from "../src/slow-notice.ts";
import type { RunningState } from "../src/progress.ts";

let exitCode = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

let uncaught = 0;
let unhandled = 0;
const onUncaught = (e: Error) => {
  uncaught++;
  console.error(`  uncaughtException: ${e.message}`);
};
const onUnhandled = (r: unknown) => {
  unhandled++;
  console.error(`  unhandledRejection: ${String(r)}`);
};
process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onUnhandled);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real child that exits immediately, with its stdin guarded by the
 * SAME helper spawn.ts uses. Returns the child's stdin once the child has
 * fully exited and its stdio is closed (the incident's race: the handle
 * still registered, the pipe dead). */
async function deadChildStdin(id: string) {
  // `/usr/bin/true` exits immediately without reading stdin — the 2 MB
  // write queues data that EPIPEs asynchronously on Node (the incident
  // shape); under Bun the pipe semantics differ but the guard + listener
  // contract is identical. We wait via event callbacks (not `await once`)
  // because the pipe buffer can fill and block the async iteration.
  const child = spawn("/usr/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] });
  const stdin = child.stdin;
  if (!stdin) throw new Error("no stdin on child");
  attachStdinErrorGuard(stdin, id);
  // 2 MB before exit: reproduces the queued-data async EPIPE (a plain
  // small write to an already-dead stream is swallowed silently).
  stdin.write(Buffer.alloc(2 * 1024 * 1024, 65));
  await new Promise<void>((resolve) => {
    child.on("exit", () => {
      child.on("close", () => resolve());
    });
  });
  return stdin;
}

/** Minimal single-job entry so the orchestrator helpers resolve. */
function makeJob(id: string, role = "developer", label = "x") {
  jobs.set(id, {
    kind: "single",
    jobId: id,
    role,
    label,
    startedAt: Date.now(),
    abort: new AbortController(),
    ownerKind: "pm",
  });
}

function stateAt(turns: number, elapsedMs: number): RunningState {
  return {
    role: "developer",
    turns,
    toolUses: turns,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns },
    totalTokens: 0,
    elapsedMs,
    lastToolName: "bash",
    done: false,
  };
}

// ------------------------------------------------------ (a) real dead child
{
  const id = "job-epipe-a";
  registerChildHandle(id, await deadChildStdin(id), "dev-a", "developer");
  const r1 = steerChild(id, "hello", "pm-tool");
  const r2 = steerChild(id, "hello again", "driver-slow-notice");
  const r3 = steerChild(id, "third", "pm-tool");
  await sleep(200);
  assert(r1.delivered === false, "(a) steer 1 to dead real child → delivered:false");
  assert(r2.delivered === false, "(a) steer 2 → delivered:false");
  assert(r3.delivered === false, "(a) steer 3 → delivered:false");
  assert(r1.reason === "child stdin closed", `(a) reason is the closed-stdin guard (${r1.reason})`);
  assert(uncaught === 0 && unhandled === 0, "(a) zero uncaughtException / unhandledRejection");
}

// ------------------------------------------- (b) orchestrator active child
{
  const id = "orch-epipe-b";
  makeJob(id);
  markOrchestrator(id);
  const stdin = await deadChildStdin(id);
  setOrchestratorActiveChild(id, {
    role: "developer",
    label: "orch-child",
    deckKey: `${id}/r1`,
    stdin,
  });
  const r = steerChild(id, "steer the round", "pm-tool");
  await sleep(100);
  assert(r.delivered === false, "(b) orchestrator steer with closed stdin → delivered:false");
  assert(r.reason === "child stdin closed", `(b) reason is the closed-stdin guard (${r.reason})`);
  assert(uncaught === 0 && unhandled === 0, "(b) still zero uncaughtException / unhandledRejection");
  setOrchestratorActiveChild(id, null);
  clearJobsForTesting();
}

// -------------------------------------------- (c) slow-notice deliver path
await (async () => {
  const prevMs = process.env.PI_ENSEMBLE_SLOW_NOTICE_MS;
  process.env.PI_ENSEMBLE_SLOW_NOTICE_MS = "100";
  try {
    clearSlowWatchesForTesting();
    clearJobsForTesting();
    const id = "job-slow-c";
    registerChildHandle(id, await deadChildStdin(id), "dev-c", "developer");
    const notices: string[] = [];
    setParentExtensionApi({
      sendUserMessage: (t: string, _o?: { deliverAs?: string }) => notices.push(t),
    });
    let t = 1_000_000;
    const stop = watchSlowDispatch({
      id,
      role: "developer",
      label: "slow-c",
      now: () => t,
    });
    try {
      feedSlowProgress(id, stateAt(1, 200));
      assert(notices.length === 1, "(c) slow-notice: PM notice still fires on crossing");
      assert(notices[0]?.includes("slow-c") === true, "(c) notice names the label");
      await sleep(100);
      assert(
        uncaught === 0 && unhandled === 0,
        "(c) slow-notice deliver with closed stdin → no crash",
      );
    } finally {
      stop.stop();
      clearParentExtensionApiForTesting();
    }
  } finally {
    if (prevMs === undefined) delete process.env.PI_ENSEMBLE_SLOW_NOTICE_MS;
    else process.env.PI_ENSEMBLE_SLOW_NOTICE_MS = prevMs;
  }
})();

// ----------------------------------------------- (d) spawn.ts source canary
{
  const src = readFileSync(path.resolve(import.meta.dirname, "..", "src", "spawn.ts"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  const guardIdx = code.indexOf('child.stdin?.on("error"');
  const onStdinIdx = code.indexOf("opts.onStdin");
  assert(guardIdx >= 0, "(d) spawn.ts attaches a child.stdin error listener");
  assert(
    guardIdx >= 0 && onStdinIdx >= 0 && guardIdx < onStdinIdx,
    "(d) the listener is attached BEFORE opts.onStdin (and the prompt write)",
  );
}

process.removeListener("uncaughtException", onUncaught);
process.removeListener("unhandledRejection", onUnhandled);
process.exit(exitCode);
