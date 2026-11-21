#!/usr/bin/env bun
/**
 * Ceiling fixture for test-verify-loop-timing.ts (#2449) — the same shape as
 * fixture-ceiling-over.ts, but named by the committed allow-list under a key the
 * case writes into `TIMING_ALLOWLIST`.
 *
 * It is the green arm of the AC1 pair: at the same ceiling and the same duration
 * the run must exit 0 and print no `CEILING:` line for it. What the pair pins is
 * that the exemption is what changed between the two verdicts — the duration, the
 * knob and the fixture body are the same on both sides.
 *
 * It is committed rather than generated because the exemption key is a path, and a
 * generated name exempts nothing until its entry exists; a committed file lets the
 * entry be data the allow-list gate can also check for existence.
 *
 * Always exits 0.
 */
const parsed = Number.parseInt(process.env.FIXTURE_CEILING_MS ?? "4000", 10);
const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : 4000;
const started = Date.now();
while (Date.now() - started < ms) {
  /* busy wait: a duration the loop's whole-second clock can see */
}
console.log(`fixture-ceiling-listed: passed after ${ms}ms`);
