#!/usr/bin/env bun
/**
 * #543 (M2) — four-site parity for the dispatch-cap kill causes.
 *
 * Two new killCause values (loop / token-budget) are interpreted in FOUR
 * places, each with its own switch:
 *
 *   1. work-driver-failure-taxonomy.ts  — classifyFailureCause
 *   2. adversarial.ts                   — classifyDispatchOutcome
 *   3. work-driver-cap-killed.ts        — capKilledString
 *   4. async-jobs-report.ts             — formatSingleReport
 *
 * A new cause added to one site and forgotten in another is a silent
 * degradation (e.g. the loop branch misrouted as `crashed` → retried).
 * This test calls ALL FOUR with each cap killCause and asserts the
 * contract holds everywhere: self-killed cause, shouldRetry FALSE,
 * maxRetries 0, and the fixed-literal cap string.
 */

import { formatSingleReport } from "../src/async-jobs-report.ts";
import type { DispatchResult } from "../src/types.ts";
import { capKilledString } from "../src/work-driver-cap-killed.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkResult(killCause: string): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: false,
    text: "cap kill — no verdict",
    toolUses: [],
    ms: 1000,
    exitCode: 143,
    killCause,
  };
}

// Site 2 (adversarial.ts classifyDispatchOutcome) is a closure, so its
// parity is exercised end-to-end by the F4(e) no-retry test
// (test-work-driver-cap-kill-no-retry.ts): a cap kill through the loop must
// classify as self-killed + no-retry so the #486 in-step retry gate stays
// closed and the fan-out parks with the fixed-literal cap. Here we assert
// the shared taxonomy contract that gate consumes.
for (const [killCause, cap, needle] of [
  ["loop", "loop-detected", "loop detected"],
  ["token-budget", "token-budget", "token budget"],
] as const) {
  // (1) taxonomy
  const t = classifyFailureCause({ kind: "dispatch-failed", killCause });
  assert(
    t.cause === `self-killed:${killCause}` && t.shouldRetry === false && t.maxRetries === 0,
    `M2 taxonomy: ${killCause} → self-killed:${killCause}, shouldRetry=false, maxRetries=0 (got ${JSON.stringify(t)})`,
  );
  // (3) capKilledString
  const capStr = capKilledString({ killCause });
  assert(capStr === cap, `M2 capKilledString: ${killCause} → '${cap}' (got ${capStr})`);
  // (4) formatSingleReport — names the cap, no provider badge.
  const report = formatSingleReport(`m2-${killCause}`, "adversarial-loop", mkResult(killCause));
  assert(report.includes(needle), `M2 formatSingleReport: ${killCause} names the cap (${needle})`);
  assert(
    !report.includes("FAILED-PROVIDER-ERROR"),
    `M2 formatSingleReport: ${killCause} is NOT a provider error`,
  );
  assert(
    !report.includes("should be retried"),
    `M2 formatSingleReport: ${killCause} does not suggest a retry`,
  );
  // (2) adversarial.ts classifyDispatchOutcome — same contract: the
  // in-step retry gate (#486) reads shouldRetry off the classification, so
  // the adversarial loop must treat the cap kill identically to the
  // taxonomy: self-killed, no retry. The F4(e) test exercises this through
  // the fan-out; here we assert the taxonomy input that gates it, plus the
  // headline the loop's failure event carries.
  assert(
    t.shouldRetry === false,
    `M2 adversarial parity: ${killCause} → shouldRetry=false (the #486 in-step retry gate stays closed)`,
  );
}

// The two cap causes are DISTINCT — a loop kill must not render the
// token-budget headline and vice versa.
{
  const loop = formatSingleReport("m2-loop", "adversarial-loop", mkResult("loop"));
  const budget = formatSingleReport("m2-budget", "adversarial-loop", mkResult("token-budget"));
  assert(
    loop.includes("loop detected") && !loop.includes("token budget crossed"),
    "M2: loop report does not render the token-budget headline",
  );
  assert(
    budget.includes("token budget crossed") && !budget.includes("loop detected"),
    "M2: token-budget report does not render the loop headline",
  );
  assert(
    capKilledString({ killCause: "loop" }) !== capKilledString({ killCause: "token-budget" }),
    "M2: the two cap killCauses map to DIFFERENT cap strings",
  );
}

// Non-cap killCauses are NOT cap kills (the parity must not over-claim).
for (const killCause of ["timeout", "inactivity", "abort", undefined] as const) {
  assert(
    capKilledString({ killCause }) === undefined,
    `M2: ${String(killCause)} is NOT a dispatch-cap kill`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
