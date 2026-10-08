#!/usr/bin/env bun
// #1014 — a hanging test that ALSO records each invocation to a counter file
// (the FIXTURE_COUNTER_FILE pattern from fixture-counter.ts), so the
// exactly-once case can assert the watchdog does not re-run a timed-out test.
//
// Appends one line on each invocation, then hangs indefinitely (setInterval
// keeps the event loop open). The verify-loop per-test timeout is what kills
// it; the counter file must contain exactly one line after the run.

import { appendFileSync } from "node:fs";

const counterFile = process.env.FIXTURE_COUNTER_FILE ?? "/tmp/verify-loop-hang-counter";
appendFileSync(counterFile, "1\n");

console.log("fixture-hang-counter: starting, will hang until killed");
setInterval(() => {}, 1000);
