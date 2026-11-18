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
  ALPHA_BETA_TAIL_827,
  BIOME_CHAIN_STAGE_TAIL,
  CARGO_SIGABRT_SUMMARY,
  CARGO_TARGET_SUMMARIES,
  CARGO_TARGET_SUMMARY,
  EXACT_746_TAIL,
  FILE_SIZE_LOOP_TAIL_827,
  LIBTEST_GREEN_TALLY_STREAM,
  NESSIE_TEST,
  RUST_CARGO_STREAM,
  RUST_PANIC_ASSERTION,
  RUST_PANIC_AT,
  RUST_PANIC_MESSAGE,
  RUST_SHOULD_PANIC_TRAP_STREAM,
  RUST_TRAP_PAIR,
  RUSTC_DIAG_NO_LOCATION,
  RUSTC_DIAG_STREAM,
  rustCargoStream,
  RUST_SHOULD_PANIC_GREEN_STREAM,
  rustPanicHeader,
  SECRET_ASSERTION_TAIL_827,
  SMOKE_MULTI_FAILURE_TAIL,
  TSC_CHAIN_STAGE_TAIL,
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
  const a = extractSpecificAssertion(tail, tail);
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
  const a = extractSpecificAssertion(tail, tail);
  assert(a === "✗ check on scaffolded file: exit 0 (got 1)", `case 2 (#746): returns the ✗ assertion, not the echoed command (got: ${JSON.stringify(a)})`);
  assert(!a.startsWith("$ "), "case 2 (#746): never a `$ ` echoed command line");
}

// --- Case 3: tsc failure with no FAILED marker (chain-stage shape, attributed:false
// fallback). Returns the compiler error line — H4: the REAL tsc dialect prints
// the location ON the error line, and that location buys the naming right.
{
  const tail = TSC_CHAIN_STAGE_TAIL;
  const a = extractSpecificAssertion(tail, tail);
  assert(a === "src/work-driver-foo.ts:42:10 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", `case 3 (tsc): returns the located compiler error (got: ${JSON.stringify(a)})`);
}

// --- Case 4: biome failure with no FAILED marker (chain-stage shape). Returns
// the ✗ assertion biome emits.
{
  const tail = BIOME_CHAIN_STAGE_TAIL;
  const a = extractSpecificAssertion(tail, tail);
  assert(a === "✗ use single quotes (style/useTemplate)", `case 4 (biome): returns the ✗ assertion (got: ${JSON.stringify(a)})`);
}

// --- Case 5: honest absence — a tail with NO assertion-shaped line (a bare
// marker, no detail) must report NO_SPECIFIC_ASSERTION, not the first non-empty
// line (which was the #746 defect: the echo becoming "the assertion").
{
  const tail = "FAILED: smoke-tests/test-mystery.ts";
  const a = extractSpecificAssertion(tail, tail);
  assert(a === NO_SPECIFIC_ASSERTION, `case 5 (absence): a bare FAILED: marker with no detail reports absence (got: ${JSON.stringify(a)})`);
}

// --- Case 6: #746 echo line + no error (the exact #746 shape: the first
// non-empty line IS the echo; no assertion-shaped line follows). The
// extractor must skip the echo and report absence, not return the echo.
{
  const tail = `$ cd extension && bun run check
Checked 276 files in 61ms. No fixes applied.`;
  const a = extractSpecificAssertion(tail, tail);
  assert(a === NO_SPECIFIC_ASSERTION, `case 6 (echo-only): an echoed command with no error reports absence, never the echo itself (got: ${JSON.stringify(a)})`);
  assert(!a.startsWith("$ "), "case 6 (echo-only): the result is not a `$ ` line");
}

// --- Case 7: post-#804 multi-failure shape — several markers AND several
// assertions. The "specific assertion" is the FIRST real assertion; the count
// is the summary marker's job (asserted: first-assertion wins, count NOT
// duplicated into the extracted field).
{
  const tail = SMOKE_MULTI_FAILURE_TAIL;
  const a = extractSpecificAssertion(tail, tail);
  assert(a === "✗ alpha assertion: expected 0 got 2", `case 7 (post-#804 multi-failure): the FIRST real assertion wins (got: ${JSON.stringify(a)})`);
  assert(!a.includes("2 test(s)"), "case 7 (post-#804 multi-failure): the summary count is NOT the assertion");
}

