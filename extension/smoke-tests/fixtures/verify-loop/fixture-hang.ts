#!/usr/bin/env bun
// #1014 — a test that hangs: prints a couple of lines of partial output,
// then stays alive indefinitely (setInterval keeps the event loop open).
// The verify-loop per-test timeout (PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S,
// default 300s) is what kills it.
//
// The loop kills the whole process tree of the hung test, so the fixture
// also spawns a long-lived child (sleep) that must die with it — the
// "no orphan" case in test-verify-loop-timeout.ts checks for exactly this.
//
// FIXTURE_HANG_TOKEN (run-unique, set by test-verify-loop-timeout.ts) is
// baked into the child's command line so the orphan check can look for it
// by pattern rather than by pid (ps output can elide args, and the
// watchdog does not expose the child's pid).

import { spawn } from "node:child_process";

console.log("fixture-hang: starting, will hang until killed");
console.log("fixture-hang: pid", process.pid);

const token = process.env.FIXTURE_HANG_TOKEN ?? "hang-default";
// A non-numeric or non-positive bound would make `sleep` exit at once and the
// watchdog would have nothing to kill, turning the no-orphan case into a
// silent pass. Fall back to the 300s the fixture has always used.
const parsed = Number.parseInt(process.env.FIXTURE_HANG_S ?? "300", 10);
const hangSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 300;

// Spawn a long-lived child with the run-unique token in its command line
// so the no-orphan test can find it after the kill.
// #1365: GNU sleep rejects a second operand (`sleep 300 <token>` exits at once),
// so the token rides in a `sh -c` command line instead, and the sleep is its
// child. Both values are POSITIONAL ($1/$2), never interpolated: the token is
// caller-supplied text and this is a shell command line, so interpolation would
// hand the caller a way to run commands in the fixture.
spawn("sh", ["-c", 'sleep "$1"; : "$2"', "sh", String(hangSeconds), token], {
  stdio: "ignore",
});

// Keep alive indefinitely. The verify-loop watchdog must kill us.
setInterval(() => {}, 1000);
