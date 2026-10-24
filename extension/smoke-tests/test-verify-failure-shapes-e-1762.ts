#!/usr/bin/env bun
/**
 * #1762 round 2 — the deps-hint half of the failure-line table, split out of
 * `test-verify-failure-shapes-1762.ts` along the seam AGENTS.md §12 draws (the
 * suite had grown past the cap). The table suite asks what a line IS; this one
 * asks what the harness wrote around it.
 */

import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  harnessInnerLine,
  isSuccessLine,
} from "../src/work-driver-verify-failures.ts";
import { depsHintStartFor } from "../src/work-driver-verify-inner-line.ts";
import { depsHintApplies } from "../src/work-driver-verify-record.ts";
import { formatExecError } from "../src/work-driver-verify-develop-helpers.ts";
import { CHECKS_BLOCK, CMD, WT, makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 2e. the deps hint is never chosen as the gate's stream ─────────────────
// `provisionDepsHint` is appended to the harness's own sentence, BEFORE
// `formatExecError` appends the gate's tail, and the `hook-failed` shape
// contains a `: ` of its own (`… during provisioning: <problem>`). Cutting at
// that colon quotes the harness's own diagnosis as the gate's output — the
// #1667 suppression, backwards: a line the driver wrote becomes evidence and
// `depsHintApplies` then keeps a hint it exists to suppress.
{
  const HINT_PROBLEM = "Cannot find module 'react' in node_modules";
  const hinted = (tail: string): string =>
    `verify command \`${CMD}\` failed in ${WT} — the \`.pi/worktree-setup\` hook failed during provisioning: ${HINT_PROBLEM}${tail}`;
  assert(
    depsHintStartFor(hinted("")) !== undefined,
    "deps hint: the hint's start is found in the composed wrapper",
  );
  assert(
    classifyFailureLine(hinted("\nnothing to see here")) === undefined,
    `deps hint: a hint whose problem text looks like a failure is not classified as one (got ${JSON.stringify(classifyFailureLine(hinted("\nnothing to see here")))})`,
  );
  assert(
    depsHintApplies(hinted("\nnothing to see here")) === true,
    "deps hint: the hint still applies when the gate printed nothing assertable",
  );
  // …and the real gate line beneath the hint is still reached — excluding the
  // hint must not swallow the builder's own separator, which sits right after
  // the hint's colon.
  assert(
    classifyFailureLine(hinted(`\n${CHECKS_BLOCK}`))?.shape === "script-tally",
    `deps hint: the gate's own line beneath the hint still classifies (got ${JSON.stringify(classifyFailureLine(hinted(`\n${CHECKS_BLOCK}`)))})`,
  );
}

// ── 2f. a pathological single line costs a constant, not the square ────────
// The classifier is quadratic in line length: the wrapper prefix's lazy `.+?`
// backtracks once per `: ` it finds and the tally branches' `[^\r\n]*` does the
// same. A gate that prints a serialized fixture on one line used to cost
// seconds per line, and a whole suite of them stops the gate. The scan window
// makes the cost of one line constant.
{
  const huge = `${"x".repeat(1200)}: `.repeat(1500); // 200 KB, 1500 `: ` candidates
  const started = Date.now();
  const got = classifyFailureLine(huge);
  const ms = Date.now() - started;
  assert(got === undefined, `bound: a 200 KB line of separators classifies as nothing`);
  assert(
    ms < 500,
    `bound: a 200 KB single line classifies in under 500 ms (took ${ms} ms; window ${FAILURE_LINE_SCAN_MAX})`,
  );
  assert(
    FAILURE_LINE_SCAN_MAX === 8 * 1024,
    `bound: the scan window is the exported 8 KiB (got ${FAILURE_LINE_SCAN_MAX})`,
  );
  // The window must not lose a real shape: a status keyword in the first 8 KiB
  // is still the line the table recognises.
  assert(
    classifyFailureLine(`${CHECKS_BLOCK}${"y".repeat(200000)}`)?.shape === "script-tally",
    "bound: a real failure shape at the head of a huge line still classifies",
  );
}

// ── 2f-2. the window is applied ONCE, at the entry (#1762 round 3) ─────────
// The first version clipped in `scanWindow` AND re-sliced the ORIGINAL line
// inside `harnessVerifyStream`, so the bound was applied twice and — worse —
// the unclipped line was still visible to that function's own scans: the
// candidate separator scan (`streamSeparators`, which finds every `: ` in what
// it is given) and the deps-hint scan both ran over the full text. A 1 MB
// wrapper line of separators is 131 000 candidates, and the harness prefix's
// lazy `.+?` backtracks over all of them: measured over 30 s unbounded, and a
// verify gate that prints one such line stops. The whole line now goes through
// one window, so every scan below it is bounded by construction and the cost of
// one line is constant whatever it holds.
{
  const wrapperPrefix = `verify command \`${CMD}\` failed in ${WT}`;
  const huge = `${wrapperPrefix}${": ".repeat(500_000)}`; // ~1 MB, 500 000 `: ` candidates
  assert(huge.length > 1_000_000, `bound: the wrapper line is ~1 MB (got ${huge.length})`);
  const started = Date.now();
  const got = classifyFailureLine(huge);
  const ms = Date.now() - started;
  assert(got === undefined, "bound: a 1 MB wrapper line of separators classifies as nothing");
  assert(ms < 1000, `bound: a 1 MB wrapper line classifies in under 1 s (took ${ms} ms)`);
  // The window is a bound on COST, not on what a real line says: a normal line
  // — one separator, the gate's own report behind it — answers exactly as it
  // did before the clip moved, and the same report 200 KB deeper in does not.
  assert(
    classifyFailureLine(`${wrapperPrefix}: ${CHECKS_BLOCK}`)?.shape === "script-tally",
    `bound: a normal wrapper line still reports its shape (got ${JSON.stringify(classifyFailureLine(`${wrapperPrefix}: ${CHECKS_BLOCK}`))})`,
  );
  assert(
    classifyFailureLine(`${wrapperPrefix}: ${"y".repeat(200_000)}${CHECKS_BLOCK}`) === undefined,
    "bound: a failure shape past the window is not reached, so the bound is real",
  );
}

// ── 2g. isSuccessLine asserted directly, not only through the classifier ───
// The classifier asks this first and every passing veto in the table depends on
// it, so a change that keeps `classifyFailureLine` green while breaking the
// predicate (an inverted count guard, say) must still fail here.
{
  const YES: string[] = [
    "✓ 3 other checks",
    "ok 24 - the console's tests",
    "PASS  Test Suite (1000 ms)",
    "test result: 23 passed, 0 failed",
    "pack_release_test.sh: 36 cases, 0 failed",
    "scripts/test.sh: failed checks (0)",
    "0 errors",
    "12 passed",
  ];
  const NO: string[] = [
    "scripts/test.sh: failed checks (1)",
    "a.ts: 3 failed",
    "✗ expected 5 got 6",
    "not ok 3 - the console's tests",
    "",
    "   ",
    "index.ts: fatal error",
  ];
  for (const line of YES) {
    assert(isSuccessLine(line) === true, `isSuccessLine: ${JSON.stringify(line)} is a success`);
  }
  for (const line of NO) {
    assert(
      isSuccessLine(line) === false,
      `isSuccessLine: ${JSON.stringify(line)} is not a success`,
    );
  }
}

console.log(failed() ? "\nFAILED" : "\nAll #1762 deps-hint checks passed.");
process.exit(failed() ? 1 : 0);
