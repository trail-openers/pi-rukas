#!/usr/bin/env bun
/**
 * Ceiling fixture for test-verify-loop-timing.ts (#2449) — a test that PASSES and
 * sits past the ceiling the case asks for, and is NOT named by the allow-list.
 *
 * It is the red arm of the AC1 pair: the run over it must exit 1, print
 * `CEILING: <secs>s <file> (ceiling <N>s)` on stderr, and name this file in the
 * `FAILED:` summary — a file that passed its own assertions and still fails the run.
 *
 * The sleep is a busy wait rather than a timer, and the duration comes from
 * FIXTURE_CEILING_MS so the case can place it well clear of the bound it asserts
 * against: per-file times swing about ±50% with pool neighbours and host load, so
 * a fixture that slept 4 s against a 3 s ceiling can read 3 on a loaded host. The
 * case sleeps several multiples of its ceiling instead.
 *
 * Always exits 0 — the point of the fixture is that its own verdict is a pass.
 */
const parsed = Number.parseInt(process.env.FIXTURE_CEILING_MS ?? "4000", 10);
const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : 4000;
const started = Date.now();
while (Date.now() - started < ms) {
  /* busy wait: a duration the loop's whole-second clock can see */
}
console.log(`fixture-ceiling-over: passed after ${ms}ms`);
