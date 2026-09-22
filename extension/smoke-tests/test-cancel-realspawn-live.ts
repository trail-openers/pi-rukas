#!/usr/bin/env bun
/**
 * LIVE test: the two real-`pi` abort/timeout probes of the #809 work.
 *
 * Live test (issue #809): excluded from the offline verify gate
 * (verify-loop.sh and CI run `smoke-tests/test-*.ts` and skip `*-live.ts`).
 * CI does not install `pi`, and without the binary `spawnSpecialist` would
 * crash on an unhandled ENOENT `error` event — which is exactly why the old
 * wall-clock real-spawn sections (also glob-matched in CI) were fragile in
 * the wrong place. The deterministic fake-`pi` equivalents in test-cancel.ts
 * (tests 1–2) cover the same kill paths in every cycle at zero token cost.
 *
 * Why this file exists at all: it verifies the attribution assertion end to
 * end against a genuine Pi child (parent + child + provider round-trip, the
 * conditions in which the two 497s-vs-1500ms incidents — cycles #777, #798 —
 * occurred). It asserts the SEMANTIC outcome — that the kill was attributed
 * (killCause), not elapsed seconds — because the wall clock there is a
 * property of the machine (host sleep, up to 6 concurrent Pi children), not
 * of the abort path.
 *
 * Cost: two short-lived `pi` spawns (aborted at 1.5s / capped at 2s) of
 * real provider tokens — deliberately NOT run on every cycle (that spend
 * is why it is `-live.ts` rather than offline).
 * Run deliberately:
 *   cd extension && bun run smoke-tests/test-cancel-realspawn-live.ts
 *
 * The 50-iteration-under-load demonstration (before/after false-failure
 * rate) is `tmp/issue-809/measure-realspawn.ts` in the source repo.
 */

import {
  ABORT_PROMPT,
  runAbortProbe,
  runTimeoutProbe,
  TIMEOUT_PROMPT,
} from "./lib/test-cancel-probes.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Test 1 (real) — AbortSignal kills the child; the kill is ATTRIBUTED,
// independent of how long teardown took.
{
  console.log("[test] REAL explore child, abort after 1500ms...");
  const p = await runAbortProbe(ABORT_PROMPT);
  p.lines.forEach((l) => console.log(l));
  assert(p.ok, "aborted real child: killCause='abort' + ok=false");
}

// Test 2 (real) — the wall-clock cap kills the child and attributes it.
{
  console.log("\n[test] REAL explore child, 2000ms cap...");
  const p = await runTimeoutProbe(TIMEOUT_PROMPT);
  p.lines.forEach((l) => console.log(l));
  assert(p.ok, "timed-out real child: killCause='timeout' + ok=false");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
