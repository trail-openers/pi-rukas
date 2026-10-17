/**
 * #1389 — a batch whose member setup throws partway leaves NOTHING behind.
 *
 * Third of the three `pi-rukas-jobs` companions (test-pending-jobs-signal.ts is
 * the #1295 contract; -honest-zero.ts the failed-send paths;
 * -shutdown-order.ts the shutdown bound), split again by the 500-line cap
 * test-file-size-limit.ts enforces. These cases are the batch-shaped half of
 * the ticket and share nothing with the shutdown cases but the fakes in
 * lib/pending-jobs-harness.ts.
 *
 * The defect: the setup-failure catch aborted the members and stopped there.
 * Each started member stayed in the jobs registry (so `dispatch_status` reported
 * a slot in flight and `killAllJobs` counted a child that no longer existed), in
 * the deck as a row nothing would clear, and in the live buffers — where
 * dispatch-deck-confirm.ts opens a live view for any key that still has a
 * buffer, even with the deck row gone. A leaked buffer is a user-visible empty
 * view, not a bookkeeping nit.
 *
 * Every assertion here runs in the SAME block as the failing `startBatch` call:
 * `clearJobsForTesting()` and `dispatch-deck.ts reset()` drain these maps
 * wholesale, so an assertion placed after the next case boundary would pass with
 * no cleanup code at all.
 *
 * No Pi process spawned, no network.
 */

import { childHandles } from "../src/async-jobs-registry.ts";
import { clearJobsForTesting, jobStatusSnapshot, startBatch } from "../src/async-jobs.ts";
import * as live from "../src/dispatch-deck-live.ts";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import * as pendingJobs from "../src/pending-jobs-signal.ts";
import { clearSlowWatchesForTesting } from "../src/slow-notice.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  attachRpc,
  fakeResult,
  freshWire,
  makePi,
  sent,
  until,
} from "./lib/pending-jobs-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// 6. A batch whose member setup throws partway removes the members it started.
//    #1389: the abort alone left the started member in the registry
//    (dispatch_status reporting a slot in flight, killAllJobs counting a child
//    that was gone), in the deck, and in the live buffers — and
//    dispatch-deck-confirm.ts opens a live view for any key that still has a
//    buffer, so a leaked buffer is a user-visible empty view, not a
//    bookkeeping nit. Asserted BEFORE the next test boundary:
//    clearJobsForTesting()/reset() drain these maps wholesale, so an assertion
//    after the next case would pass with no cleanup code at all.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  let firstSignal: AbortSignal | undefined;
  let firstJobId = "";
  let threw = false;
  let firstStdinRegistered = false;
  // Baselines, not zeros: earlier cases in this file reach the shared deck and
  // buffer maps through startJob, and their never-settling jobs are drained only
  // by the end-of-file clearJobsForTesting(). A zero-equality assertion would
  // blame this case for its neighbours' residue.
  const deckBefore = dispatchDeck.snapshot().length;
  const batchDeckBefore = dispatchDeck.batchSnapshot().length;
  const buffersBefore = live.bufferCount();
  // The batch row's id, recovered from the member's: job ids are
  // `${Date-base36}-${random}` (async-jobs-registry.newJobId), so the prefix is
  // the one the orchestrator row was registered under — and startBatch throws,
  // so its return value never reaches this scope to be read.
  let observedBatchId = "";
  const { pi, stdin } = makePi(w);
  // The kill the teardown calls is the one the registry holds —
  // `childHandles.get(id).kill` — not a method on the stdin object, so the spy
  // counts ABORTS on the member's signal. That is also what the product can
  // actually do to a member that never reached its spawn: there is no child to
  // signal, only the member's own abort controller.
  let memberAborts = 0;
  let memberSignal: AbortSignal | undefined;
  try {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        {
          label: "explore[a]-half-started",
          role: "explore",
          work: (signal, hooks) => {
            firstSignal = signal;
            memberSignal = signal;
            signal.addEventListener(
              "abort",
              () => {
                memberAborts += 1;
              },
              { once: true },
            );
            // The handle a real spawn registers (spawnSpecialist calls onStdin
            // once child.stdin exists): the cleanup must clear childHandles too,
            // not just `jobs`.
            hooks.onStdin(stdin);
            firstStdinRegistered = true;
            firstJobId = hooks.jobId;
            observedBatchId = hooks.jobId.split("-")[0] ?? "";
            hooks.onProgress({
              role: "explore",
              turns: 1,
              totalTokens: 0,
              lastText: "",
              elapsedMs: 10,
            });
            return new Promise<DispatchResult>(() => undefined);
          },
        },
        {
          get label(): string {
            throw new Error("second member setup boom");
          },
          role: "explore",
          work: async () => fakeResult("explore", "never started"),
        },
      ],
    });
  } catch {
    threw = true;
  }
  assert(threw, "6a: a partway batch setup throw surfaces to the caller");
  assert(firstSignal?.aborted === true, "6b: the already-started member is aborted");
  assert(
    firstStdinRegistered && firstJobId !== "" && observedBatchId !== "",
    "6c: the started member registered a handle, so both ids are known to assert on",
  );
  const leaked = jobStatusSnapshot().filter(
    (r) => r.jobId === firstJobId || r.jobId === observedBatchId,
  );
  assert(
    leaked.length === 0,
    `6d: the started member and the orchestrator are gone from the registry (got ${leaked.map((r) => r.jobId)})`,
  );
  assert(
    !childHandles.has(firstJobId),
    "6e: the started member's child handle is gone, so killJob/dispatch_steer cannot reach a dead child",
  );
  assert(
    memberAborts >= 1 && memberSignal?.aborted === true,
    `6f: the teardown killed the member through its own handle, not just its maps (aborts ${memberAborts})`,
  );
  assert(
    dispatchDeck.snapshot().length === deckBefore &&
      dispatchDeck.batchSnapshot().length === batchDeckBefore,
    "6g: no deck row (member or batch) survives the failed setup",
  );
  assert(live.bufferCount() === buffersBefore, "6h: no live buffer survives the failed setup");
  assert(!live.hasBuffer(firstJobId), "6i: the started member's live buffer is released");
  // A late raw event must not re-create the buffer the cleanup dropped — that is
  // the user-visible empty live view the ticket names.
  live.feedRawEvent(firstJobId, { type: "message_end" } as never);
  assert(!live.hasBuffer(firstJobId), "6j: a late raw event cannot re-open the dropped buffer");
  // The member's work promise never reacts to abort; its .finally must not
  // settle a batch the caller was already told about. Let any microtask run.
  await new Promise((r) => setTimeout(r, 30));
  assert(
    w.reports.length === 0 && sent(w).length === 0,
    `6k: a half-started batch owes nothing (got ${JSON.stringify(w.reports.concat(w.statuses.map((s) => `status:${s}`)))})`,
  );
}

