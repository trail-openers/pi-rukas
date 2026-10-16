/**
 * #1389 — the headless pending-reports signal's shutdown semantics.
 *
 * Second of the three `pi-rukas-jobs` companions (test-pending-jobs-signal.ts is
 * the #1295 contract; -honest-zero.ts the failed-send paths;
 * -batch-teardown.ts the half-started batch), split by the 500-line cap
 * test-file-size-limit.ts enforces — the same split that earlier moved sections
 * 3/4 out of test-dispatch-deck-live.ts into
 * test-dispatch-deck-live-sync-throw.ts. All four drive the same channel; a fake
 * of their own would fail open on exactly the shutdown defect, because
 * shutdown() drops `ctx` and every publish after it is a silent no-op.
 *
 * Pinned here:
 *   1-2. `session_shutdown` does not publish "0" ahead of the reports it
 *        killed — the pre-#1389 handler cleared the Set and published "0"
 *        synchronously while the jobs it had just aborted were still settling
 *        (a developer report awaits its git-state line before the steer), then
 *        dropped `ctx`, so the report nobody received was also the last thing
 *        anyone could see. Now the publish is deferred for a bounded window
 *        (pendingShutdownBoundMs(), read from PI_ENSEMBLE_PENDING_SHUTDOWN_MS so
 *        these cases pin an outcome rather than race a sleep) and each report
 *        that still never landed is named on stderr.
 *   3.   The deferred arm belongs to the session that scheduled it — it cannot
 *        publish into a later one.
 *   4.   With nothing owed, shutdown publishes no redundant extra "0", and a
 *        release arriving after the channel closed is refused by name.
 *   5.   The bound is read inside shutdown() and clamped.
 *
 * The fakes are in lib/pending-jobs-harness.ts, shared with the honest-zero
 * file. No Pi process spawned, no network.
 */

