#!/usr/bin/env bun
/**
 * #807 — extractSpecificAssertion must return the REAL failing
 * assertion, never a marker, never an echoed command, and must report
 * absence honestly when no assertion-shaped line exists.
 */

import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
  sharesAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import {
  CARGO_TARGET_SUMMARY,
  NESSIE_TEST,
  RUST_CARGO_STREAM,
  RUST_PANIC_ASSERTION,
  rustCargoStream,
  rustPanicHeader,
} from "./lib/verify-failure-shapes-fixtures.ts";

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

// --- Case 13 (#827 new-tail-shape, #772 shape): the smoke loop's output when
// the fix (a) repeats the failing test's `✗` lines bounded under/after the
// final summary. The #772 failure: test-loop-detector.ts at 667 lines, the
// real `✗` assertion thousands of chars before the final `FAILED: <n> test(s)
// — ...` summary. After the fix, the bounded `✗` lines sit INSIDE the
// 800-char window. The extractor must return the first real `✗` line, not the
// summary, and the summary must still list the failing file.
{
  const summaryLine =
    "FAILED: 1 test(s) — extension/smoke-tests/test-file-size-limit.ts";
  // The #772 shape: the failing test's per-test output emitted first, then
  // (post-fix) the repeated bounded `✗` lines, then the final summary last.
  // The pre-fix defect: the `✗` lines were thousands of chars before the
  // summary, so the 800-char tail was summary-only. Post-fix: the `✗` lines
  // are repeated after the summary, inside the window.
  const tail = `FAILED: extension/smoke-tests/test-file-size-limit.ts
✗ extension/smoke-tests/test-loop-detector.ts: 667 lines (exceeds 500-line hard limit)
✗ extension/smoke-tests/test-dispatch-caps.ts: 528 lines (exceeds 500-line hard limit)
${summaryLine}\n✗ extension/smoke-tests/test-loop-detector.ts: 667 lines (exceeds 500-line hard limit)`;
  const a = extractSpecificAssertion(tail);
  assert(
    a === "✗ extension/smoke-tests/test-loop-detector.ts: 667 lines (exceeds 500-line hard limit)",
    `case 13 (#827 #772 shape): the first real ✗ line is named, not the summary (got: ${JSON.stringify(a)})`,
  );
  assert(!a.includes("test(s) —"), "case 13 (#827 #772 shape): the summary is NOT the assertion");
  assert(!a.startsWith("FAILED:"), "case 13 (#827 #772 shape): never a FAILED: marker");
}

// --- Case 14 (#827 new-tail-shape, multi-failure): the smoke loop's output
// when TWO tests fail and the fix repeats each failing test's bounded `✗`
// lines under/after the final summary. The extractor must return the FIRST
// real `✗` line; the summary must list ALL failing files. The 800-char
// bound is preserved: the repeated lines are bounded (first 3 per test) so
// the tail + summary still fits.
{
  const summaryLine =
    "FAILED: 2 test(s) — extension/smoke-tests/test-alpha.ts, extension/smoke-tests/test-beta.ts";
  const tail = `FAILED: extension/smoke-tests/test-alpha.ts
✗ alpha assertion: expected 0 got 2
FAILED: extension/smoke-tests/test-beta.ts
✗ beta assertion: expected 1 got 9
${summaryLine}\n✗ alpha assertion: expected 0 got 2\n✗ beta assertion: expected 1 got 9`;
  const a = extractSpecificAssertion(tail);
  assert(
    a === "✗ alpha assertion: expected 0 got 2",
    `case 14 (#827 multi-failure): the FIRST real ✗ line wins (got: ${JSON.stringify(a)})`,
  );
  assert(a !== "✗ beta assertion: expected 1 got 9", "case 14 (#827 multi-failure): the chosen assertion is alpha's, not beta's");
  assert(!a.includes("2 test(s) —"), "case 14 (#827 multi-failure): the summary count is NOT the assertion");
}