// --- Case 8: the summary marker as the ONLY line (post-#804, when the
// per-test details were elided from the 800-char tail). Reports absence.
{
  const tail = "FAILED: 2 test(s) — smoke-tests/test-alpha.ts, smoke-tests/test-beta.ts";
  const a = extractSpecificAssertion(tail, tail);
  assert(a === NO_SPECIFIC_ASSERTION, `case 8 (summary-only): a summary marker alone reports absence (got: ${JSON.stringify(a)})`);
}

// --- Case 9: secret-shape guard — a line that looks like credential material
// is skipped in favour of the next qualifying line (the extracted assertion
// reaches a GitHub comment, so secrets must never be selected).
{
  const tail = `error: could not authenticate
Authorization: Bearer sk-a]9f2k3j8f2j9f2j9f2j9f
✗ build step failed: exit 1`;
  const a = extractSpecificAssertion(tail, tail);
  assert(a === "✗ build step failed: exit 1", `case 9 (secret-shape): a secret-shaped line is skipped; the next qualifying line is returned (got: ${JSON.stringify(a)})`);
  assert(!/Bearer/i.test(a), "case 9 (secret-shape): the returned line carries no Bearer token");
}

// --- Case 10: `exit 0 (got 1)` / `zero findings (got 1)` scaffolded-file
// shape (the pre-#807 fallback that worked). Still extracted.
{
  const tail = `running scaffold checks
✗ check on scaffolded file: exit 0 (got 1)
✗ check: zero findings (got 1)`;
  const a = extractSpecificAssertion(tail, tail);
  assert(a === "✗ check on scaffolded file: exit 0 (got 1)", `case 10 (scaffolded-file shape): the scaffolded-file ✗ line is returned (got: ${JSON.stringify(a)})`);
}

// --- Case 11: the exact #746 combined string (echo FIRST, then banner, then
// marker, then the real assertion) — the dispatcher's required fixture.
{
  const tail = EXACT_746_TAIL;
  const a = extractSpecificAssertion(tail, tail);
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
  const a = extractSpecificAssertion(tail, tail);
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
  const tail = FILE_SIZE_LOOP_TAIL_827;
  const a = extractSpecificAssertion(tail, tail);
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
  const tail = ALPHA_BETA_TAIL_827;
  const a = extractSpecificAssertion(tail, tail);
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
  const tail = SECRET_ASSERTION_TAIL_827;
  const a = extractSpecificAssertion(tail, tail);
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
  const tail = TSC_CHAIN_STAGE_TAIL;
  const a = extractSpecificAssertion(tail, tail);
  assert(
    a === "src/work-driver-foo.ts:42:10 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    `case 16 (#827 tsc unchanged): chain-stage tsc failure still returns the located compiler error (got: ${JSON.stringify(a)})`,
  );
}

