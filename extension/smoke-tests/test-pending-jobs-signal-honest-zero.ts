#!/usr/bin/env bun
/**
 * #1389 — an honest "0": no path publishes the headless pending-reports count
 * as zero for a report that was never handed to Pi.
 *
 * The companion to test-pending-jobs-signal.ts, which reached the 500-line cap
 * (test-file-size-limit.ts) before these cases could be added. The three
 * swallowed-failure branches this pins had NO offline coverage anywhere: none
 * of the four trace strings appeared in a single smoke test, and no test in the
 * repo drove a host whose `sendUserMessage` throws.
 *
 *   1. `deliverReport` caught a throwing host and did nothing a caller could
 *      see. Pi makes that swallow total: the `ExtensionAPI` binding routes a
 *      rejection from `AgentSession.prompt` to `runner.emitError`
 *      (agent-message.ts), so the throw never reaches a caller's try/catch
 *      either. A failed send now leaves an unconditional WARN and a failure
 *      tally, and the batch answers it with a stand-in.
 *   2. `deliverBatchReport` set `delivered = true` after `send()` returned —
 *      and `send()` calls `deliverReport`, which cannot throw — so a host that
 *      rejected the batch's one steer still counted as delivered, the
 *      unannotated fallback never fired, and the batch dropped to "0".
 *   3. The notice badge incremented before the send, so the live view advertised
 *      a delivery nobody received.
 *
 * No Pi process spawned, no network.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type DispatchHost,
  deliverOrStandIn,
  deliverReport,
  deliverStandIn,
} from "../src/async-jobs-lifecycle.ts";
import { clearJobsForTesting, jobStatusSnapshot, startBatch, startJob } from "../src/async-jobs.ts";
import * as live from "../src/dispatch-deck-live.ts";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import { getFailedNotices, getNotices } from "../src/notice-counter.ts";
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
  warns: string[];
  threwAt: number[];
}

/** `makeHost` restarts its call counter, so failures are recorded per wire. */
let currentWire: Wire = freshWire();

function freshWire(): Wire {
  return { reports: [], statuses: [], warns: [], threwAt: [] };
}

/**
 * A host whose `sendUserMessage` throws on the `throwOn`-indexed call (or on
 * every call when `throwOn` is omitted). Pi swallows the real rejection from
 * the caller, so the test's own record of "this call threw" is the honest
 * ground truth the product-side assertions are compared against.
 */
function makeHost(w: Wire, throwOn?: number[]): DispatchHost {
  currentWire = w;
  let calls = 0;
  return {
    sendUserMessage(text: string) {
      calls += 1;
      if (!throwOn || throwOn.includes(calls)) {
        w.threwAt.push(calls);
        throw new Error(`host rejected call ${calls}`);
      }
      w.reports.push(text);
    },
  };
}

/** A `pi` double for the batch paths: accepts every send, ignores `on`. */
function batchHost(w: Wire): ExtensionAPI {
  return { ...makeHost(w), on: () => {} } as unknown as ExtensionAPI;
}

function withStderrCapture<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), lines };
  } finally {
    process.stderr.write = real;
  }
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

function fakeResult(
  role: string,
  text: string,
  extra: Partial<DispatchResult> = {},
): DispatchResult {
  return {
    role,
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    ...extra,
  };
}

/** attach() publishes an initial "0"; every "<n>" assertion below counts past it. */
const sent = (w: Wire) => w.statuses.slice(1);

async function until(cond: () => boolean) {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

function attachRpc(w: Wire) {
  currentWire = w;
  pendingJobs.attach({
    mode: "rpc",
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        if (key === pendingJobs.PENDING_JOBS_STATUS_KEY) w.statuses.push(text ?? "");
      },
    },
  } as never);
}

// ---------------------------------------------------------------------------
// 1. deliverReport: a throwing host is a failed send, not a silent success.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host = makeHost(w, [1]);
  const noticesBefore = getNotices();
  const failedBefore = getFailedNotices();
  const { lines } = withStderrCapture(() => deliverReport(host, "the report"));
  assert(w.reports.length === 0, "1a: a throwing host received nothing");
  assert(
    getNotices() - noticesBefore === 1,
    "1b: the attempted delivery still counts for the badge (the send was attempted)",
  );
  assert(
    getFailedNotices() - failedBefore === 1,
    "1c: the failure is tallied separately from the badge, so a caller can tell the two apart",
  );
  assert(
    lines.some(
      (l) => l.includes("async report delivery failed:") && l.startsWith("[pi-rukas] WARN"),
    ),
    `1d: the failed send is a WARN on stderr, not a PI_ENSEMBLE_DEBUG-gated trace (got ${JSON.stringify(lines)})`,
  );
}