// --- Case 15 (#827 new-tail-shape, secret-shaped ✗ line): a `✗` line that
// contains credential material must be skipped in favour of the next
// qualifying line. The extracted assertion reaches a GitHub comment, so
// secrets must never be selected — even in the new tail shape where
// repeated `✗` lines sit after the summary. The secret-shape guard
// (LOOKS_LIKE_SECRET) matches `api_key`, `access_token`, `bearer`,
// `password`, `passwd`, `secret_key` followed by `:`/`=` and 8+ chars.
{
  const summaryLine = "FAILED: 1 test(s) — extension/smoke-tests/test-auth.ts";
  const secretLine = "✗ response body: api_key = a9f2k3j8f2j9f2j9f2j9f2";
  const tail = `FAILED: extension/smoke-tests/test-auth.ts
${secretLine}
${summaryLine}\n${secretLine}\n✗ auth check failed: expected 200 got 401`;
  const a = extractSpecificAssertion(tail);
  assert(
    a === "✗ auth check failed: expected 200 got 401",
    `case 15 (#827 secret ✗): a secret-shaped ✗ line is skipped; the next qualifying line is returned (got: ${JSON.stringify(a)})`,
  );
  assert(!/api_key/i.test(a), "case 15 (#827 secret ✗): the returned line carries no api_key token");
}

// --- Case 16 (#827 new-tail-shape, tsc/biome chain-stage failure — no
// FAILED marker): the chain-stage shape (no smoke marker) must remain
// unchanged. The extractor still returns the compiler/linter error line;
// the fix does not alter this path.
{
  const tail = `src/work-driver-foo.ts:42:10
error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
  Type 'string' is not comparable to type 'number'.`;
  const a = extractSpecificAssertion(tail);
  assert(
    a === "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    `case 16 (#827 tsc unchanged): chain-stage tsc failure still returns the compiler error (got: ${JSON.stringify(a)})`,
  );
}

// --- Case 17 (#827 new-tail-shape, biome chain-stage failure — no FAILED
// marker): same as case 16 but for the biome shape. The fix does not alter
// the no-marker path.
{
  const tail = `Checked 239 files in 66ms.
✗ use single quotes (style/useTemplate)
    --> src/biome-test.ts:10:5`;
  const a = extractSpecificAssertion(tail);
  assert(
    a === "✗ use single quotes (style/useTemplate)",
    `case 17 (#827 biome unchanged): chain-stage biome failure still returns the ✗ assertion (got: ${JSON.stringify(a)})`,
  );
}

// --- Case 18 (#2341 AC1/AC4, the nessie 1415 regression): the real cargo
// stream must yield the PANIC PAIR — header naming test, file and line, plus
// the message naming the measured value and the bound — never cargo's generic
// `error: test failed, to rerun pass` summary. The summary is the least
// useful line in the run; quoting it sent an operator hunting for a memory
// problem while the decisive line sat in the same window.
{
  const a = extractSpecificAssertion(RUST_CARGO_STREAM);
  assert(
    a === RUST_PANIC_ASSERTION,
    `case 18 (#2341 cargo panic): returns the joined panic pair, not the summary (got: ${JSON.stringify(a)})`,
  );
  assert(
    a.includes("panicked at src/session/fastpath_tests.rs:91:5:") &&
      a.includes("101.409582ms") &&
      a.includes("which is over the 100 ms bound"),
    "case 18 (#2341 cargo panic): the assertion names file:line, the measured value and the bound",
  );
  assert(
    !a.includes("error: test failed"),
    "case 18 (#2341 cargo panic): never the generic cargo summary",
  );
}

// --- Case 19 (#2341, the whole consumer path): probeBaselineVerify feeds
// extractAttributedTail(raw, 1500) — with only the generic summary recognised,
// lastFailureIndex anchored ON that trailing line and sliced the panic pair
// off before the extractor ever saw it. The anchor must land on the panic
// header (the summary is recognised but names no check), so the pair survives
// the window end to end.
{
  const { tail, attributed } = extractAttributedTail(RUST_CARGO_STREAM, 1500);
  assert(attributed, "case 19 (#2341 window): the cargo stream is attributed");
  assert(
    tail.startsWith("thread '"),
    `case 19 (#2341 window): the tail anchors on the panic header, not the trailing summary (got: ${JSON.stringify(tail.slice(0, 40))})`,
  );
  assert(
    extractSpecificAssertion(tail) === RUST_PANIC_ASSERTION,
    "case 19 (#2341 window): the panic pair survives the 1500-char attributed window",
  );
}

