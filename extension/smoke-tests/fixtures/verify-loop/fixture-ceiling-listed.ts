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
 * The wait is a timer for the reason recorded in fixture-ceiling-over.ts: the loop's
 * clock is wall time, so a busy wait measured nothing extra and cost a core. Same
 * duration, same floor, no CPU. Its stdout is a constant for the same file's reason —
 * the AC1 pair prints the two fixtures' streams side by side, and elapsed milliseconds
 * in the line would vary between two runs of the same fixture.
 *
 * Always exits 0.
 */
const parsed = Number.parseInt(process.env.FIXTURE_CEILING_MS ?? "4000", 10);
const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : 4000;
await Bun.sleep(ms);
console.log("fixture-ceiling-listed: passed");