import { registerAsyncJobsLifecycle } from "../src/async-jobs-lifecycle.ts";
import { clearJobsForTesting, startJob } from "../src/async-jobs.ts";
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
  warned,
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
// 1. Inside the bound: "0" waits for the report the abort still owes.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi, fireShutdown } = makePi(w);
  registerAsyncJobsLifecycle(pi);
  // Drain first. Earlier cases leave jobs whose work never reacts to `abort`,
  // and `shutdown()` aborts every job in the registry — including those, on
  // whatever host started them. `startJob`'s host is the module singleton's
  // `parentApi`, so a neighbour's settle would push its report into THIS case's
  // wire and its count into this channel. An assertion here must be about the
  // job this case started, so the registry has to start empty.
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  attachRpc(w);
  const { value: atHook, lines } = await withStderrCaptureAsync(async () => {
    startJob(pi, {
      label: "explore",
      role: "explore",
      work: (signal) =>
        new Promise<DispatchResult>((resolve) => {
          signal.addEventListener("abort", () => {
            void Promise.resolve().then(() =>
              resolve(fakeResult("explore", "", { ok: false, exitCode: null, killCause: "abort" })),
            );
          });
        }),
    });
    await until(() => sent(w).length >= 1);
    // The bound is read INSIDE shutdown(), so it must be set before the hook
    // fires, not merely before the case started.
    process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = "150";
    fireShutdown("quit");
    const at = sent(w).join(",");
    await until(() => sent(w).length >= 2);
    return at;
  });
  assert(atHook === "1", `1a: shutdown does not drop a job still owed (got ${atHook})`);
  assert(sent(w).join(",") === "1,0", `1b: "0" arrives once the owed report has (got ${sent(w)})`);
  // `w.reports` is deliberately NOT asserted here: startJob delivers through
  // `notifyAgent` -> `getParentExtensionApi()`, a MODULE SINGLETON set at
  // extension load (registry.ts `setParentExtensionApi`), not the `pi` this case
  // passed. A bare test process never sets it, so the late report is delivered
  // nowhere and a `w.reports` claim would be about the harness, not the product.
  // What the product guarantees is observable two ways: the channel stayed at
  // "1" until that report ran (1a/1b) and the release was accepted rather than
  // refused (1c below). The delivered text itself is pinned by the honest-zero
  // file, which drives a host of its own end to end.
  assert(
    !lines.some((l) => l.includes("late-settle") || l.includes("ignored report release")),
    `1c: the killed job's release was ACCEPTED, not refused as post-shutdown (got ${JSON.stringify(lines)})`,
  );
  assert(
    w.deliverAs.every((d) => d === "steer"),
    `1d: every send this case made was a steer (got ${JSON.stringify(w.deliverAs)})`,
  );
  // NOT `indexOf("0") > indexOf("1")` — `attach()` publishes "0" as the very
  // first frame, so that comparison is true whatever the product does. The
  // falsifiable form is the count of frames *after* the owed job was registered:
  // exactly one, the closing "0". A pre-fix shutdown published it synchronously
  // and 1a would already have caught that; this catches the other direction (a
  // second frame, or the arm firing after the release and publishing again).
  const afterOwed = w.statuses.slice(2);
  assert(
    afterOwed.join(",") === "0",
    `1e: exactly one frame follows the owed job, and it is the closing "0" (got ${afterOwed})`,
  );
  // `delete` is the correct "reset to unset": assigning undefined leaves the key
  // present with the string value "undefined", which the next case's parse would
  // read as a bound rather than as absent.
  // biome-ignore lint/performance/noDelete: unset is what this resets.
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 2. Past the bound: jobs whose work ignores `abort` must neither hold a
//    quitting session open nor strand the count above 0, and the reports they
//    never delivered are named on stderr — in ONE line, so a killed fan-out
//    does not print one WARN per child into the shutdown output.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi, fireShutdown } = makePi(w);
  registerAsyncJobsLifecycle(pi);
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  attachRpc(w);
  process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = "120";
  const { value: outcome, lines } = await withStderrCaptureAsync(async () => {
    const stuck = () => new Promise<DispatchResult>(() => undefined);
    startJob(pi, { label: "explore", role: "explore", work: stuck });
    startJob(pi, { label: "explore", role: "explore", work: stuck });
    startJob(pi, { label: "explore", role: "explore", work: stuck });
    await until(() => sent(w).length >= 3);
    const t0 = Date.now();
    fireShutdown("quit");
    const returnedMs = Date.now() - t0;
    const atHook = sent(w).join(",");
    await until(() => sent(w).length >= 4);
    return { atHook, returnedMs };
  });
  assert(outcome.atHook === "1,2,3", `2a: owed jobs hold the "0" back (got ${outcome.atHook})`);
  assert(
    outcome.returnedMs < 60,
    `2b: shutdown() returns without waiting on the stuck jobs (${outcome.returnedMs}ms)`,
  );
  assert(
    sent(w).join(",") === "1,2,3,0",
    `2c: the bound publishes "0" regardless (got ${sent(w)})`,
  );
  const neverArrived = lines.filter((l) => warned([l], "never arrived"));
  assert(
    neverArrived.length === 1,
    `2d: the killed reports are named in ONE line, not one per id (got ${neverArrived.length}: ${JSON.stringify(lines.slice(0, 4))})`,
  );
  assert(
    neverArrived[0]?.includes("3 report") === true,
    `2e: that line carries the count so an operator sees the scale (got ${neverArrived[0]})`,
  );
  // `delete` is the correct "reset to unset": assigning undefined leaves the key
  // present with the string value "undefined", which the next case's parse would
  // read as a bound rather than as absent.
  // biome-ignore lint/performance/noDelete: unset is what this resets.
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 3. A deferred arm belongs to the session that scheduled it.
//
//    (a) Re-entrant shutdown — Pi fires the hook on both the quit and reload
//        paths. The second call re-arms rather than leaving the first bound to
//        fire mid-teardown, and the closing frame arrives exactly once.
//    (b) An arm that is still in flight when a new session attaches must not
//        publish a stale "0" into the new channel, and a late settle for a job
//        the killed session owned must never re-open a count that session's
//        client already watched reach "0".
//
//    Waited out with real `await`s past each bound: the arm is deliberately
//    `unref`'d (a quitting session must not be held open by its own bookkeeping
//    timer), so a synchronous sleep would be a trap — an unref'd timer does not
//    run while the event loop is blocked, and the case would "pass" only
//    because the arm was never given the chance to fire.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi, fireShutdown } = makePi(w);
  registerAsyncJobsLifecycle(pi);
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  attachRpc(w);
  process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = "120";
  const { value } = await withStderrCaptureAsync(async () => {
    const stuck = () => new Promise<DispatchResult>(() => undefined);
    startJob(pi, { label: "explore", role: "explore", work: stuck });
    await until(() => sent(w).join(",") === "1");
    fireShutdown("quit");
    fireShutdown("quit");
    await until(() => sent(w).includes("0"));
    await new Promise((r) => setTimeout(r, 200));
    const afterReentrant = sent(w).join(",");

    // (b) An arm that is still in flight when the module is reset (a test
    // boundary, or a new session that attaches clean) must publish nothing at
    // all. This is the case that pre-fix could not be written: the old arm
    // cleared whatever Set existed and published through whatever `ctx` existed,
    // so a stale arm reaching a later channel printed "0" for work it did not
    // own — and with `ctx` already dropped, the reverse failure (a real "0"
    // swallowed) was equally invisible.
    const w3 = freshWire();
    const s3 = makePi(w3);
    registerAsyncJobsLifecycle(s3.pi);
    attachRpc(w3);
    startJob(s3.pi, { label: "explore", role: "explore", work: stuck });
    await until(() => sent(w3).join(",") === "1");
    fireShutdown("quit");
    pendingJobs.resetForTesting();
    const afterReset = sent(w3).join(",");
    await new Promise((r) => setTimeout(r, 220));
    return {
      afterReentrant,
      afterReset,
      finalReset: sent(w3).join(","),
      late3: w3.reports.length,
    };
  });
  assert(
    value.afterReentrant === "1,0",
    `3a: two shutdowns leave one owed job's count reaching "0" exactly once (got ${value.afterReentrant})`,
  );
  assert(
    value.afterReset === "1",
    `3b: the owed job still holds its own session's "0" back at the moment of reset (got ${value.afterReset})`,
  );
  assert(
    value.finalReset === "1",
    `3c: once the module is reset the expired arm publishes nothing at all (got ${value.finalReset})`,
  );
  assert(
    value.late3 === 0,
    `3d: and it handed no report to a channel its session no longer owns (got ${value.late3})`,
  );
  // `delete` is the correct "reset to unset": assigning undefined leaves the key
  // present with the string value "undefined", which the next case's parse would
  // read as a bound rather than as absent.
  // biome-ignore lint/performance/noDelete: unset is what this resets.
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 4. With nothing owed, shutdown publishes no redundant extra "0" (attach
//    already published the count the channel carries), and a release that
//    arrives after the channel closed is refused with a WARN naming the id
//    rather than silently resurrecting a count the client watched reach "0".
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  const { pi, fireShutdown } = makePi(w);
  registerAsyncJobsLifecycle(pi);
  attachRpc(w);
  const { value, lines } = await withStderrCaptureAsync(async () => {
    const before = sent(w).join(",");
    fireShutdown("quit");
    const after = sent(w).join(",");
    // A job opened, and a settle that lands, after the count closed: both
    // refused, and both say so by name.
    pendingJobs.jobPending("late-owe-id", "pm");
    await pendingJobs.releaseAfter("late-settle-id", async () => undefined);
    const afterLate = sent(w).join(",");
    return { before, after, afterLate };
  });
  assert(value.before === "", `4a: attach published its initial 0 only (got ${value.before})`);
  assert(
    value.after === "",
    `4b: shutdown with nothing owed publishes no redundant extra 0 (got ${value.after})`,
  );
  assert(
    value.afterLate === "",
    `4c: nothing re-opens the count once the channel is closed (got ${value.afterLate})`,
  );
  assert(
    warned(lines, "after shutdown") && lines.some((l) => l.includes("late-owe-id")),
    `4d: an owed report refused after the channel closed names the id (got ${JSON.stringify(lines)})`,
  );
  assert(
    lines.some((l) => l.startsWith("[pi-rukas] WARN") && l.includes("late-settle-id")),
    `4e: a release refused after the channel closed names the id it refused (got ${JSON.stringify(lines)})`,
  );
  pendingJobs.resetForTesting();
}

