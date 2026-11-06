#!/usr/bin/env bun
/**
 * #2042 — an excuse is never built on a head re-run that observed nothing.
 *
 * `confirmTierRedFrom` already refuses to call a killed, timed-out, overflowed or
 * un-startable re-run a flake, so the tier's first red stands. The BASELINE EXCUSE
 * sits one arm later and reads that same re-run's OUTPUT to decide which tests the
 * head failed — and a run that observed nothing still prints text (the executor's
 * own kill or `ENOENT` message), which can name the very tests the base printed.
 * Grade it there and a tier nobody saw fail twice becomes a green excused over the
 * base commit, which is the outcome this step exists to refuse.
 *
 * One arm decides it: the guard is `tierObserved` on the re-run, and these four
 * shapes are what `tierObserved` says `false` for. Each must stay RED, and must
 * never be graded green nor excused into a record.
 */
import { rmSync } from "node:fs";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { killedRerun, overflowedRerun, unstartedRerun } from "./lib/lean-verify-rerun.ts";
import { PASS_TIER, pytestFailTier } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC10-baseline-excuse-unobserved.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const NAMES = ["tests/x_test.py::test_a", "tests/x_test.py::test_b"];
/** Both runs name the SAME tests — the shape that earns an excuse when both saw the work. */
const STREAM = NAMES.map((n) => `FAILED ${n} - AssertionError`).join("\n");

/** A re-run that never ran: the executor's kill / overflow / ENOENT shapes. */
const UNOBSERVED: Record<string, unknown> = {
  killed: killedRerun(STREAM),
  overflow: overflowedRerun(STREAM),
  neverStarted: unstartedRerun(),
};

for (const [shape, reject] of Object.entries(UNOBSERVED)) {
  const r = await runVerify({
    issue: 611,
    implement: true,
    config: { fast: PASS_TIER },
    // The full tier is the tier under test; `fast` passes so the case isolates one
    // tier's re-run rather than the first red the step stops on.
    full: pytestFailTier("preexisting", NAMES),
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: STREAM,
    headTierOutput: STREAM,
    headRerunRejects: reject,
  } as never);
  const record = (r.outcome as { preexistingFailures?: Record<string, unknown> } | undefined)
    ?.preexistingFailures;
  assert(
    r.outcome?.kind === "red",
    `(${shape}) an unobserved re-run keeps today's red, not an excused green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 120)})`,
  );
  assert(
    record === undefined || record["full"] === undefined,
    `(${shape}) the unobserved tier is not excused, so its record is absent (${JSON.stringify(record?.["full"] ?? null)})`,
  );
}

// The positive control: the same two streams, on a re-run that really ran and
// really went red, still earn the excuse. Without it the guard above could pass by
// simply refusing every excuse.
{
  const r = await runVerify({
    issue: 612,
    implement: true,
    config: { fast: PASS_TIER },
    full: pytestFailTier("preexisting", NAMES),
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: STREAM,
    headTierOutput: STREAM,
  } as never);
  assert(
    r.outcome?.kind === "green",
    `(observed) a re-run that ran red at HEAD still excuses (${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 120)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
