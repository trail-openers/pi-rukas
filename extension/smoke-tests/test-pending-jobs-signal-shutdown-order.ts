#!/usr/bin/env bun
/**
 * #1389 — session_shutdown must not publish "0" ahead of the reports it killed.
 *
 * The third of the three #1389 defects, split from test-pending-jobs-signal.ts
 * (and its honest-zero companion) by the 500-line cap test-file-size-limit.ts
 * enforces — the same split that earlier moved sections 3/4 out of
 * test-dispatch-deck-live.ts into test-dispatch-deck-live-sync-throw.ts. All
 * three files drive the same `pi-rukas-jobs` channel; a fake of their own would
 * fail open on exactly this defect, because shutdown() drops `ctx` and every
 * publish after it is a silent no-op.
 *
 * The pre-#1389 handler cleared the pending Set and published "0" synchronously
 * — while the jobs it had just aborted were still settling (a developer report
 * awaits its git-state line before the steer) — and dropped `ctx`, so the
 * report nobody received was also the last thing anyone could see. `shutdown()`
 * now defers that publish for a bounded window (SHUTDOWN_SETTLE_MS, overridable
 * via PI_ENSEMBLE_PENDING_SHUTDOWN_MS so these cases pin an outcome rather than
 * race a sleep), then publishes unconditionally and records each still-owed id
 * as never-arrived. The bound is what keeps a job that ignores `abort` from
 * holding a quitting session open.
 *
 * No Pi process spawned, no network.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsyncJobsLifecycle } from "../src/async-jobs-lifecycle.ts";
import { clearJobsForTesting, jobStatusSnapshot, startBatch, startJob } from "../src/async-jobs.ts";
import * as live from "../src/dispatch-deck-live.ts";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import * as pendingJobs from "../src/pending-jobs-signal.ts";
import { clearSlowWatchesForTesting } from "../src/slow-notice.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Everything the fake host and the status channel would have shown. */
interface Wire {
  reports: string[];
  statuses: string[];
}

function freshWire(): Wire {
  return { reports: [], statuses: [] };
}

/** attach() publishes an initial "0"; every "<n>" assertion counts past it. */
const sent = (w: Wire) => w.statuses.slice(1);

/** A host that accepts everything it is given, and records what it received. */
function makeHost(w: Wire): DispatchHostLike {
  return {
    sendUserMessage(text: string) {
      w.reports.push(text);
    },
  };
}
type DispatchHostLike = { sendUserMessage(text: string): void };

function attachRpc(w: Wire) {
  pendingJobs.attach({
    mode: "rpc",
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        if (key === pendingJobs.PENDING_JOBS_STATUS_KEY) w.statuses.push(text ?? "");
      },
    },
  } as never);
}

function fakeResult(role: string, text: string): DispatchResult {
  return {
    role,
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  } as DispatchResult;
}

/** A `pi` double for the batch paths: accepts every send, ignores `on`. */
function batchHost(w: Wire): ExtensionAPI {
  return {
    sendUserMessage(text: string) {
      w.reports.push(text);
    },
    on: () => {},
  } as unknown as ExtensionAPI;
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

async function withStderrCaptureAsync<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), lines };
  } finally {
    process.stderr.write = real;
  }
}

/** A fake pi carrying `on` so the real session_shutdown hook can be fired. */
function makeShutdownPi(host: DispatchHostLike): {
  pi: ExtensionAPI;
  fire: (reason?: string) => void;
} {
  let hook: ((event?: { reason?: string }) => void) | undefined;
  const pi = {
    ...host,
    on: (_event: string, handler: (event?: { reason?: string }) => void) => {
      hook = handler;
    },
  } as unknown as ExtensionAPI;
  registerAsyncJobsLifecycle(pi);
  return { pi, fire: (reason?: string) => hook?.({ reason: reason ?? "quit" }) };
}