// ---------------------------------------------------------------------------
// 5. The bound is read inside shutdown(), not passed to it, and a runaway value
//    cannot make a quitting session schedule an absurd timer. Pinned against the
//    public reader so the clamp cannot silently disappear.
// ---------------------------------------------------------------------------
{
  const cases: Array<[string, number]> = [
    ["5000", 5000],
    ["45000", 30000],
    ["999999999", 30000],
    ["0", 0],
    ["-5", 1000],
    ["not-a-number", 1000],
  ];
  for (const [raw, expected] of cases) {
    process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS = raw;
    assert(
      pendingJobs.pendingShutdownBoundMs() === expected,
      `5: PI_ENSEMBLE_PENDING_SHUTDOWN_MS="${raw}" → ${expected}ms (got ${pendingJobs.pendingShutdownBoundMs()})`,
    );
  }
  // `delete` is the correct "reset to unset": assigning undefined leaves the key
  // present with the string value "undefined", which the next case's parse would
  // read as a bound rather than as absent.
  // biome-ignore lint/performance/noDelete: unset is what this resets.
  delete process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  const signalSource = await Bun.file(
    new URL("../src/pending-jobs-signal.ts", import.meta.url),
  ).text();
  assert(
    /export function shutdown\(\): void/.test(signalSource),
    "5z: shutdown() takes no settleMs parameter — the bound is the session's, not the caller's",
  );
  pendingJobs.resetForTesting();
}

clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);
