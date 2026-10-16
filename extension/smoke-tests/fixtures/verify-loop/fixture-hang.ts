#!/usr/bin/env bun
// #1014 — a test that hangs: prints a couple of lines of partial output,
// then stays alive indefinitely (setInterval keeps the event loop open).
// The verify-loop per-test timeout (PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S,
// default 300s) is what kills it.
//
// The long-lived child below sleeps past the watchdog bound rather than a
// fixed 300s, so a test that lowers the bound to a couple of seconds still
// has a live descendant for the tree kill to find. Every caller of this
// fixture pins PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S.
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
// The fixture must outlive the watchdog, not merely be long: a child that
// exits before the bound leaves the watchdog nothing to kill, and the
// no-orphan case would pass on an already-empty process table. So the sleep
// is derived from the bound the caller set and sits 5s past it, rather than
// being a constant that only happens to exceed the default 300s.
//
// A non-numeric, non-positive, or absent bound falls back to 300 + 5 — the
// original constant — so a bad value can never produce `sleep 0`, which would
// exit at once and turn the no-orphan case into a silent pass again.
// A digit string of its own, not `Number.isFinite(parseInt(x))`: `parseInt`
// accepts a leading sign, so "-5" would otherwise reach `sleep` as a negative
// count. It also does not accept whitespace, so it cannot silently truncate.
function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
const watchdogBound = positiveInt(process.env.PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S) ?? 300;
// An explicit FIXTURE_HANG_S still wins (a test that wants a specific child
// lifetime), but it is validated the same way — a junk value must not become
// `sleep NaN` or `sleep 0`.
const hangSeconds = positiveInt(process.env.FIXTURE_HANG_S) ?? watchdogBound + 5;

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