// ---------------------------------------------------------------------------
// 7. The `.finally` dead-flag guard (async-jobs-batch.ts) is load-bearing: a
//    member whose work settles BEFORE the setup throw reaches the caller must
//    not advance the orchestrator, and must not complete a batch the caller was
//    told never started.
//
//    The timing is the hard part, and the reason a naive version of this case
//    passes with the guard deleted: `completed === size` is what settles a
//    batch, so the guard that matters is in the `.finally`, not the two `.then`
//    guards above them (those only stop the RESULT being pushed). And the throw
//    has to land on member k>0 AFTER member 0's `work` has settled — but
//    `work(k)` is called synchronously inside the loop, so any getter that
//    throws (on `label`, on `role`) fires before the following iteration ever
//    reaches its `resolve(m.work(...))`.
//
//    The seam that works is member 0's own `onStdin`, which startBatch calls
//    synchronously while still inside member 0's iteration: resolving member 0
//    from there queues its `.then/.finally` before the loop moves on, and
//    member 1's getter then throws. With the guard, that finally returns early;
//    without it, `completed` reaches `size` and a batch that never started
//    settles and delivers a report.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi } = makePi(w);
  let threw = false;
  let member0SettledEarly = false;
  const deckBefore = dispatchDeck.snapshot().length;
  const buffersBefore = live.bufferCount();
  const batchBefore = dispatchDeck.batchSnapshot().length;
  try {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        {
          label: "explore[a]-settles-early",
          role: "explore",
          // The seam: `work(0)` is called synchronously inside member 0's
          // iteration and its return value is handed to `resolve` immediately
          // after, so by the time the loop reads member 1's `label` the promise
          // is already settled and its `.then/.finally` are queued. `hooks` is
          // touched only to prove the handle a real spawn registers exists here —
          // startBatch calls `onStdin` itself, from the real spawnSpecialist, so
          // a fake work function that never spawns has no handle to register and
          // asserting on one would test the harness, not the product.
          work: (_signal, hooks) => {
            void hooks;
            member0SettledEarly = true;
            return Promise.resolve(fakeResult("explore", "settled before the batch existed"));
          },
        },
        {
          // The throw, landing after member 0's iteration — and after its work
          // resolved, which is the ordering the guard exists for.
          get label(): string {
            throw new Error("second member setup boom");
          },
          role: "explore",
          work: async () => fakeResult("explore", "never started"),
        },
      ],
    });
  } catch {
    threw = true;
  }
  assert(threw, "7a: the setup throw still surfaces to the caller");
  assert(member0SettledEarly, "7b: the seam worked — member 0 settled before the throw landed");
  // Wait for either half of the leak the guard prevents — a report, or the
  // pending slot the phantom batch would occupy — then settle for quiet.
  await until(() => w.reports.length > 0 || sent(w).length > 0);
  await new Promise((r) => setTimeout(r, 60));
  assert(
    sent(w).length === 0,
    `7c: the settled-before-death member released no pending slot and settled no batch (got ${sent(w)})`,
  );
  assert(
    w.reports.length === 0,
    `7d: a batch that never started handed no consolidated report to Pi (got ${JSON.stringify(w.reports.map((x) => x.slice(0, 40)))})`,
  );
  assert(
    dispatchDeck.snapshot().length === deckBefore && live.bufferCount() === buffersBefore,
    "7e: neither the deck nor the live buffers gained a row that outlived the failed setup",
  );
  assert(
    dispatchDeck.batchSnapshot().length === batchBefore,
    `7f: no batch row survived the failed setup (${batchBefore} -> ${dispatchDeck.batchSnapshot().length})`,
  );
}

