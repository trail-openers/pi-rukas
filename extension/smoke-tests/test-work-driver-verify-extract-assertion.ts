#!/usr/bin/env bun
/**
 * #807 — extractSpecificAssertion must return the REAL failing
 * assertion, never a marker, never an echoed command, and must report
 * absence honestly when no assertion-shaped line exists.
 */

import { extractSpecificAssertion, NO_SPECIFIC_ASSERTION } from "../src/work-driver-consolidation-classify.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --- Case 1: #798 shape — the smoke loop's per-failure FAILED marker followed
// by the real ✗ assertion. The extractor must return the assertion, not the
// marker (which is what #798 reported as "the specific assertion").
{
  const tail = `FAILED: smoke-tests/test-cancel.ts
✗ aborted child returned within 10s (took 496954ms)`;
  const a = extractSpecificAssertion(tail);
  assert(a === "✗ aborted child returned within 10s (took 496954ms)", `case 1 (#798): returns the ✗ assertion, not the FAILED marker (got: ${JSON.stringify(a)})`);
  assert(!a.startsWith("FAILED:"), "case 1 (#798): never a FAILED: marker line");
}

// --- Case 2: #746 shape — an ECHOED SHELL COMMAND (`$ cd extension && bun run check`)
// as the first line (the chain's earlier passing stage), then the real
// failure. The extractor must return the error, never the echo.
{
  const tail = `$ cd extension && bun run check
Checked 276 files in 61ms. No fixes applied.
FAILED: smoke-tests/test-repo-root-residue-poisoning.ts
✗ check on scaffolded file: exit 0 (got 1)`;
  const a = extractSpecificAssertion(tail);
  assert(a === "✗ check on scaffolded file: exit 0 (got 1)", `case 2 (#746): returns the ✗ assertion, not the echoed command (got: ${JSON.stringify(a)})`);
  assert(!a.startsWith("$ "), "case 2 (#746): never a `$ ` echoed command line");
}

// --- Case 3: tsc failure with no FAILED marker (chain-stage shape, attributed:false
// fallback). Returns the compiler error line.
{
  const tail = `src/work-driver-foo.ts:42:10
error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
  Type 'string' is not comparable to type 'number'.`;
  const a = extractSpecificAssertion(tail);
  assert(a === "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", `case 3 (tsc): returns the compiler error (got: ${JSON.stringify(a)})`);
}

// --- Case 4: biome failure with no FAILED marker (chain-stage shape). Returns
// the ✗ assertion biome emits.
{
  const tail = `Checked 239 files in 66ms.
✗ use single quotes (style/useTemplate)
    --> src/biome-test.ts:10:5`;
  const a = extractSpecificAssertion(tail);
  assert(a === "✗ use single quotes (style/useTemplate)", `case 4 (biome): returns the ✗ assertion (got: ${JSON.stringify(a)})`);
}

// --- Case 5: honest absence — a tail with NO assertion-shaped line (a bare
// marker, no detail) must report NO_SPECIFIC_ASSERTION, not the first non-empty
// line (which was the #746 defect: the echo becoming "the assertion").
{
  const tail = "FAILED: smoke-tests/test-mystery.ts";
  const a = extractSpecificAssertion(tail);
  assert(a === NO_SPECIFIC_ASSERTION, `case 5 (absence): a bare FAILED: marker with no detail reports absence (got: ${JSON.stringify(a)})`);
}

// --- Case 6: #746 echo line + no error (the exact #746 shape: the first
// non-empty line IS the echo; no assertion-shaped line follows). The
// extractor must skip the echo and report absence, not return the echo.
{
  const tail = `$ cd extension && bun run check
Checked 276 files in 61ms. No fixes applied.`;
  const a = extractSpecificAssertion(tail);
  assert(a === NO_SPECIFIC_ASSERTION, `case 6 (echo-only): an echoed command with no error reports absence, never the echo itself (got: ${JSON.stringify(a)})`);
  assert(!a.startsWith("$ "), "case 6 (echo-only): the result is not a `$ ` line");
}

