#!/usr/bin/env bun
/**
 * Ceiling fixture for test-verify-loop-timing.ts (#2449) — a test that PASSES and
 * sits past the ceiling the case asks for, and is NOT named by the allow-list.
 *
 * It is the red arm of the AC1 pair: the run over it must exit 1, print
 * `CEILING: <secs>s <file> (ceiling <N>s)` on stderr, and name this file in the
 * `FAILED:` summary — a file that passed its own assertions and still fails the run.
 *
 * The duration comes from FIXTURE_CEILING_MS so the case can place it well clear of
 * the bound it asserts against: per-file times swing about ±50% with pool neighbours
 * and host load, so a fixture that slept 4 s against a 3 s ceiling can read 3 on a
 * loaded host. The case sleeps several multiples of its ceiling instead.
 *
 * It is a timer, not a busy wait. The clock this fixture is measured by is bash
 * `SECONDS`, so all the case needs is wall time the whole-second reading cannot
 * round below — and a spin loop held a core for every second of it while measuring
 * nothing but its own scheduler. A `Bun.sleep` costs the same elapsed time and none
 * of the CPU, which is what lets several of these fixtures share a host instead of
 * saturating it. The floor is still a wall clock read, so the lower bound holds.
 *
 * Its stdout is a CONSTANT. Case 8 of test-verify-timing-ceiling-channels.ts compares
 * two runs of this file byte for byte, so a line that carried the elapsed milliseconds
 * would make the channels differ by however the two waits happened to land — a diff in
 * the fixture's own prose, not in the loop's verdict stream.
 *
 * Always exits 0 — the point of the fixture is that its own verdict is a pass.
 */
const parsed = Number.parseInt(process.env.FIXTURE_CEILING_MS ?? "4000", 10);
const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : 4000;
await Bun.sleep(ms);
console.log("fixture-ceiling-over: passed");
