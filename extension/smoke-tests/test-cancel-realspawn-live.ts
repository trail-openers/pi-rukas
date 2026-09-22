#!/usr/bin/env bun
/**
 * LIVE test: the two real-`pi` abort/timeout probes of the #809 work.
 *
 * Excluded from the offline verify gate (verify-loop.sh and CI run
 * `smoke-tests/test-*.ts` and skip `*-live.ts`). The wall-clock vs.
 * attribution rationale for why the real-spawn probes live here rather than
 * in test-cancel.ts is in test-cancel.ts's file header — this file is the
 * -live variant of that same design, kept deliberately out of the offline
 * suite because CI does not install `pi` and the two spawns cost real
 * provider tokens.
 *
 * Run deliberately:
 *   cd extension && bun run smoke-tests/test-cancel-realspawn-live.ts
 */

import {
  ABORT_PROMPT,
  TIMEOUT_PROMPT,
  runAbortProbe,
  runTimeoutProbe,
  assert as sharedAssert,
} from "./lib/test-cancel-probes.ts";

// This is the one file in the diff whose stated purpose is to spawn a REAL
// `pi` child. Without this flag, `spawnSpecialist` throws
// FORBID_LIVE_SPAWN on any host that has the offline anti-leak guard set
// (the documented mechanism to stop offline tests accidentally spawning real
// Pi) — matching test-lens-review-live.ts and test-pi-shape-live.ts.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";

let exit = 0;
function assert(cond: boolean, msg: string) {
  sharedAssert(cond, msg);
  if (!cond) exit = 1;
}

// Test 1 (real) — AbortSignal kills the child; the kill is ATTRIBUTED,
// independent of how long teardown took.
{
  console.log("[test] REAL explore child, abort after 1500ms...");
  const p = await runAbortProbe(ABORT_PROMPT);
  for (const l of p.lines) console.log(l);
  assert(p.ok, "aborted real child: killCause='abort' + ok=false");
}

// Test 2 (real) — the wall-clock cap kills the child and attributes it.
{
  console.log("\n[test] REAL explore child, 2000ms cap...");
  const p = await runTimeoutProbe(TIMEOUT_PROMPT);
  for (const l of p.lines) console.log(l);
  assert(p.ok, "timed-out real child: killCause='timeout' + ok=false");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