// --- Case 7: post-#804 multi-failure shape — several markers AND several
// assertions. The "specific assertion" is the FIRST real assertion; the count
// is the summary marker's job (asserted: first-assertion wins, count NOT
// duplicated into the extracted field).
{
  const tail = `✓ 3 other checks
FAILED: smoke-tests/test-alpha.ts
✗ alpha assertion: expected 0 got 2
FAILED: smoke-tests/test-beta.ts
✗ beta assertion: expected 1 got 9
FAILED: 2 test(s) — smoke-tests/test-alpha.ts, smoke-tests/test-beta.ts`;
  const a = extractSpecificAssertion(tail);
  assert(a === "✗ alpha assertion: expected 0 got 2", `case 7 (post-#804 multi-failure): the FIRST real assertion wins (got: ${JSON.stringify(a)})`);
  assert(!a.includes("2 test(s)"), "case 7 (post-#804 multi-failure): the summary count is NOT the assertion");
}

// --- Case 8: the summary marker as the ONLY line (post-#804, when the
// per-test details were elided from the 800-char tail). Reports absence.
{
  const tail = "FAILED: 2 test(s) — smoke-tests/test-alpha.ts, smoke-tests/test-beta.ts";
  const a = extractSpecificAssertion(tail);
  assert(a === NO_SPECIFIC_ASSERTION, `case 8 (summary-only): a summary marker alone reports absence (got: ${JSON.stringify(a)})`);
}

// --- Case 9: secret-shape guard — a line that looks like credential material
// is skipped in favour of the next qualifying line (the extracted assertion
// reaches a GitHub comment, so secrets must never be selected).
{
  const tail = `error: could not authenticate
Authorization: Bearer sk-a]9f2k3j8f2j9f2j9f2j9f
✗ build step failed: exit 1`;
  const a = extractSpecificAssertion(tail);
  assert(a === "✗ build step failed: exit 1", `case 9 (secret-shape): a secret-shaped line is skipped; the next qualifying line is returned (got: ${JSON.stringify(a)})`);
  assert(!/Bearer/i.test(a), "case 9 (secret-shape): the returned line carries no Bearer token");
}

// --- Case 10: `exit 0 (got 1)` / `zero findings (got 1)` scaffolded-file
// shape (the pre-#807 fallback that worked). Still extracted.
{
  const tail = `running scaffold checks
✗ check on scaffolded file: exit 0 (got 1)
✗ check: zero findings (got 1)`;
  const a = extractSpecificAssertion(tail);
  assert(a === "✗ check on scaffolded file: exit 0 (got 1)", `case 10 (scaffolded-file shape): the scaffolded-file ✗ line is returned (got: ${JSON.stringify(a)})`);
}

// --- Case 11: the exact #746 combined string (echo FIRST, then banner, then
// marker, then the real assertion) — the dispatcher's required fixture.
{
  const tail = `$ cd extension && bun run check
Checked 276 files in 61ms. No fixes applied.
$ cd extension && bunx tsc --noEmit
error TS2552: Cannot find name 'foo'. Did you mean 'bar'?
FAILED: smoke-tests/test-repo-root-residue-poisoning.ts
✗ check on scaffolded file: exit 0 (got 1)`;
  const a = extractSpecificAssertion(tail);
  // The ✗ assertion is preferred over the tsc error (priority rule).
  assert(a === "✗ check on scaffolded file: exit 0 (got 1)", `case 11 (exact #746 shape): the ✗ assertion wins (got: ${JSON.stringify(a)})`);
  assert(!a.startsWith("$ ") && !a.startsWith("FAILED:"), "case 11 (exact #746 shape): neither a $ echo nor a FAILED marker");
}

// --- Case 12: a tail where the FIRST line is a marker and the SECOND is the
// assertion — the most common smoke-loop shape. (Pins the priority over the
// marker explicitly, independent of case 1's fixture wording.)
{
  const tail = `FAILED: smoke-tests/test-x.ts
✗ expected 5 got 6`;
  const a = extractSpecificAssertion(tail);
  assert(a === "✗ expected 5 got 6", `case 12 (marker→assertion): the ✗ line under the marker is returned (got: ${JSON.stringify(a)})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