// --- Case 20 (#2341 AC2/AC7, the confirmed-serious half): two DIFFERENT
// failing Rust tests in the SAME cargo target print the byte-identical
// generic summary. They must extract to different assertions, and neither may
// compare as the other's — otherwise baselineExplainsChange excuses a failure
// the change itself added.
{
  const otherTest = "session::fastpath_tests::slow_path_reports_progress";
  const streamB = rustCargoStream({
    test: otherTest,
    at: "src/session/fastpath_tests.rs:120:9",
    message: "expected progress within 50 ms, got 133.7 ms",
  });
  const a = extractSpecificAssertion(RUST_CARGO_STREAM);
  const b = extractSpecificAssertion(streamB);
  assert(a !== b, `case 20 (#2341 sameness): two different Rust tests extract different assertions (${a === b})`);
  assert(
    !sharesAssertion(streamB, a) && !sharesAssertion(RUST_CARGO_STREAM, b),
    "case 20 (#2341 sameness): neither failure shares the other's assertion — the change is not excused",
  );
  assert(
    sharesAssertion(RUST_CARGO_STREAM, a),
    "case 20 (#2341 sameness): a failure of the SAME test still shares its own assertion (the rule is not simply off)",
  );
}

// --- Case 21 (#2341 AC7, fail-closed sameness on a deliberately generic
// assertion): the summary sits in the consolidated stream VERBATIM, so plain
// substring containment would match it; the sameness gate refuses the
// target-level cargo summary wherever it arrives from — including a hand-built
// verdict.assertion. A stream whose only recognised line is the summary
// reports honest absence, it does not quote the summary as "the assertion".
{
  assert(
    !sharesAssertion(RUST_CARGO_STREAM, CARGO_TARGET_SUMMARY),
    "case 21 (#2341 fail-closed): the generic cargo summary never compares as a shared assertion",
  );
  assert(
    RUST_CARGO_STREAM.includes(CARGO_TARGET_SUMMARY),
    "case 21 (#2341 fail-closed): the refusal is not the fixture — the line IS in the stream",
  );
  const a = extractSpecificAssertion(`${"noise from the run\n".repeat(3)}${CARGO_TARGET_SUMMARY}`);
  assert(
    a === NO_SPECIFIC_ASSERTION,
    `case 21 (#2341 fail-closed): a summary-only stream reports absence (got: ${JSON.stringify(a)})`,
  );
}

// --- Case 22 (#2341, the half-pair): the window may cut BETWEEN the panic
// header and its message line. A half-pair is returned as the header — it
// still names the test, file and line — and never the trailing summary, and
// the next line is joined only when it really is the message: a `note:` line
// is cargo's boilerplate, not an assertion.
{
  const halfPair = rustPanicHeader(NESSIE_TEST, "src/session/fastpath_tests.rs:91:5");
  const a = extractSpecificAssertion(halfPair);
  assert(
    a === halfPair,
    `case 22 (#2341 half-pair): a header cut from its message still names test, file and line (got: ${JSON.stringify(a)})`,
  );
  const noteAfter = `${halfPair}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`;
  assert(
    extractSpecificAssertion(noteAfter) === halfPair,
    "case 22 (#2341 half-pair): cargo's note: boilerplate is never joined into the assertion",
  );
}

// --- Case 23 (#2341, the success veto): a panic message quoting the counts
// it compared (`expected 0 failures, got 3`) is the runner's FAILING verdict,
// not a passing tally — the shape is exempt from isSuccessLine (preVeto). And
// a stream whose only cargo lines are the passing tally and the generic
// summary reports absence, never a tally line.
{
  const zeroTally = `thread 'a::tests::t' panicked at src/a.rs:1:1:
assertion failed: expected 0 failures, got 3`;
  const a = extractSpecificAssertion(zeroTally);
  assert(
    a === `${rustPanicHeader("a::tests::t", "src/a.rs:1:1")} assertion failed: expected 0 failures, got 3`,
    `case 23 (#2341 veto): a zero-count tally inside a panic message does not veto the line (got: ${JSON.stringify(a)})`,
  );
  const green = `running 3 tests
test a::tests::one ... ok
test a::tests::two ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
${CARGO_TARGET_SUMMARY}`;
  assert(
    extractSpecificAssertion(green) === NO_SPECIFIC_ASSERTION,
    "case 23 (#2341 veto): passing tallies and the summary yield no assertion",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
