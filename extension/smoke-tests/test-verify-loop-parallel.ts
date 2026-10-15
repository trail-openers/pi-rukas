#!/usr/bin/env bun
/**
 * Issue #1365 — verify-loop: bounded job pool (PI_ENSEMBLE_VERIFY_TEST_JOBS).
 *
 * Runs smoke-tests/lib/verify-loop.sh over a fixture set holding a passing
 * test, a failing test, a timing-out test (short watchdog bound) and slow
 * passing tests, through the same runLoopEnv seam as test-verify-loop.ts.
 *
 * Cases:
 *   1. Digest output and exit code are identical at JOBS=1 and JOBS=3.
 *   2. Normal-mode output is identical at JOBS=1 and JOBS=3, and FAILED
 *      markers keep argument order (the timed-out test is listed before the
 *      failing one, even though it finishes later).
 *   3. The timed-out test's process tree is gone after the run (no orphan).
 *   4. JOBS=3 wall-clock is below the sum of the slow tests' durations.
 *   5. SIGTERM during a run exits promptly (143) and leaves no job process.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { runLoopEnv } from "./verify-loop-lib.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const LOOP = path.join(__dirname, "lib", "verify-loop.sh");
const FIXTURES = path.join(__dirname, "fixtures", "verify-loop");
const SLOW = path.join(FIXTURES, "fixture-slow.ts");
const HANG = path.join(FIXTURES, "fixture-hang.ts");
const FAIL = path.join(FIXTURES, "fixture-1.ts");
const PASS = path.join(FIXTURES, "allpass-a.ts");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Unique per run: the hang fixture bakes it into its orphan `sleep` command line.
const token = `parallel-hang-${process.pid}-${Date.now()}`;
const mixedEnv = (jobs: number): Record<string, string> => ({
  PI_ENSEMBLE_VERIFY_TEST_JOBS: String(jobs),
  PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "3",
  FIXTURE_SLOW_MS: "1000",
  FIXTURE_HANG_TOKEN: token,
});
// Slow first, then the hang, so JOBS=3 has a slow test running beside it.
const mixedFiles = [SLOW, HANG, PASS, FAIL, SLOW];

// --- Case 1: digest identical across JOBS=1 and JOBS=3.
const digest1 = runLoopEnv(["--digest", ...mixedFiles], mixedEnv(1));
const digest3 = runLoopEnv(["--digest", ...mixedFiles], mixedEnv(3));
assert(digest1.status === 1, "case 1: digest run exits 1 with failures (JOBS=1)");
assert(
  digest3.status === digest1.status,
  `case 1: exit code matches JOBS=1 (got ${digest3.status}, want ${digest1.status})`,
);
assert(
  digest3.stdout === digest1.stdout,
  "case 1: digest output is byte-identical at JOBS=1 and JOBS=3",
);
assert(digest3.stdout.includes("P: 3  F: 2"), "case 1: digest tally is P: 3  F: 2");
assert(
  digest3.stdout.includes("FAILED: ") && digest3.stdout.includes(path.basename(HANG)),
  "case 1: digest names the timed-out test",
);

// --- Case 2: normal-mode output identical, and FAILED markers in argument order.
const normal1 = runLoopEnv(mixedFiles, mixedEnv(1));
const normal3 = runLoopEnv(mixedFiles, mixedEnv(3));
// The hang fixture prints its own pid, which differs between runs; mask it.
const unpid = (s: string) => s.replace(/pid \d+/g, "pid N");
assert(
  unpid(normal3.stdout) === unpid(normal1.stdout) && normal3.status === normal1.status,
  "case 2: normal-mode output and exit code identical at JOBS=1 and JOBS=3",
);
const markers = normal3.stdout.split("\n").filter((l) => l.startsWith("FAILED: "));
const summaryIdx = markers.findIndex((l) => l.includes("test(s)"));
const perTest = summaryIdx === -1 ? markers : markers.slice(0, summaryIdx);
assert(
  perTest.length === 2 &&
    perTest[0].includes(path.basename(HANG)) &&
    perTest[1].includes(path.basename(FAIL)),
  `case 2: per-test FAILED markers keep argument order (got ${JSON.stringify(perTest)})`,
);

// --- Case 3: no orphan of the timed-out test survives the run.
const orphans = spawnSync("pgrep", ["-f", token], { encoding: "utf-8" });
assert(orphans.status !== 0, "case 3: no process of the timed-out test survives");

// --- Case 4: JOBS=3 overlaps slow tests (wall-clock below their summed duration).
const slowOnly = [SLOW, SLOW, SLOW];
const t0 = Date.now();
const timed = runLoopEnv(slowOnly, {
  PI_ENSEMBLE_VERIFY_TEST_JOBS: "3",
  PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "10",
  FIXTURE_SLOW_MS: "2000",
});
const wall = (Date.now() - t0) / 1000;
const sumSlow = 3 * 2;
assert(timed.status === 0, "case 4: three slow passing tests exit 0 at JOBS=3");
assert(
  wall < sumSlow,
  `case 4: JOBS=3 wall-clock ${wall.toFixed(1)}s is below the slow-test sum ${sumSlow}s`,
);

// --- Case 5: SIGTERM mid-run interrupts the pool.
// The hang fixture keeps two jobs alive, so the interrupt lands while jobs
// are running. The interrupt path must return within 10s even though the
// watchdog bound is 60s, and must take the hung bun processes with it.
const interruptToken = `parallel-interrupt-${process.pid}-${Date.now()}`;
const child = spawn("bash", [LOOP, HANG, HANG], {
  cwd: path.join(__dirname, ".."),
  env: {
    ...process.env,
    PI_ENSEMBLE_VERIFY_TEST_JOBS: "2",
    PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "60",
    FIXTURE_HANG_TOKEN: interruptToken,
  },
  stdio: "ignore",
});
const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
  child.on("close", (code, signal) => resolve({ code, signal }));
});
await new Promise((resolve) => setTimeout(resolve, 1500));
child.kill("SIGTERM");
const deadline = new Promise<null>((resolve) => {
  setTimeout(() => resolve(null), 10_000);
});
const settled = await Promise.race([closed, deadline]);
if (settled === null) {
  child.kill("SIGKILL");
  assert(false, "case 5: loop exits within 10s of SIGTERM");
} else {
  assert(
    settled.code === 143 || settled.signal === "SIGTERM",
    `case 5: loop exits with 143/SIGTERM (got code ${settled.code}, signal ${settled.signal})`,
  );
}
// The job trees must be gone; pgrep can lag a fraction behind the close event.
let orphansAfterInterrupt = "";
for (let i = 0; i < 30; i++) {
  const probe = spawnSync("pgrep", ["-f", interruptToken], { encoding: "utf-8" });
  if (probe.status !== 0) {
    orphansAfterInterrupt = "";
    break;
  }
  orphansAfterInterrupt = probe.stdout.trim();
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert(
  orphansAfterInterrupt === "",
  `case 5: no process of the interrupted jobs survives (got ${JSON.stringify(orphansAfterInterrupt)})`,
);

process.exit(exit);
