#!/usr/bin/env bun
// #1365 — a slow test that passes: sleeps FIXTURE_SLOW_MS (default 1000) and
// exits 0. test-verify-loop-parallel.ts uses it to show the job pool overlaps
// tests (wall-clock below the sum of the slow durations).
//
// A NaN or negative FIXTURE_SLOW_MS would make the fixture exit at once, and
// the overlap assertion would then pass on three no-op tests instead of three
// slow ones. Anything unusable falls back to the 1000ms default.
const parsed = Number.parseInt(process.env.FIXTURE_SLOW_MS ?? "1000", 10);
const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
console.log(`fixture-slow: sleeping ${ms}ms`);
await new Promise((resolve) => setTimeout(resolve, ms));
console.log("fixture-slow: ok");