// ---------------------------------------------------------------------------
// 2. The wrappers stay non-throwing, and their fault lines are unconditional.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host = makeHost(w);
  let threw = false;
  const { lines } = withStderrCapture(() => {
    try {
      deliverStandIn(host, "probe", new Error("original"), () => {
        throw new Error("stand-in boom");
      });
      deliverOrStandIn(
        host,
        "probe",
        () => {
          throw new Error("build boom");
        },
        () => {
          throw new Error("stand-in boom");
        },
      );
    } catch {
      threw = true;
    }
  });
  assert(!threw, "2a: deliverStandIn / deliverOrStandIn still never throw");
  assert(w.reports.length === 0, "2b: nothing reached the host");
  assert(
    lines.some((l) => l.startsWith("[pi-rukas] WARN") && l.includes("probe report failed:")),
    `2c: the build failure is a WARN, not a debug trace (got ${JSON.stringify(lines)})`,
  );
  assert(
    lines.some(
      (l) => l.startsWith("[pi-rukas] WARN") && l.includes("stand-in report also failed:"),
    ),
    "2d: a stand-in that also failed is a WARN naming both errors",
  );
}

// ---------------------------------------------------------------------------
// 3. Single PM job: the count reaches 0, and the failed send is not passed off
//    as a delivered report. The job's settle cannot be rescued (its result is
//    built and sent once), so the honesty here is that the failure SAYS so.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host = makeHost(w, [1]);
  const pi = { ...host, on: () => {} } as unknown as ExtensionAPI;
  attachRpc(w);
  const { value: jobId, lines } = await withStderrCaptureAsync(async () => {
    const h = startJob(pi, {
      label: "explore",
      role: "explore",
      work: async () => fakeResult("explore", "done"),
    });
    await until(() => sent(w).length >= 2);
    return h.jobId;
  });
  assert(
    w.reports.length === 0 && w.threwAt.length === 1,
    "3a: the one report was rejected by the host",
  );
  assert(
    sent(w).join(",") === "1,0",
    `3b: the count still reaches 0 — a stuck count would be the other bug (got ${sent(w)})`,
  );
  assert(
    lines.some(
      (l) => l.includes("async report delivery failed:") && l.startsWith("[pi-rukas] WARN"),
    ),
    `3c: the dropped report left a named, unconditional trace the operator can act on (job ${jobId})`,
  );
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 4. Batch: a rejected send must NOT count as delivered. Pre-#1389 `delivered`
//    went true on the swallowed failure, the fallback never fired, and the
//    batch published "0" having handed over nothing.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host = makeHost(w, [1]);
  const pi = { ...host, on: () => {} } as unknown as ExtensionAPI;
  attachRpc(w);
  const { value: batch, lines } = await withStderrCaptureAsync(async () => {
    const b = startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        { label: "explore[a]", role: "explore", work: async () => fakeResult("explore", "a") },
        { label: "explore[b]", role: "explore", work: async () => fakeResult("explore", "b") },
      ],
    });
    await until(() => sent(w).length >= 2);
    return b;
  });
  assert(w.threwAt.length >= 1, "4a: the batch's send was attempted and the host rejected it");
  assert(
    w.reports.some((r) => r.includes("(batch ") && r.includes("could not be delivered")),
    `4b: the batch answers a failed send with a stand-in naming the batch, not silence (got ${JSON.stringify(w.reports)})`,
  );
  assert(
    sent(w).join(",") === "1,0",
    `4c: the batch's count drops to 0 only once something was handed over (got ${sent(w)})`,
  );
  const standIn = w.reports.find((r) => r.includes("could not be delivered")) ?? "";
  assert(
    sent(w).length === 2 && w.reports.length > 0,
    "4d: at least one message reached the host before the count released",
  );
  assert(
    lines.some(
      (l) => l.startsWith("[pi-rukas] WARN") && l.includes("report delivery rejected by the host"),
    ),
    "4e: the rejected batch report is named on stderr, ungated by PI_ENSEMBLE_DEBUG",
  );
  assert(
    !standIn.includes("could not be built"),
    "4f: a delivery failure does not claim the members' results were lost (they ran — only the send failed)",
  );
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 5. Exactly one delivery per batch: the annotated send that landed must not be
//    followed by a fallback or a stand-in.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host: DispatchHost = {
    // No `throwOn`: this host never rejects — so anything landing in `threwAt`
    // here was thrown by some other deliverer sharing the wire, which is a bug
    // in the test harness, not in the product.
    sendUserMessage: (text: string) => {
      currentWire.reports.push(text);
    },
  };
  const pi = { ...host, on: () => {} } as unknown as ExtensionAPI;
  attachRpc(w);
  await withStderrCaptureAsync(async () => {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        { label: "explore[a]", role: "explore", work: async () => fakeResult("explore", "a") },
      ],
    });
    await until(() => sent(w).length >= 2);
  });
  assert(w.threwAt.length === 0, "5a: nothing threw in the control case");
  assert(
    w.reports.length === 1 && w.reports[0]?.startsWith("[ensemble:async]"),
    `5b: a healthy batch sends exactly one report (got ${w.reports.length})`,
  );
  assert(sent(w).join(",") === "1,0", `5c: healthy batch → 1,0 (got ${sent(w)})`);
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 6. The falsifiable form of "a report was handed over": the wire-ordered
//    assertion the old test used (report strictly before the last "0") must be
//    UNSATISFIABLE when zero reports were delivered. That is what stops a
//    zero-report pass from reading as compliance.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host = makeHost(w, [1]);
  const pi = { ...host, on: () => {} } as unknown as ExtensionAPI;
  attachRpc(w);
  await withStderrCaptureAsync(async () => {
    startJob(pi, {
      label: "explore",
      role: "explore",
      work: async () => fakeResult("explore", "x"),
    });
    await until(() => sent(w).length >= 2);
  });
  const delivered = w.reports[0];
  const claimWasHandedOver =
    delivered !== undefined && sent(w).length > 0 && sent(w)[sent(w).length - 1] === "0";
  assert(
    !claimWasHandedOver,
    "6a: zero reports delivered can never satisfy a delivered-before-0 claim",
  );
  assert(sent(w).join(",") === "1,0", `6b: and yet the count is not left stuck (got ${sent(w)})`);
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 7. Shutdown with a report still owed whose send THEN fails: the bound must
//    close the channel, not leave it open on a report that will never arrive.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host = makeHost(w, [1]);
  const pi = { ...host, on: () => {} } as unknown as ExtensionAPI;
  let shutdownHandler: ((event?: { reason?: string }) => void) | undefined;
  (pi as unknown as { on: (e: string, h: (ev?: { reason?: string }) => void) => void }).on(
    "session_shutdown",
    (ev) => shutdownHandler?.(ev),
  );
  // The hook is registered through the lifecycle module, which needs the real
  // registration path: re-register against this host.
  const registered = [] as Array<(event?: { reason?: string }) => void>;
  const pi2 = {
    ...host,
    on: (_event: string, handler: (event?: { reason?: string }) => void) => {
      registered.push(handler);
    },
  } as unknown as ExtensionAPI;
  const { registerAsyncJobsLifecycle } = await import("../src/async-jobs-lifecycle.ts");
  registerAsyncJobsLifecycle(pi2);
  attachRpc(w);
  process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = "150";
  const { lines } = await withStderrCaptureAsync(async () => {
    startJob(pi2, {
      label: "explore",
      role: "explore",
      work: async () => fakeResult("explore", "late"),
    });
    await until(() => sent(w).length >= 1);
    registered[0]?.({ reason: "quit" });
    // The late settle's send throws inside the bound; the bound must still close.
    await until(() => sent(w).length >= 2);
  });
  assert(w.reports.length === 0, "7a: the report never reached the host");
  assert(
    sent(w).join(",") === "1,0",
    `7b: a failed late send does not strand the count above 0 (got ${sent(w)})`,
  );
  assert(
    lines.some(
      (l) => l.includes("async report delivery failed:") && l.startsWith("[pi-rukas] WARN"),
    ),
    `7c: the session still learns the report was lost (got ${JSON.stringify(lines.slice(0, 3))})`,
  );
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  pendingJobs.resetForTesting();
}

clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);