// ---------------------------------------------------------------------------
// 8. The half-started batch owes NOTHING, in the shape a real leak would take:
//    two members run to completion, the third's setup throws. The two started
//    members' work settles normally (their promises resolve on their own), the
//    caller has been handed the error, and the batch must not settle, must not
//    deliver its consolidated report, and must not occupy a pending slot.
//
//    WHAT THIS CASE ACTUALLY PINS — read before deleting a guard here. The
//    three `killedBySetupFailure` reads in this module (the two `.then` handlers
//    and the `.finally`) are DEFENCE, not the mechanism: the catch marks every
//    started member dead SYNCHRONOUSLY, before the first `.then` of any member
//    runs, so on the in-process fakes deleting all three leaves this case green.
//    Proven by mutation, not asserted here — a test cannot pin an unreachable
//    branch. What the case is genuinely load-bearing on is the rest of the
//    catch: `orchestratorAbort.abort()` (which cascades to each member), the
//    registry/deck/buffer teardown, and `jobs.delete(batchId)` +
//    `clearBatchEntry(batchId)`. Delete those and 8b/8c go red — the batch
//    reaches `completed === size`, settles, and reports.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi } = makePi(w);
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  attachRpc(w);
  let threw = false;
  const buffersBefore = live.bufferCount();
  // The members' OWN signals. The cascade listener that installs each member's
  // abort is registered by the loop, so `memberAbort.signal.aborted` is the
  // cascade's only observable effect — which is exactly what a mutant that drops
  // `orchestratorAbort.abort()` must change.
  const memberSignals: AbortSignal[] = [];
  // `neverResolve`: the members' work does not settle on its own, so the ONLY
  // thing that can advance the orchestrator to `completed === size` is the abort
  // the cascade delivers. A mutant that drops `orchestratorAbort.abort()` leaves
  // the members pending forever and 8b/8c/8f go red together; a work function
  // that resolves by itself would mask that mutant entirely (measured).
  const settleOnAbort = (role: string) => (signal: AbortSignal) =>
    new Promise<DispatchResult>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          resolve(fakeResult(role, "", { ok: false, exitCode: null, killCause: "abort" }));
        },
        { once: true },
      );
    });
  try {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        {
          label: "explore[a]",
          role: "explore",
          work: (signal) => {
            memberSignals.push(signal);
            return settleOnAbort("explore")(signal);
          },
        },
        {
          label: "explore[b]",
          role: "explore",
          work: (signal) => {
            memberSignals.push(signal);
            return settleOnAbort("explore")(signal);
          },
        },
        {
          get label(): string {
            throw new Error("third member setup boom");
          },
          role: "explore",
          work: async () => fakeResult("explore", "never started"),
        },
      ],
    });
  } catch {
    threw = true;
  }
  // Long enough for every member's `.then/.finally` chain to have run.
  await new Promise((r) => setTimeout(r, 120));
  assert(threw, "8a: the partway setup throw surfaces to the caller");
  assert(
    sent(w).length === 0,
    `8b: the two members that completed settled no batch and left no pending slot (got ${sent(w)})`,
  );
  assert(
    w.reports.length === 0,
    `8c: no consolidated report for a batch whose setup threw (got ${JSON.stringify(w.reports.map((x) => x.slice(0, 60)))})`,
  );
  assert(
    live.bufferCount() === buffersBefore,
    `8d: the completed members' live buffers were released (baseline ${buffersBefore}, got ${live.bufferCount()})`,
  );
  assert(
    jobStatusSnapshot().every((j) => j.batchId === undefined),
    "8e: no batch-member row is left registered under the dead batch",
  );
  // The abort cascade, which is the part of the catch a test of THIS shape can
  // actually falsify: without `orchestratorAbort.abort()` two members that ran
  // to completion reach `completed === size`, the batch settles, and the PM gets
  // a consolidated report for a batch that never started. 8b/8c go red on the
  // mutant (verified), so the assertion is real rather than decorative.
  assert(
    memberSignals.every((signal) => signal.aborted),
    "8f: every started member was aborted through the orchestrator's cascade",
  );
}

