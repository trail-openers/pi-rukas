#!/usr/bin/env bun
/**
 * Pool-width fixture for test-verify-loop-jobs-from-host.ts.
 *
 * Sleeps FIXTURE_WINDOW_MS and writes its own start/finish window (epoch ms,
 * tab-separated) to `$FIXTURE_WINDOW_DIR/<token>.tsv`. The caller sweeps the
 * records across the whole set to count peak overlap — i.e. the width the pool
 * ACTUALLY admitted. A wall-clock bound would pass on a fast host that
 * serialised and fail on a loaded one that did not.
 *
 * ONE FILE PER JOB, not one shared log: N copies of this fixture run
 * concurrently, `open(w)` truncates at open, and the pool hands every job the
 * SAME environment — so the only per-job discriminator available is the pid,
 * which is in the name below. A shared path would leave one record however wide
 * the pool ran, which reads exactly like "the pool never parallelised".
 *
 * Always exits 0: the assertion is the schedule, never the verdict.
 */
const dir = process.env.FIXTURE_WINDOW_DIR;
const ms = Number(process.env.FIXTURE_WINDOW_MS ?? "300");
if (!dir) {
  console.error("fixture-window: FIXTURE_WINDOW_DIR is required");
  process.exit(1);
}
const start = Date.now();
await Bun.sleep(Number.isFinite(ms) && ms > 0 ? ms : 300);
const end = Date.now();
await Bun.write(Bun.file(`${dir}/job-${process.pid}.tsv`), `${start}\t${end}\n`);
console.log("fixture-window: ok");
