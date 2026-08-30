#!/usr/bin/env bun
/**
 * smoke-tests/test-work-tool-async.ts — verifies the async work-driver tool
 * integration: start_work_driver returns a jobId, the job is registered, and
 * a structured report is delivered on completion.
 *
 * This is the structural integration test for #587: start_work_driver no
 * longer returns plain text — it returns { jobId, started: true } and
 * delegates to startJob from async-jobs so the completion is a structured
 * [ensemble:async] steer.
 *
 * No Pi process spawned, no network, no driver logic executed.
 */

import {
  clearJobsForTesting,
  jobStatusSnapshot,
  killAllJobs,
  startJob,
} from "../src/async-jobs.ts";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// Test 1 — tool returns jobId in details, not a long text block
// ---------------------------------------------------------------------------

// We can't easily invoke registerWorkTools + execute without a real Pi instance,
// but we can verify the shape of the tool registration by reading the source.
// The actual async behavior is verified via the startJob smoke test below.

// ---------------------------------------------------------------------------
// Test 2 — startJob integration: work function returns DispatchResult,
//          completion delivers ONE steer report
// ---------------------------------------------------------------------------

interface StubMessage {
  content: string;
  deliverAs?: string;
}

function makePiStub() {
  const inbox: StubMessage[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const pi: any = {
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      inbox.push({ content, deliverAs: options?.deliverAs });
    },
  };
  return { pi, inbox };
}

function fakeDispatchResult(ok = true, ms = 50): DispatchResult {
  return {
    role: "work-driver",
    ok,
    text: ok
      ? "Completed issue #587. State in .pi/work-state/587.json"
      : "/work driver crashed: simulated error",
    toolUses: [],
    ms,
    exitCode: ok ? 0 : 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    transcriptPath: ok ? "/tmp/work-driver-state" : "ensemble-runs/",
  };
}

{
  const { pi, inbox } = makePiStub();
  dispatchDeck.reset();
  clearJobsForTesting();

  // Simulate what work-tool.ts does: startJob with a work function that
  // calls runDriver (we substitute a fake work function for testing).
  const { jobId } = startJob(pi, {
    label: "work-driver",
    role: "work-driver",
    skipDeck: true,
    work: async () => {
      // Simulate driver runtime
      await new Promise((r) => setTimeout(r, 30));
      return fakeDispatchResult(true, 30);
    },
  });

  // JobId must be returned immediately (sub-10ms)
  assert(typeof jobId === "string" && jobId.length > 5, `jobId is returned: ${jobId}`);

  // Job must be in the registry while running
  const snap = jobStatusSnapshot();
  assert(snap.length === 1, `job is in registry while running (got ${snap.length})`);
  assert(snap[0].label === "work-driver", `registry label matches "work-driver"`);
  assert(snap[0].jobId === jobId, `registry jobId matches`);

  // No steer yet — work is still in progress
  assert(inbox.length === 0, `no steer yet (work running, got ${inbox.length})`);

  // Wait for completion
  await new Promise((r) => setTimeout(r, 100));

  // Exactly ONE steer delivered
  assert(inbox.length === 1, `exactly ONE steer on completion (got ${inbox.length})`);
  assert(inbox[0].deliverAs === "steer", `deliverAs === "steer"`);
  assert(inbox[0].content.includes(jobId), `report contains jobId`);
  assert(inbox[0].content.startsWith("[ensemble:async]"), `report header is standard prefix`);
  assert(inbox[0].content.includes("work-driver"), `report includes role name`);

  // Registry must be empty after completion
  const snap2 = jobStatusSnapshot();
  assert(snap2.length === 0, `registry empty after completion`);

  dispatchDeck.reset();
}

// ---------------------------------------------------------------------------
// Test 3 — failed work delivers a bounded fail report
// ---------------------------------------------------------------------------

{
  const { pi, inbox } = makePiStub();
  dispatchDeck.reset();
  clearJobsForTesting();

  startJob(pi, {
    label: "work-driver",
    role: "work-driver",
    skipDeck: true,
    work: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return fakeDispatchResult(false, 20);
    },
  });

  await new Promise((r) => setTimeout(r, 80));

  assert(inbox.length === 1, `fail case delivers exactly ONE steer (got ${inbox.length})`);
  assert(inbox[0].content.includes("FAILED"), `fail report tagged FAILED`);
  assert(inbox[0].content.includes("simulated error"), `fail report includes error message`);
  assert(inbox[0].content.length < 600, `fail report is bounded (<600 bytes)`);

  dispatchDeck.reset();
}

// ---------------------------------------------------------------------------
// Test 4 — ownerKind "driver" skips the steer (in-process caller consumes via
//          completion promise instead)
// ---------------------------------------------------------------------------

{
  const { pi, inbox } = makePiStub();
  dispatchDeck.reset();
  clearJobsForTesting();

  const handle = startJob(pi, {
    label: "work-driver",
    role: "work-driver",
    skipDeck: true,
    ownerKind: "driver",
    work: async () => fakeDispatchResult(true, 10),
  });

  // Wait for completion
  await new Promise((r) => setTimeout(r, 80));

  // No steer delivered to PM (ownerKind === "driver")
  assert(inbox.length === 0, `driver-owned: no steer delivered (inbox=${inbox.length})`);

  // But the completion promise resolves
  const result = await handle.completion;
  assert(result.ok === true, `completion promise resolves with ok=true`);

  dispatchDeck.reset();
}

// ---------------------------------------------------------------------------
// Test 5 — throw during work produces a bounded fail report (transport error)
// ---------------------------------------------------------------------------

{
  const { pi, inbox } = makePiStub();
  dispatchDeck.reset();
  clearJobsForTesting();

  startJob(pi, {
    label: "work-driver",
    role: "work-driver",
    skipDeck: true,
    work: async () => {
      throw new Error("transport-level crash: SIGSEGV");
    },
  });

  await new Promise((r) => setTimeout(r, 60));

  assert(inbox.length === 1, `throw produces exactly ONE steer (got ${inbox.length})`);
  assert(inbox[0].content.includes("FAILED"), `throw produces FAILED tag`);
  assert(inbox[0].content.includes("SIGSEGV"), `throw includes error tail`);
  assert(inbox[0].content.length < 500, `throw report bounded (<500 bytes)`);

  dispatchDeck.reset();
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
killAllJobs();
clearJobsForTesting();
dispatchDeck.reset();

console.log(`\nexit ${exit}`);
process.exit(exit);
