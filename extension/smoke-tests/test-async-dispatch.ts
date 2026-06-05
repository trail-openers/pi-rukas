#!/usr/bin/env bun
/**
 * Offline unit test for the async-jobs registry.
 *
 * Stubs pi.sendUserMessage to capture what would be pushed to the parent
 * agent. Asserts the three invariants:
 *   1. startJob() returns instantly with a jobId
 *   2. exactly ONE steer message is delivered when the job resolves, and the
 *      body contains the work's `text` (final assistant text proxy)
 *   3. startBatch() with N members produces exactly ONE consolidated steer
 *      message when ALL N have settled (not N separate arrivals)
 *
 * No Pi process spawned, no network.
 */

import {
  clearJobsForTesting,
  jobStatusSnapshot,
  killAllJobs,
  killJob,
  startBatch,
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

interface StubMessage {
  content: string;
  deliverAs?: string;
}

function makePiStub() {
  const inbox: StubMessage[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: testing seam — match minimum shape registerAsyncJobsLifecycle needs.
  const pi: any = {
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      inbox.push({ content, deliverAs: options?.deliverAs });
    },
  };
  return { pi, inbox };
}

function fakeResult(role: string, text: string, ok = true, ms = 100): DispatchResult {
  return {
    role,
    ok,
    text,
    toolUses: [],
    ms,
    exitCode: ok ? 0 : 1,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
    transcriptPath: `/tmp/fake-${role}.json`,
  };
}

async function nextTick() {
  await new Promise((r) => setTimeout(r, 5));
}

// ---------------------------------------------------------------------------
// Test 1 — startJob returns instantly, fires ONE steer on completion
// ---------------------------------------------------------------------------
{
  const { pi, inbox } = makePiStub();
  const FAKE_TEXT = "developer: ok, implemented X and ran the tests.";
  const t0 = Date.now();
  const { jobId } = startJob(pi, {
    label: "developer",
    role: "developer",
    work: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return fakeResult("developer", FAKE_TEXT, true, 50);
    },
  });
  const elapsed = Date.now() - t0;
  assert(elapsed < 20, `startJob returned in <20ms (got ${elapsed}ms)`);
  assert(typeof jobId === "string" && jobId.length > 5, "jobId looks well-formed");
  assert(inbox.length === 0, "no steer delivered yet (work still running)");

  // Wait for work to settle + steer to fire
  await new Promise((r) => setTimeout(r, 100));
  assert(inbox.length === 1, `exactly ONE steer delivered (got ${inbox.length})`);
  const msg = inbox[0];
  assert(msg.deliverAs === "steer", `deliverAs === "steer" (got ${msg.deliverAs})`);
  assert(msg.content.includes(FAKE_TEXT), "report body contains the work's final text");
  assert(msg.content.startsWith("[ensemble:async]"), "report header is the standard prefix");
  assert(
    msg.content.includes("`developer`") && msg.content.includes(jobId),
    "header names the role and jobId",
  );
  // Bounded — no transcript content. The fake result text is small; any extra
  // bytes beyond header + body + footer would mean we're dumping transcript
  // events. Allow 400 bytes of envelope (header + footer + formatting).
  const envelopeBytes = msg.content.length - FAKE_TEXT.length;
  assert(envelopeBytes < 400, `envelope <400 bytes (got ${envelopeBytes})`);
}

// ---------------------------------------------------------------------------
// Test 2 — startBatch fires ONE consolidated steer when ALL members settle
// ---------------------------------------------------------------------------
{
  const { pi, inbox } = makePiStub();
  const settleDelays = [30, 60, 20]; // intentionally out of order
  const { batchId, jobIds } = startBatch(pi, {
    batchLabel: "dispatch_parallel",
    members: settleDelays.map((delay, i) => ({
      label: `member-${i}`,
      role: `role-${i}`,
      work: async () => {
        await new Promise((r) => setTimeout(r, delay));
        return fakeResult(`role-${i}`, `member ${i} report`, true, delay);
      },
    })),
  });
  assert(typeof batchId === "string" && batchId.length > 5, "batchId well-formed");
  assert(jobIds.length === 3, "3 member jobIds returned");
  assert(inbox.length === 0, "no steer delivered yet (members still running)");

  await new Promise((r) => setTimeout(r, 150));
  assert(inbox.length === 1, `exactly ONE consolidated steer delivered (got ${inbox.length})`);
  const msg = inbox[0];
  assert(msg.content.includes(batchId), "batch report references batchId");
  for (let i = 0; i < 3; i++) {
    assert(msg.content.includes(`member ${i} report`), `member ${i} body included`);
  }
  assert(msg.content.includes("3/3 ok"), "batch header shows 3/3 ok");
}

// ---------------------------------------------------------------------------
// Test 3 — jobStatusSnapshot returns running jobs, deletes on completion
// ---------------------------------------------------------------------------
{
  // Clean any stragglers from previous tests
  killAllJobs();
  await new Promise((r) => setTimeout(r, 50));

  const { pi } = makePiStub();
  const beforeStart = jobStatusSnapshot();
  assert(beforeStart.length === 0, "registry empty before startJob");

  const { jobId } = startJob(pi, {
    label: "ops",
    role: "ops",
    work: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return fakeResult("ops", "done", true, 80);
    },
  });
  const inFlight = jobStatusSnapshot();
  assert(inFlight.length === 1, "snapshot shows one running job");
  assert(inFlight[0].jobId === jobId, "snapshot row matches jobId");
  assert(inFlight[0].label === "ops", "snapshot row carries label");
  assert(typeof inFlight[0].elapsedMs === "number" && inFlight[0].elapsedMs >= 0, "elapsedMs set");

  await new Promise((r) => setTimeout(r, 150));
  const afterDone = jobStatusSnapshot();
  assert(afterDone.length === 0, "registry empty after completion");
}

