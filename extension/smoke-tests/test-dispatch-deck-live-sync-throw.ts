#!/usr/bin/env bun
/**
 * #839 — live view: sync-throw exception safety (startJob + startBatch).
 *
 * Moved VERBATIM from test-dispatch-deck-live.ts (sections 6b/6c/6d) into
 * a standalone file when the port of sections 3/4 to createAgentViewComponent
 * pushed the original file past the 500-line cap (#916 slice B). The new
 * Promise wrapper turns a sync throw into a rejection that flows through
 * the existing settle handlers — no special branches.
 */

import { startBatch, startJob } from "../src/async-jobs.ts";
import { bufferCount, dropBuffer, hasBuffer, startBuffer } from "../src/dispatch-deck-live.ts";
import {
  batchSnapshot,
  clearEntry,
  detach,
  reset,
  snapshot,
  startEntry,
} from "../src/dispatch-deck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function resetBuffers(): void {
  for (const k of ["b1", "b2", "b3"]) dropBuffer(k);
}

// ---------------------------------------------------------------------------
// 6b. clearEntry drops the buffer — co-located lifecycle.
// ---------------------------------------------------------------------------
function testClearEntryDropsBuffer() {
  resetBuffers();
  reset();
  startBuffer("deck-job-1");
  startEntry("deck-job-1", { label: "developer", role: "developer" });
  assert(hasBuffer("deck-job-1"), "6b-a: buffer exists while the entry is alive");
  clearEntry("deck-job-1");
  assert(!hasBuffer("deck-job-1"), "6b-b: clearEntry drops the buffer (co-located)");
  assert(bufferCount() === 0, "6b-c: buffer count is 0 after clearEntry");
  detach();
}
testClearEntryDropsBuffer();

// ---------------------------------------------------------------------------
// 6c. Sync-throw exception safety (startJob + startBatch)
// ---------------------------------------------------------------------------
async function testStartJobSyncThrow() {
  resetBuffers();
  reset();
  const fakePi = { sendUserMessage: () => {} } as never;
  let threwSync = false;
  let completionRejected = false;
  try {
    const handle = startJob(fakePi, {
      label: "sync-throw-job",
      role: "developer",
      work: () => {
        throw new Error("sync work failure");
      },
    });
    await handle.completion;
  } catch (err) {
    completionRejected = err instanceof Error && err.message === "sync work failure";
  }
  assert(!threwSync, "6c-a: sync throw does not propagate from startJob");
  assert(completionRejected, "6c-b: throw becomes a rejection of the job promise");
  await new Promise((r) => setTimeout(r, 10));
  const leaked = snapshot().find((e) => e.label === "sync-throw-job");
  assert(!leaked, "6c-c: no deck entry leaked");
  assert(bufferCount() === 0, "6c-d: buffer count is 0 after the sync throw");
  detach();
}
async function testStartBatchLastMemberSyncThrow() {
  resetBuffers();
  reset();
  const inbox: string[] = [];
  const fakePi = { sendUserMessage: (c: string) => inbox.push(c) } as never;
  startBatch(fakePi, {
    batchLabel: "sync-throw-batch",
    members: [
      {
        label: "member-ok",
        role: "explore",
        work: async () => ({ role: "explore", ok: true, ms: 5, text: "member-ok done" }),
      },
      {
        label: "member-sync-throw",
        role: "developer",
        work: () => {
          throw new Error("batch sync work failure");
        },
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 100));
  assert(inbox.length === 1, "6d-a: ONE consolidated batch report delivered");
  assert(
    inbox[0]?.includes("batch") && inbox[0]?.includes("member-sync-throw"),
    "6d-b: batch report names the failing member",
  );
  assert(
    batchSnapshot().find((b) => b.label === "member-ok") === undefined,
    "6d-c: member entry cleared",
  );
  assert(batchSnapshot().length === 0, "6d-d: batch entry cleared");
  assert(bufferCount() === 0, "6d-e: buffer count is 0");
  detach();
}
// Await both before section 7's `reset()` clears the deck entries.
await testStartJobSyncThrow();
await testStartBatchLastMemberSyncThrow();

console.log(`\nexit ${exit}`);
process.exit(exit);
