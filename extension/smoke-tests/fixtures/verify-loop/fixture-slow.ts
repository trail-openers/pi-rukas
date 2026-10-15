#!/usr/bin/env bun
// #1365 — a slow test that passes: sleeps FIXTURE_SLOW_MS (default 1000) and
// exits 0. test-verify-loop-parallel.ts uses it to show the job pool overlaps
// tests (wall-clock below the sum of the slow durations).
const ms = Number.parseInt(process.env.FIXTURE_SLOW_MS ?? "1000", 10);
console.log(`fixture-slow: sleeping ${ms}ms`);
await new Promise((resolve) => setTimeout(resolve, ms));
console.log("fixture-slow: ok");
