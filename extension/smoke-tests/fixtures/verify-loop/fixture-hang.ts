#!/usr/bin/env bun
// #1014 — a test that hangs: prints a couple of lines of partial output,
// then stays alive indefinitely (setInterval keeps the event loop open).
// The verify-loop per-test timeout (PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S,
// default 300s) is what kills it.
//
// The loop kills the whole process tree of the hung test, so the fixture
// also spawns a long-lived child (sleep) that must die with it — the
// "no orphan" case in test-verify-loop.ts checks for exactly this.
//
// FIXTURE_HANG_TOKEN (run-unique, set by test-verify-loop.ts) is baked into
// the child's command line so the orphan check can look for it by pattern
// rather than by pid — the fixture writes its own child's pid to
// FIXTURE_HANG_PID_FILE so the test can also check it directly, but the
// token is the reliable cross-check (ps output can elide args).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

console.log("fixture-hang: starting, will hang until killed");
console.log("fixture-hang: pid", process.pid);

const token = process.env.FIXTURE_HANG_TOKEN ?? "hang-default";
const hangSeconds = parseInt(process.env.FIXTURE_HANG_S ?? "300", 10);

// Spawn a long-lived child with the run-unique token in its command line
// so the no-orphan test can find it after the kill.
const child = spawn("sleep", [String(hangSeconds), token], { stdio: "ignore" });
if (process.env.FIXTURE_HANG_PID_FILE) {
  try {
    writeFileSync(process.env.FIXTURE_HANG_PID_FILE, String(child.pid));
  } catch {
    // best-effort — the token check is the load-bearing assertion
  }
}

// Keep alive indefinitely. The verify-loop watchdog must kill us.
setInterval(() => {}, 1000);