// ---------------------------------------------------------------------------
// Test 4 — killJob aborts the work via AbortSignal
// ---------------------------------------------------------------------------
{
  const { pi, inbox } = makePiStub();
  let abortSeen = false;
  const { jobId } = startJob(pi, {
    label: "long-running",
    role: "developer",
    work: (signal) =>
      new Promise<DispatchResult>((resolve, reject) => {
        const t = setTimeout(() => resolve(fakeResult("developer", "should not happen")), 5000);
        signal.addEventListener("abort", () => {
          abortSeen = true;
          clearTimeout(t);
          reject(new Error("aborted by killJob"));
        });
      }),
  });
  await nextTick();
  const killed = killJob(jobId);
  assert(killed === true, "killJob returned true for live job");
  await new Promise((r) => setTimeout(r, 50));
  assert(abortSeen, "AbortSignal fired in the work function");
  assert(inbox.length === 1, "fail report still delivered after kill");
  assert(inbox[0].content.includes("FAILED"), "fail report tagged FAILED");

  // killJob on a non-existent jobId returns false
  assert(killJob("nonexistent") === false, "killJob on missing job returns false");
}

// ---------------------------------------------------------------------------
// Test 5 — Failed work produces a bounded fail report (no transcript dump)
// ---------------------------------------------------------------------------
{
  const { pi, inbox } = makePiStub();
  startJob(pi, {
    label: "explore",
    role: "explore",
    work: async () => {
      throw new Error("the_error_message_should_appear_in_tail");
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert(inbox.length === 1, "fail produces one steer");
  assert(inbox[0].content.includes("FAILED"), "fail report tagged FAILED");
  assert(
    inbox[0].content.includes("the_error_message_should_appear_in_tail"),
    "fail report includes error tail",
  );
  assert(inbox[0].content.length < 500, "fail report is bounded (<500 bytes)");
}

// ---------------------------------------------------------------------------
// Test 6 — startBatch propagates per-member labels to the dispatch deck (#136)
// ---------------------------------------------------------------------------
{
  dispatchDeck.reset();
  const { pi } = makePiStub();
  startBatch(pi, {
    batchLabel: "dispatch_parallel",
    members: [
      {
        label: "developer[task-A]",
        role: "developer",
        work: () => new Promise(() => undefined), // never resolves — we only inspect the deck snapshot
      },
      {
        label: "developer[task-B]",
        role: "developer",
        work: () => new Promise(() => undefined),
      },
      {
        label: "explore[context]",
        role: "explore",
        work: () => new Promise(() => undefined),
      },
    ],
  });
  const snap = dispatchDeck.snapshot();
  assert(snap.length === 3, "startBatch with 3 members creates 3 deck entries");
  const labels = snap.map((e) => e.label).sort();
  assert(
    JSON.stringify(labels) === '["developer[task-A]","developer[task-B]","explore[context]"]',
    "deck entry labels match per-member labels (disambiguates same-role members)",
  );
  // Cleanup so subsequent tests / suite shutdown don't see leaked entries.
  killAllJobs();
  dispatchDeck.reset();
}

// ---------------------------------------------------------------------------
// Test — MAX_JOBS bound (audit #171): startJob throws past the cap, and
// startBatch rejects if the orchestrator+members would push past it. The
// cap is 50; we fill up just under the line, then assert the next single
// is refused and the next batch is refused.
// ---------------------------------------------------------------------------
{
  const { pi } = makePiStub();
  // Drain the module-level jobs Map — prior tests in this file used
  // never-resolving work, and killAllJobs only aborts; it can't remove
  // entries whose work function never reacts to AbortSignal.
  clearJobsForTesting();
  dispatchDeck.reset();
  // Fill 49 single jobs with never-resolving work so they all stay in the map.
  for (let i = 0; i < 49; i++) {
    startJob(pi, {
      label: `filler-${i}`,
      role: "developer",
      work: () => new Promise(() => undefined),
    });
  }
  // The 50th is still fine — equal-to-cap is allowed.
  let fiftiethOk = false;
  try {
    startJob(pi, {
      label: "filler-49",
      role: "developer",
      work: () => new Promise(() => undefined),
    });
    fiftiethOk = true;
  } catch {
    // unreachable; cap is 50, this is the 50th
  }
  assert(fiftiethOk, "MAX_JOBS=50: 50th in-flight single still allowed");
  // The 51st must throw with a recognisable message.
  let threw = false;
  let errMsg = "";
  try {
    startJob(pi, {
      label: "overflow",
      role: "developer",
      work: () => new Promise(() => undefined),
    });
  } catch (err) {
    threw = true;
    errMsg = (err as Error).message;
  }
  assert(threw, "MAX_JOBS=50: 51st single throws");
  assert(
    errMsg.includes("cap 50") && errMsg.includes("already in flight"),
    `MAX_JOBS error message names the cap clearly (got: "${errMsg}")`,
  );
  // A batch that would push past the cap is also refused — atomic, not partial.
  let batchThrew = false;
  let batchErrMsg = "";
  try {
    startBatch(pi, {
      batchLabel: "overflow-batch",
      members: [
        { label: "m1", role: "developer", work: () => new Promise(() => undefined) },
        { label: "m2", role: "developer", work: () => new Promise(() => undefined) },
      ],
    });
  } catch (err) {
    batchThrew = true;
    batchErrMsg = (err as Error).message;
  }
  assert(batchThrew, "MAX_JOBS: batch that would overflow is rejected atomically");
  assert(
    batchErrMsg.includes("refusing to start batch"),
    `batch overflow error message is recognisable (got: "${batchErrMsg}")`,
  );
  clearJobsForTesting();
  dispatchDeck.reset();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