// ---------------------------------------------------------------------------
// 1. Inside the bound: "0" waits for the report the abort
//    still owes. The pre-#1389 code cleared the Set and published "0"
//    synchronously, ahead of the aborted job's async settle (a developer report
//    awaits its git-state line first) — and then dropped `ctx`, so the report
//    nobody saw was also the last thing anyone could see.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi, fire } = makeShutdownPi(makeHost(w));
  attachRpc(w);
  process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = "150";
  // Abort resolves the work, but the settle's report path is async — so the
  // report is genuinely still owed at the moment the hook runs.
  const { value: atHook } = await withStderrCaptureAsync(async () => {
    startJob(pi, {
      label: "explore",
      role: "explore",
      work: (signal) =>
        new Promise<DispatchResult>((resolve) => {
          signal.addEventListener("abort", () => {
            void Promise.resolve().then(() =>
              resolve({
                role: "explore",
                ok: false,
                text: "",
                toolUses: [],
                ms: 1,
                exitCode: null,
                killCause: "abort",
              } as DispatchResult),
            );
          });
        }),
    });
    await until(() => sent(w).length >= 1);
    fire();
    const at = sent(w).join(",");
    await until(() => sent(w).length >= 2);
    return at;
  });
  assert(atHook === "1", `8a: shutdown does not drop a job still owed (got ${atHook})`);
  assert(sent(w).join(",") === "1,0", `8b: "0" arrives once the owed report has (got ${sent(w)})`);
  assert(
    w.reports.length === 1 && w.reports[0]?.startsWith("[ensemble:async]"),
    `8c: the killed job's late report reaches the host, not the bin (got ${JSON.stringify(w.reports.map((r) => r.slice(0, 40)))})`,
  );
  assert(
    w.reports.length > 0,
    "8d: the report exists on the wire before the count released its slot",
  );
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 2. Past the bound: a job whose work ignores `abort` must
//    neither hold a quitting session open nor strand the count above 0, and the
//    report it never delivered is named on stderr.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi, fire } = makeShutdownPi(makeHost(w));
  attachRpc(w);
  process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = "120";
  const { value: outcome, lines } = await withStderrCaptureAsync(async () => {
    startJob(pi, {
      label: "explore",
      role: "explore",
      work: () => new Promise<DispatchResult>(() => undefined),
    });
    await until(() => sent(w).length >= 1);
    const t0 = Date.now();
    fire();
    const returnedMs = Date.now() - t0;
    const atHook = sent(w).join(",");
    await until(() => sent(w).length >= 2);
    return { atHook, returnedMs };
  });
  assert(outcome.atHook === "1", `9a: the stuck job holds the "0" back (got ${outcome.atHook})`);
  assert(
    outcome.returnedMs < 60,
    `9b: shutdown() returns without waiting on the stuck job (${outcome.returnedMs}ms)`,
  );
  assert(sent(w).join(",") === "1,0", `9c: the bound publishes "0" regardless (got ${sent(w)})`);
  assert(
    lines.some((l) => l.includes("never arrived") && l.startsWith("[pi-rukas] WARN")),
    `9d: the report that never landed is named, ungated by PI_ENSEMBLE_DEBUG (got ${JSON.stringify(lines.slice(0, 2))})`,
  );
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 8. A batch whose member setup throws partway removes the members it started.
//     #1389: the abort alone left the started member in the registry
//     (dispatch_status reporting a slot in flight, killAllJobs counting a child
//     that was gone), in the deck, and in the live buffers — and
//     dispatch-deck-confirm.ts opens a live view for any key that still has a
//     buffer, so a leaked buffer is a user-visible empty view, not a
//     bookkeeping nit. Asserted BEFORE the next test boundary:
//     clearJobsForTesting()/reset() drain these maps wholesale, so an assertion
//     after the next case would pass with no cleanup code at all.
//     reporting a slot in flight, killAllJobs counting a child that was gone), in
//     the deck, and in the live buffers — and dispatch-deck-confirm.ts will open
//     a live view for any key that still has a buffer, so a leaked buffer is a
//     user-visible empty view, not a bookkeeping nit. Asserted BEFORE the next
//     test boundary: clearJobsForTesting()/reset() drain these maps wholesale, so
//     an assertion after the next case would pass with no cleanup code at all.
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
  try {
    startBatch(batchHost(w), {
      batchLabel: "dispatch_parallel",
      members: [
        {
          label: "explore[a]-half-started",
          role: "explore",
          work: (signal, hooks) => {
            firstSignal = signal;
            // The handle a real spawn registers: the cleanup must clear
            // childHandles too, not just `jobs`.
            hooks.onStdin({} as never);
            firstStdinRegistered = true;
            firstJobId = hooks.jobId;
            observedBatchId = hooks.jobId.split("-")[0] ?? "";
            hooks.onProgress({
              role: "explore",
              turns: 1,
              totalTokens: 0,
              lastText: "",
              elapsedMs: 10,
            } as never);
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
  assert(threw, "a partway batch setup throw surfaces to the caller");
  assert(firstSignal?.aborted === true, "the already-started member is aborted");
  assert(
    firstStdinRegistered && firstJobId !== "" && observedBatchId !== "",
    "the started member registered a handle, so both ids are known to assert on",
  );
  const leaked = jobStatusSnapshot().filter(
    (r) => r.jobId === firstJobId || r.jobId === observedBatchId,
  );
  assert(
    leaked.length === 0,
    `the started member and the orchestrator are gone from the registry (got ${leaked.map((r) => r.jobId)})`,
  );
  assert(
    dispatchDeck.snapshot().length === deckBefore &&
      dispatchDeck.batchSnapshot().length === batchDeckBefore,
    "no deck row (member or batch) survives the failed setup",
  );
  assert(live.bufferCount() === buffersBefore, "no live buffer survives the failed setup");
  assert(!live.hasBuffer(firstJobId), "the started member's live buffer is released");
  // The member's work promise never reacts to abort; its .finally must not
  // settle a batch the caller was already told about. Let any microtask run.
  await new Promise((r) => setTimeout(r, 30));
  assert(
    w.reports.length === 0 && sent(w).length === 0,
    `a half-started batch owes nothing (got ${JSON.stringify(w.reports.concat(w.statuses.map((s) => `status:${s}`)))})`,
  );
}

clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);