// --- Case 17 (#827 new-tail-shape, biome chain-stage failure — no FAILED
// marker): same as case 16 but for the biome shape. The fix does not alter
// the no-marker path.
{
  const tail = BIOME_CHAIN_STAGE_TAIL;
  const a = extractSpecificAssertion(tail, tail);
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
  const a = extractSpecificAssertion(RUST_CARGO_STREAM, RUST_CARGO_STREAM);
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
    extractSpecificAssertion(tail, tail) === RUST_PANIC_ASSERTION,
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
  const a = extractSpecificAssertion(RUST_CARGO_STREAM, RUST_CARGO_STREAM);
  const b = extractSpecificAssertion(streamB, streamB);
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
  const noise3 = `${"noise from the run\n".repeat(3)}${CARGO_TARGET_SUMMARY}`;
  const a = extractSpecificAssertion(noise3, noise3);
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
  const a = extractSpecificAssertion(halfPair, halfPair);
  assert(
    a === halfPair,
    `case 22 (#2341 half-pair): a header cut from its message still names test, file and line (got: ${JSON.stringify(a)})`,
  );
  const noteAfter = `${halfPair}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`;
  assert(
    extractSpecificAssertion(noteAfter, noteAfter) === halfPair,
    "case 22 (#2341 half-pair): cargo's note: boilerplate is never joined into the assertion",
  );
  // #2341 round 2 — the same refusal on cargo's LIST boilerplate. When the
  // window cut lands the `failures:` block header (or the test-name line
  // printed under it) directly beneath a panic header, that line is cargo's
  // scaffolding, not the panic message, and joining it puts boilerplate in
  // front of the operator reading the handoff.
  const listHeader = `${rustPanicHeader("a::t", "src/a.rs:1:5")}\nfailures:`;
  assert(
    extractSpecificAssertion(listHeader, listHeader) === rustPanicHeader("a::t", "src/a.rs:1:5"),
    `case 22 (#2341 list boilerplate): cargo's failures: header is never joined into the assertion (got: ${JSON.stringify(extractSpecificAssertion(listHeader, listHeader))})`,
  );
  const listName = `${rustPanicHeader("a::t", "src/a.rs:1:5")}\n    a::t`;
  assert(
    extractSpecificAssertion(listName, listName) === rustPanicHeader("a::t", "src/a.rs:1:5"),
    `case 22 (#2341 list boilerplate): an indented test-name line is never joined into the assertion (got: ${JSON.stringify(extractSpecificAssertion(listName, listName))})`,
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
  const a = extractSpecificAssertion(zeroTally, zeroTally);
  assert(
    a === `${rustPanicHeader("a::tests::t", "src/a.rs:1:1")} assertion failed: expected 0 failures, got 3`,
    `case 23 (#2341 veto): a zero-count tally inside a panic message does not veto the line (got: ${JSON.stringify(a)})`,
  );
  const green = LIBTEST_GREEN_TALLY_STREAM;
  assert(
    extractSpecificAssertion(green, green) === NO_SPECIFIC_ASSERTION,
    "case 23 (#2341 veto): passing tallies and the summary yield no assertion",
  );
}

// --- Case 24 (#2341 round 1, the fail-open the review reproduced): cargo's
// OTHER target-level `error:` lines. `error: process didn't exit successfully:
// …(signal: 6, SIGABRT)` is byte-identical for every test that died in the
// target, and it sits BELOW the last panic — so while it classified as a
// `diagnostic` naming a check, `lastFailureIndex` anchored on it, the 1500-char
// window sliced the decisive pair off, and both streams extracted THAT line:
// two different Rust tests compared as the same assertion and
// `baselineExplainsChange` excused a regression the change had just added. The
// whole cargo target-level dialect must be `namesTest: false`, so the anchor
// stays on the panic and the two streams extract apart.
{
  const otherTest = "session::fastpath_tests::slow_path_reports_progress";
  const a = rustCargoStream({
    test: NESSIE_TEST,
    at: RUST_PANIC_AT,
    message: RUST_PANIC_MESSAGE,
    trailer: CARGO_SIGABRT_SUMMARY,
  });
  const b = rustCargoStream({
    test: otherTest,
    at: "src/session/fastpath_tests.rs:120:9",
    message: "expected progress within 50 ms, got 133.7 ms",
    trailer: CARGO_SIGABRT_SUMMARY,
  });
  const ea = extractSpecificAssertion(extractAttributedTail(a, 1500).tail, a);
  const eb = extractSpecificAssertion(extractAttributedTail(b, 1500).tail, b);
  assert(
    ea.startsWith("thread '") && eb.startsWith("thread '"),
    `case 24 (#2341 SIGABRT): the anchor stays on the panic, not the trailing cargo summary (a=${JSON.stringify(ea.slice(0, 30))})`,
  );
  assert(ea !== eb, `case 24 (#2341 SIGABRT): the two tests extract APART (${ea === eb})`);
  assert(
    !sharesAssertion(a, eb) && !sharesAssertion(b, ea),
    "case 24 (#2341 SIGABRT): neither failure shares the other's assertion — the regression is not excused",
  );
  assert(
    !ea.includes("process didn't exit successfully") && !eb.includes("didn't exit successfully"),
    "case 24 (#2341 SIGABRT): the process-level line is never the assertion",
  );
  for (const line of CARGO_TARGET_SUMMARIES) {
    assert(
      !sharesAssertion(a, line) && !sharesAssertion(b, line),
      `case 24 (#2341 SIGABRT): no cargo target-level line buys a SAME claim (got: ${JSON.stringify(line.slice(0, 40))})`,
    );
    assert(
      extractSpecificAssertion(`${"noise from the run\n".repeat(2)}${line}`, `${"noise from the run\n".repeat(2)}${line}`) === NO_SPECIFIC_ASSERTION,
      `case 24 (#2341 SIGABRT): a stream whose only cargo line is that summary reports absence (got: ${JSON.stringify(line.slice(0, 40))})`,
    );
  }
}

// --- Case 25 (#2341 round 1, the #[should_panic] trap): a Rust unit stage
// that PASSES prints the byte-identical panic header as the captured stdout of
// a test that passed, and the run exits non-zero because a LATER stage failed
// on a dialect the table does not know. The exit-code argument in the shape's
// justification is satisfied and yet the panic names a test that PASSED —
// before the veto it became "the specific assertion", converting an honest
// absence into the #746/#798 class. With libtest verdicts in the window and no
// failing one, the panic is refused; with no verdict in the window at all (the
// truncated half-pair of case 22) nothing is observed and the header stands.
{
  const a = extractSpecificAssertion(RUST_SHOULD_PANIC_GREEN_STREAM, RUST_SHOULD_PANIC_GREEN_STREAM);
  assert(
    a === NO_SPECIFIC_ASSERTION,
    `case 25 (#2341 should_panic): a passing test's captured panic is never the assertion (got: ${JSON.stringify(a)})`,
  );
  assert(
    extractSpecificAssertion(rustPanicHeader(NESSIE_TEST, RUST_PANIC_AT), rustPanicHeader(NESSIE_TEST, RUST_PANIC_AT)) === rustPanicHeader(NESSIE_TEST, RUST_PANIC_AT),
    "case 25 (#2341 should_panic): an unobserved verdict vetoes nothing — a truncated header still names the defect",
  );
  // And the veto is not simply "a panic is never an assertion": the same
  // should_panic print with a failing verdict for THAT test is read.
  const red = RUST_SHOULD_PANIC_GREEN_STREAM.replace("test a::t ... ok", "test a::t ... FAILED").replace("test result: ok. 3 passed; 0 failed", "test result: FAILED. 2 passed; 1 failed");
  assert(
    extractSpecificAssertion(red, red) ===
      `${rustPanicHeader("a::t", "src/a.rs:7:5")} explicit panic`,
    `case 25 (#2341 should_panic): a failing verdict in the window lets the panic be quoted (got: ${JSON.stringify(extractSpecificAssertion(red, red))})`,
  );
  // A libtest verdict is never JOINED into the pair the way a message is.
  const joined = extractSpecificAssertion(
    `${rustPanicHeader("a::t", "src/a.rs:7:5")}\ntest result: ok. 3 passed; 0 failed; 0 ignored`, `${rustPanicHeader("a::t", "src/a.rs:7:5")}\ntest result: ok. 3 passed; 0 failed; 0 ignored`,
  );
  assert(
    !joined.includes("test result:"),
    `case 25 (#2341 should_panic): a verdict line is never joined into the assertion (got: ${JSON.stringify(joined)})`,
  );
}

// --- Case 26 (#2341 fix wave — sameness and the veto FAIL CLOSED): the
// should_panic veto is per-TEST, not per-window (H1 — the window's failing
// verdict belongs to a DIFFERENT test, so the captured panic of the passing
// test names nothing and is never quoted); a location-less `error[E…]` and a
// panic header clipped mid-header never buy "SAME assertion" (H2, M1). The
// windowed half of H1 (the anchor walk asking the same veto) is pinned in
// test-exec-error-attribution.ts.
{
  const a = extractSpecificAssertion(RUST_SHOULD_PANIC_TRAP_STREAM, RUST_SHOULD_PANIC_TRAP_STREAM);
  assert(a === RUST_TRAP_PAIR, `case 26 (#2341 per-name veto): the genuinely-failing test wins, not the should_panic capture (got: ${JSON.stringify(a)})`);
  assert(!sharesAssertion(RUSTC_DIAG_STREAM, RUSTC_DIAG_NO_LOCATION), "case 26 (#2341 H2): two location-less error[E\u2026] failures in different files never share an assertion");
  assert(extractSpecificAssertion(RUSTC_DIAG_STREAM, RUSTC_DIAG_STREAM) === NO_SPECIFIC_ASSERTION, `case 26 (#2341 H2): a location-less error[E\u2026] is never the quoted assertion (got: ${JSON.stringify(extractSpecificAssertion(RUSTC_DIAG_STREAM, RUSTC_DIAG_STREAM))})`);
  const clipped = rustPanicHeader(NESSIE_TEST, RUST_PANIC_AT).slice(0, -6);
  assert(!sharesAssertion(RUST_CARGO_STREAM, clipped), `case 26 (#2341 M1): a panic header clipped past its identity compares as nothing (got: ${JSON.stringify(clipped)})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
