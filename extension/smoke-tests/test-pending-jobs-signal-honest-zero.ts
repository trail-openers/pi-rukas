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
 *   1. `deliverReport` caught a throwing host and returned nothing a caller
 *      could see. Pi makes that swallow total: the `ExtensionAPI` binding routes
 *      a rejection from `AgentSession.prompt` to `runner.emitError`
 *      (agent-message.ts), so the throw never reaches a caller's try/catch
 *      either. It now RETURNS whether the send survived, leaves an
 *      unconditional WARN, and the batch answers a rejection with a stand-in.
 *   2. `deliverBatchReport` set `delivered = true` after `send()` returned —
 *      and `send()` calls `deliverReport`, which cannot throw — so a host that
 *      rejected the batch's one steer still counted as delivered, the
 *      unannotated fallback never fired, and the batch dropped to "0".
 *   3. The notice badge incremented before the send, so the live view advertised
 *      a delivery nobody received.
 *
 * The fakes are in lib/pending-jobs-harness.ts, shared with
 * test-pending-jobs-signal-shutdown-order.ts. No Pi process spawned, no network.
 */

import {
  type DispatchHost,
  deliverOrStandIn,
  deliverReport,
  deliverStandIn,
} from "../src/async-jobs-lifecycle.ts";
import { clearJobsForTesting, startBatch, startJob } from "../src/async-jobs.ts";
import { getNotices } from "../src/notice-counter.ts";
import * as pendingJobs from "../src/pending-jobs-signal.ts";
import { clearSlowWatchesForTesting } from "../src/slow-notice.ts";
import {
  attachRpc,
  fakeResult,
  freshWire,
  makeHost,
  makePi,
  sent,
  until,
  warned,
  withStderrCapture,
  withStderrCaptureAsync,
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
// 1. deliverReport: a throwing host is a failed send, not a silent success.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const host = makeHost(w, [1]);
  const noticesBefore = getNotices();
  const { lines } = withStderrCapture(() => {
    // The return value IS the contract #1389 added: the caller learns the
    // outcome of the send it made, with no counter and no exception.
    return deliverReport(host, "the report");
  });
  assert(w.reports.length === 0, "1a: a throwing host received nothing");
  assert(
    getNotices() - noticesBefore === 1,
    "1b: the attempted delivery still counts for the badge (the send was attempted)",
  );
  assert(
    warned(lines, "async report delivery failed:"),
    `1c: the failed send is a WARN on stderr, not a PI_ENSEMBLE_DEBUG-gated trace (got ${JSON.stringify(lines)})`,
  );
  assert(w.deliverAs[0] === "steer", `1d: the send is a steer (got ${w.deliverAs[0]})`);
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
    warned(lines, "probe report failed:"),
    `2c: the build failure is a WARN, not a debug trace (got ${JSON.stringify(lines)})`,
  );
  assert(
    warned(lines, "stand-in report also failed:"),
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
  const { pi, fireShutdown } = makePi(w, [1]);
  attachRpc(w);
  const { value, lines } = await withStderrCaptureAsync(async () => {
    const h = startJob(pi, {
      label: "explore",
      role: "explore",
      work: async () => fakeResult("explore", "done"),
    });
    await until(() => sent(w).length >= 2);
    return h.jobId;
  });
  assert(
    w.reports.length === 0 && w.rejectedAt.length === 1,
    "3a: the one report was rejected by the host",
  );
  assert(
    sent(w).join(",") === "1,0",
    `3b: the count still reaches 0 — a stuck count would be the other bug (got ${sent(w)})`,
  );
  assert(
    warned(lines, "async report delivery failed:"),
    `3c: the dropped report left a named, unconditional trace the operator can act on (job ${value})`,
  );
  fireShutdown();
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 4. Batch: a rejected send must NOT count as delivered. Pre-#1389 `delivered`
//    went true on the swallowed failure, the fallback never fired, and the
//    batch published "0" having handed over nothing.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi } = makePi(w, [1]);
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
  assert(
    w.threwAt.length >= 1 && w.rejectedAt.length >= 1,
    "4a: the batch's send was attempted and the host rejected it",
  );
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
    warned(lines, "report delivery rejected by the host"),
    "4e: the rejected batch report is named on stderr, ungated by PI_ENSEMBLE_DEBUG",
  );
  assert(
    !standIn.includes("could not be built"),
    "4f: a delivery failure does not claim the members' results were lost (they ran — only the send failed)",
  );
  assert(
    w.deliverAs.every((d) => d === "steer"),
    `4g: both the batch report and its stand-in were steers (got ${JSON.stringify(w.deliverAs)})`,
  );
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 5. Exactly one delivery per batch: the annotated send that landed must not be
//    followed by a fallback or a stand-in.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  // No `throwOn`: this host accepts every send, so `rejectedAt` must stay empty.
  const { pi } = makePi(w);
  // Drain first. Every earlier case leaves jobs whose work never reacts to
  // `abort`, and their slow-run watches stay armed in slow-notice's module Map:
  // `makeSlowWatch` closes over the `pi` that started the job, so an armed watch
  // reaching the wire is another deliverer writing into THIS case's host — and
  // 5a/5b are exactly the "nothing else touched the wire" claims. Same reason
  // test-agent-view and the slow-notice suites drain between cases.
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  attachRpc(w);
  const control = await withStderrCaptureAsync(async () => {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        { label: "explore[a]", role: "explore", work: async () => fakeResult("explore", "a") },
      ],
    });
    // ONE send, accepted: the batch's consolidated report. `sent()` is
    // `reports.length`, so waiting on it is waiting for the delivery to succeed —
    // the earlier `sent(w).length >= 2` could never be satisfied by a healthy
    // batch (there is exactly one), so the predicate timed out and 5a/5b were
    // reading a control case that had not finished.
    await until(() => w.threwAt.length >= 1);
  });
  // The capture returns `{ value, lines }`, so the healthy-batch control asserts on
  // `lines` being empty — comparing the whole result to "" was true-by-shape and
  // false-by-type, i.e. an assertion that could never report what it saw.
  assert(
    control.lines.length === 0,
    `5d: a healthy batch is silent on stderr (got ${JSON.stringify(control.lines)})`,
  );
  assert(
    w.rejectedAt.length === 0 && w.threwAt.length === 1,
    `5a: the control host was called once and threw nothing (calls ${w.threwAt}, rejections ${w.rejectedAt})`,
  );
  assert(
    w.reports.length === 1 && w.reports[0]?.startsWith("[ensemble:async]"),
    `5b: a healthy batch sends exactly one report (got ${w.reports.length})`,
  );
  assert(sent(w).join(",") === "1,0", `5c: healthy batch → 1,0 (got ${sent(w)})`);
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 5b. Report AND stand-in both rejected: the count still has to reach 0 (a bound
//     that would never print is worse than an honest 0), so the ONLY thing left
//     to say is the WARN — and it must name the batch, so an operator staring at
//     "0" in a session that received nothing can find why. Delete the
//     `if (!standInLanded)` block in async-jobs-batch.ts and 5b-c goes red: the
//     count prints 0 and stderr says nothing that distinguishes it from a clean
//     delivery.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  // Reject every call the batch makes: index 1 is the consolidated report, index
  // 2 the stand-in. `until` on rejectedAt rather than reports — nothing lands.
  const { pi } = makePi(w, [1, 2]);
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  attachRpc(w);
  const cap = await withStderrCaptureAsync(async () => {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        { label: "explore[a]", role: "explore", work: async () => fakeResult("explore", "a") },
      ],
    });
    await until(() => w.rejectedAt.length >= 2);
  });
  assert(w.reports.length === 0, "5b-a: nothing reached the host");
  assert(
    w.rejectedAt.length >= 2,
    `5b-b: both the report and its stand-in were rejected (got ${w.rejectedAt})`,
  );
  const honest = cap.lines.find((l) => l.includes("handed Pi NOTHING"));
  assert(
    honest !== undefined &&
      /mvba|batch/.test(honest) &&
      /reach 0|reaches 0|will reach 0/.test(honest),
    `5b-c: the count reaching 0 with nothing delivered is contradicted on stderr, naming the batch (got ${JSON.stringify(cap.lines)})`,
  );
  // The count is only observable through the status frames, so the assertion is
  // on the LAST frame the host saw rather than an accessor the module does not
  // export: "0" printed anyway is the point — the WARN is what makes it honest.
  assert(
    w.statuses.at(-1) === "0",
    `5b-d: the count still releases — a bound that never prints is worse than an honest 0 (got ${JSON.stringify(w.statuses)})`,
  );
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
  const { pi } = makePi(w, [1]);
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
//    The hook is registered for real through registerAsyncJobsLifecycle against
//    this host, so the ordering the fix depends on is the production ordering.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { registerAsyncJobsLifecycle } = await import("../src/async-jobs-lifecycle.ts");
  const { pi, fireShutdown } = makePi(w, [1]);
  registerAsyncJobsLifecycle(pi);
  attachRpc(w);
  process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = "150";
  const { lines } = await withStderrCaptureAsync(async () => {
    startJob(pi, {
      label: "explore",
      role: "explore",
      work: async () => fakeResult("explore", "late"),
    });
    await until(() => sent(w).length >= 1);
    fireShutdown("quit");
    // The late settle's send throws inside the bound; the bound must still close.
    await until(() => sent(w).length >= 2);
  });
  assert(w.reports.length === 0, "7a: the report never reached the host");
  assert(
    sent(w).join(",") === "1,0",
    `7b: a failed late send does not strand the count above 0 (got ${sent(w)})`,
  );
  assert(
    warned(lines, "async report delivery failed:"),
    `7c: the session still learns the report was lost (got ${JSON.stringify(lines.slice(0, 3))})`,
  );
  // `delete` is the correct "reset to unset": assigning undefined leaves the key
  // present with the string value "undefined", which the next case's parse would
  // read as a bound rather than as absent.
  // biome-ignore lint/performance/noDelete: unset is what this resets.
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 8. The two globals #1389 first reached for are gone. `deliverReport` answers
//    its own caller, so a second process-wide failure counter is not merely
//    unused — it is the wrong shape: a counter another deliverer moved would be
//    read as this send's verdict. Pinned so it cannot come back as a convenience.
// ---------------------------------------------------------------------------
{
  const source = await Bun.file(new URL("../src/notice-counter.ts", import.meta.url)).text();
  assert(
    !/failedCount|getFailedNotices|incrementFailedNotice/.test(source),
    "8a: notice-counter.ts carries no failed-delivery tally",
  );
  const batchSource = await Bun.file(new URL("../src/async-jobs-batch.ts", import.meta.url)).text();
  assert(
    !/getFailedNotices|sendSucceeded|DeliveryTally/.test(batchSource),
    "8b: the batch reads its send's result, not a counter delta",
  );
  const lifecycleSource = await Bun.file(
    new URL("../src/async-jobs-lifecycle.ts", import.meta.url),
  ).text();
  assert(
    /export function deliverReport\(host: DispatchHost, report: string\): boolean/.test(
      lifecycleSource,
    ),
    "8c: deliverReport returns its outcome",
  );
  // And the batch's own send state is a named union, not a tri-state boolean.
  assert(
    /type BatchSendState = "sent" \| "rejected" \| "not-attempted"/.test(batchSource),
    "8d: the batch's send state is the named three-valued union",
  );
  const host: DispatchHost = { sendUserMessage: () => undefined };
  assert(deliverReport(host, "x") === true, "8e: an accepting host reports true");
}

clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);
