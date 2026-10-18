#!/usr/bin/env bun
// #1404 — canary fixture for the out-of-band report channel's scrub.
//
// `VERIFY_REPORT_FILE` is the path the loop writes its own verdict to. A test
// that could read it could write a report of its own — which is the forgery the
// channel exists to make impossible — so verify-kill.sh starts every test under
// `env -u VERIFY_REPORT_FILE`. This fixture prints what the CHILD sees, exactly
// as fixture-spawn-env.ts does for the live-spawn guard, so the canary case in
// test-verify-loop.ts asserts BOTH directions: "1"/a path when the gate hands it
// through (the bug) and "(unset)" when the scrub is intact. Written as output,
// never as a write to the path — a fixture that wrote the file would be the
// forger, and the test would pass for the wrong reason.
console.log(`REPORT=${process.env.VERIFY_REPORT_FILE ?? "(unset)"}`);
