#!/usr/bin/env bun
/**
 * #1389 — the source pins and the stand-in-refused shape, split out of
 * test-pending-jobs-signal-honest-zero.ts for the 500-line cap that
 * test-file-size-limit.ts enforces. Same fakes (lib/pending-jobs-harness.ts),
 * same ticket, same rule: no Pi process, no network.
 *
 * Two things here that the main file cannot carry:
 *
 *   7c. The last honest word. When the host refuses BOTH the report and its
 *       stand-in, the count still has to reach 0 (a bound that never prints is
 *       worse than an honest 0), so the only thing left is the "handed Pi
 *       NOTHING" WARN naming the batch.
 *   8.  The source pins. `deliverReport` answers its own caller, so a
 *       process-wide failure tally is not merely unused — it is the wrong shape,
 *       and it came back twice as a convenience before it was pinned away.
 */

import { type DispatchHost, deliverReport } from "../src/async-jobs-lifecycle.ts";
import { clearJobsForTesting, startBatch } from "../src/async-jobs.ts";
import * as pendingJobs from "../src/pending-jobs-signal.ts";
import { clearSlowWatchesForTesting } from "../src/slow-notice.ts";
import {
  attachRpc,
  fakeResult,
  freshWire,
  makePi,
  sent,
  startStderrTap,
  until,
  waitWarn,
  warned,
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
// 7c. The same shape when even the stand-in is refused: the count still reaches
//     0 (a bound that never prints is worse than an honest 0), so the ONLY thing
//     left is the "handed Pi NOTHING" line — and it names the batch. Delete the
//     `if (!standInLanded)` block in async-jobs-batch.ts and 7c-b goes red while
//     7c-a/c stay green: that is the silent drop this closes.
// ---------------------------------------------------------------------------
{
  const w = freshWire();
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  // The formatter throws, so the batch report is never attempted: the ONLY call
  // the host receives is the stand-in, and index 1 rejects it.
  const { pi } = makePi(w, [1]);
  attachRpc(w);
  const tap = startStderrTap();
  try {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        {
          label: "explore[a]",
          role: "explore",
          work: async () =>
            Object.defineProperty(fakeResult("explore", "a"), "usage", {
              get() {
                throw new Error("usage unreadable");
              },
            }),
        },
      ],
    });
    await until(() => w.rejectedAt.length >= 1);
    await until(() => sent(w).length >= 2);
    await waitWarn(tap, "handed Pi NOTHING");
  } finally {
    tap.stop();
  }
  const lines = tap.lines;
  assert(w.reports.length === 0, "7c-a: nothing reached the host at all");
  const honest = lines.find((l) => l.includes("handed Pi NOTHING"));
  assert(
    honest !== undefined && /batch/.test(honest) && /reach 0|reaches 0|will reach 0/.test(honest),
    `7c-b: the count reaching 0 with nothing delivered is contradicted on stderr, naming the batch (got ${JSON.stringify(lines)})`,
  );
  assert(
    sent(w).join(",") === "1,0",
    `7c-c: and the count still releases — the WARN is what makes it honest, not a brake (got ${sent(w)})`,
  );
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
  // The delivery half split out of async-jobs-batch.ts for the size cap; both
  // files are the batch, and the pins below are about the send, so they read the
  // pair. A pin on the wrong one of the two would pass with the code deleted.
  const batchSource =
    (await Bun.file(new URL("../src/async-jobs-batch.ts", import.meta.url)).text()) +
    (await Bun.file(new URL("../src/async-jobs-batch-delivery.ts", import.meta.url)).text());
  assert(
    !/getFailedNotices|sendSucceeded|DeliveryTally/.test(batchSource),
    "8b: the batch reads its send's result, not a counter delta",
  );
  // The bracket itself, not just the earlier global-counter version of it: a
  // `getNotices()` read on either side of the send is the same category error
  // (an out-of-band tally answering a question this call already answers), so
  // the batch must not read the notice counter at all.
  assert(
    !/getNotices|notice-counter/.test(batchSource),
    "8f: the batch's send outcome is its send's return value, never a notice-counter bracket",
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
  // #1389: the host can only ever produce two answers, and the union says so. The
  // third member, `"never"`, is not a host answer — it is the pre-send initialiser
  // and the name for "this batch's host was never asked", which is what a
  // formatter that threw leaves behind. It is deliberately distinguishable from
  // BOTH host answers: the pre-fix bug was a `"not-attempted"` the tail tested
  // only with `=== "rejected"`, so a send that never RAN and one that DELIVERED
  // collapsed into the same answer.
  assert(
    /type BatchSendState = "sent" \| "rejected" \| "never";/.test(batchSource),
    '8d: the batch\'s send state names the two answers its host can produce, plus an explicit "never"',
  );
  assert(
    !/"not-attempted"/.test(batchSource),
    '8g: no placeholder state stands in for a send that never ran — "never" is named and read, not a default nobody tests',
  );
  // The union member has to be consulted, or it is decoration: the tail branches
  // on it, so a report that was never sent cannot be reported as one the host
  // refused — the PM acts differently on those two.
  assert(
    /sendState\.value === "never"/.test(batchSource),
    '8h: the tail reads "never" as its own case rather than folding it into "rejected"',
  );
  const host: DispatchHost = { sendUserMessage: () => undefined };
  assert(deliverReport(host, "x") === true, "8e: an accepting host reports true");
}

clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);
clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);