// ---------------------------------------------------------------------------
// 9. The registration site is guarded against overwriting a handle that another
//    owner is still using.
//
//    `childHandles` is the one surface that OUTLIVES the `jobs` entry on the
//    PI_ENSEMBLE_QUIET_STATUS path, where `dispatchDeck.clearEntry` is a no-op:
//    a row can keep an id whose registry entry is gone, so an id drawn again
//    (`newJobId` is date-plus-six-random-base36) can land on a slot somebody
//    else still expects to be able to kill. An unguarded `set` there replaces
//    that owner's `kill` and leaves its child unabortable — with no error and
//    nothing in the log. So the write is conditional.
//
//    WHY THIS IS A SOURCE PIN AND NOT A BEHAVIOUR CASE: ESM imports are
//    read-only live bindings, so a test cannot reassign `newJobId` to force a
//    collision, and the guard is reachable only through one. A behaviour test
//    here would be an assertion about a stub, not about the product — the
//    earlier draft of this case was exactly that (its "collision" never
//    collided, and the assertions it emitted were satisfied by the map being
//    empty). The pin below is the honest version: it fails the moment the guard
//    is removed, which is the mutation it exists to catch. The two registration
//    sites are covered separately because they fail differently — the member's
//    own slot must not clobber a pre-existing entry, while `onStdin` MUST
//    overwrite (that is how a real stdin replaces the dead one) and preserves
//    the installed `kill` explicitly instead.
// ---------------------------------------------------------------------------
{
  const batchSource = await Bun.file(new URL("../src/async-jobs-batch.ts", import.meta.url)).text();
  assert(
    /if \(!childHandles\.has\(jobId\)\) \{\s*childHandles\.set\(jobId, \{/.test(batchSource),
    "9a: the member's handle registration refuses to overwrite an existing entry",
  );
  // The companion pin: `onStdin` still writes unconditionally, because a spawned
  // member's real stdin is supposed to replace the dead placeholder. If the
  // guard were lifted to cover that site too, members would keep a dead stdin
  // forever and `dispatch_steer` would write its RPC frames into nowhere.
  assert(
    /const previous = childHandles\.get\(jobId\);/.test(batchSource) &&
      /previous\?\.kill \? \{ kill: previous\.kill \}/.test(batchSource),
    "9b: the spawn-time registration still overwrites, and carries the installed kill forward",
  );
}

clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);
