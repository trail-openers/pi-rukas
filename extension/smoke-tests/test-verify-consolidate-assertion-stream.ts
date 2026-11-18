#!/usr/bin/env bun
/**
 * #2341 fix wave 7 — the CONSOLIDATE path's `should_panic` veto, which had no
 * coverage at all until this arm, and that gap is why the wave-6 regression
 * shipped green: `classifyConsolidatedVerifyFailure` is handed an 800-char
 * WINDOW (`work-driver-integrate-verify.ts` and
 * `work-driver-consolidated-verify-report.ts` both cut it with
 * `extractAttributedTail(rawFailure, 800)`), and `verdict.assertion` is not a
 * diagnostic — it flows into `consolidatedFailureMessage` →
 * `verifyEvidence.failures` → the handoff AND the corrective developer prompt.
 * A window-scoped veto therefore decided what an operator and a developer were
 * told about a test's pass/fail, on bytes the elision had already edited.
 *
 * Pinned here, on the real consumer path rather than on the extractor alone:
 *
 *   - a captured `#[should_panic]` print whose own `... ok` the window elided
 *     is NEVER the published assertion — the veto is asked on the stream the
 *     window was cut from, which the caller threads as `fullFailure`;
 *   - the same bytes with a genuinely failing panic still name it;
 *   - the MONOTONE ok rule: ANY per-test `ok` line for the exact name vetoes,
 *     so an earlier `ok` beside a later `FAILED` for that name still vetoes —
 *     two same-named crates printed both lines, and the later FAILED may not
 *     unshield the passing crate's capture (the #746 fold);
 *   - the name match is EXACT — `a::t` is answered for by neither `a::t2` nor
 *     `a::t::nested`;
 *   - `gatePerAssertion`, which drives the flake re-run suppression, sees the
 *     same verdict on the same bytes.
 */

import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "../src/work-driver-consolidation-classify.ts";
import { baselineExplainsChange } from "../src/work-driver-verify-baseline.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-verify-assertion.ts";
import { gatePerAssertion } from "../src/work-driver-verify-record.ts";
import { makeAssert, rustPanicHeader } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

const CMD = "bash scripts/verify.sh";
const PASSING = "a::t";
const CAPTURE_MESSAGE = "explicit panic";

/** A long green stage, so the 800-char window really does elide the verdict. */
const pad = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, k) => `   Compiling ${tag}_${k} v0.1.0 (registry)`).join("\n");

/**
 * The consolidated failure the integrate seam actually hands the classifier:
 * `extractAttributedTail(raw, 800).tail` of a stream whose `test a::t ... ok`
 * verdict sits ABOVE the elision and whose captured panic print sits below it.
 */
function windowAndStream(): { window: string; stream: string } {
  const stream = [
    "FAILED: smoke-tests/test-rust-unit.ts",
    "running 2 tests",
    `test ${PASSING} ... ok`,
    `test ${PASSING}::sibling ... ok`,
    pad(60, `cc${PASSING}`),
    "thread 'a::slow' panicked at src/a.rs:3:3:",
    "assertion failed: the value the change broke",
    `test a::slow ... FAILED`,
    "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured",
  ].join("\n");
  const { tail } = extractAttributedTail(stream, 800);
  return { window: tail, stream };
}

// ── 1. the published assertion is decided on the STREAM, not the window ─────
{
  // A capture whose `ok` the window elided: asked on the WINDOW the veto sees
  // no verdict and quotes it; asked on the STREAM it refuses. Both halves are
  // asserted so the arm cannot go green by the extractor simply never seeing
  // the panic.
  const captured = [
    "FAILED: smoke-tests/test-rust-unit.ts",
    "running 2 tests",
    `test ${PASSING} ... ok`,
    pad(60, "cap"),
    rustPanicHeader(PASSING, "src/a.rs:7:5"),
    CAPTURE_MESSAGE,
    "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured",
    `test ${PASSING}::other ... FAILED`,
  ].join("\n");
  const { tail } = extractAttributedTail(captured, 800);
  assert(
    tail.includes(rustPanicHeader(PASSING, "src/a.rs:7:5")),
    "consolidate: the window really does carry the captured panic — the veto cannot rely on the cut",
  );
  assert(
    !tail.includes(`test ${PASSING} ... ok`),
    "consolidate: the window really does NOT carry the verdict that proves it a capture",
  );
  // The window asked as its own stream is the shape that regressed: it quotes.
  assert(
    extractSpecificAssertion(tail, tail).includes(rustPanicHeader(PASSING, "src/a.rs:7:5")),
    "consolidate: without the raw stream the veto is UNDECIDABLE on the window — which is why the parameter is required",
  );
  const verdict = classifyConsolidatedVerifyFailure(2, ["a", "b"], tail, {}, captured);
  assert(
    verdict.assertion !== rustPanicHeader(PASSING, "src/a.rs:7:5") &&
      !String(verdict.assertion).includes(`thread '${PASSING}'`),
    `consolidate: the published assertion never names the passing test (got ${JSON.stringify(String(verdict.assertion).slice(0, 70))})`,
  );
  const message = consolidatedFailureMessage(verdict, CMD);
  assert(
    !message.includes(`thread '${PASSING}'`),
    `consolidate: the handoff text the operator and the developer read never names the passing test (got ${JSON.stringify(message.slice(0, 90))})`,
  );
}

// ── 2. the same bytes with a genuinely FAILING panic still name it ───────────
{
  const { window, stream } = windowAndStream();
  assert(
    !window.includes(`test ${PASSING} ... ok`),
    "consolidate: the passing sibling's verdict is outside the window — the ask cannot lean on the cut",
  );
  const verdict = classifyConsolidatedVerifyFailure(2, ["a", "b"], window, {}, stream);
  assert(
    String(verdict.assertion).startsWith(rustPanicHeader("a::slow", "src/a.rs:3:3")),
    `consolidate: the real panic is still quoted, so the veto is not simply off (got ${JSON.stringify(String(verdict.assertion).slice(0, 70))})`,
  );
  assert(
    consolidatedFailureMessage(verdict, CMD).includes("a::slow"),
    "consolidate: the handoff names the genuinely failing test",
  );
  // The same bytes with the caller NOT threading the stream: the passing
  // sibling's `ok` is not in the window, so the name-correlated ask cannot see
  // it and the capture would be quoted. That is the shape the required
  // parameter exists to make unrepresentable.
  assert(
    extractSpecificAssertion(window, window).includes(`thread '${PASSING}'`) ||
      extractSpecificAssertion(window, window).startsWith(
        rustPanicHeader("a::slow", "src/a.rs:3:3"),
      ),
    `consolidate: asked on the window alone the veto loses its evidence (got ${JSON.stringify(extractSpecificAssertion(window, window).slice(0, 60))})`,
  );
}

// ── 3. the MONOTONE ok rule: any ok for the exact name vetoes ────────────────
{
  // Two crates of one workspace run the SAME test name: the stream prints
  // `ok` for one and `FAILED` for the other. The pre-fix last-word rule let
  // the later FAILED speak for the name, which unshielded the PASSING
  // crate's captured panic and quoted it — the #746 fold the whole ticket
  // exists to kill (the capture prints byte-identically in both runs, so the
  // base's captured assertion then excused the change's real failure). Any
  // `ok` for the exact name vetoes, in any order; the veto only ever gains
  // refusals, and a refusal is the loud direction.
  const name = "tb::t";
  const stream = [
    `test ${name} ... ok`,
    pad(50, "tb"),
    `test ${name} ... FAILED`,
    rustPanicHeader(name, "src/tb.rs:6:6"),
    "assertion failed: the later target really failed",
  ].join("\n");
  const { tail } = extractAttributedTail(stream, 1500);
  assert(
    extractSpecificAssertion(tail, stream) === NO_SPECIFIC_ASSERTION,
    `monotone-ok: an earlier ok beside a later FAILED for the SAME name still vetoes — the passing crate's capture is never quoted (got ${JSON.stringify(extractSpecificAssertion(tail, stream).slice(0, 60))})`,
  );
  const stillGreen = stream.replace(`test ${name} ... FAILED`, `test tb::other ... FAILED`);
  assert(
    extractSpecificAssertion(extractAttributedTail(stillGreen, 1500).tail, stillGreen) ===
      NO_SPECIFIC_ASSERTION,
    "monotone-ok: with the later FAILED moved to another name, this name's ok still vetoes",
  );
}

// ── 4. the name match is EXACT, not a prefix ────────────────────────────────
{
  const name = "px::t";
  const stream = [
    `test ${name}2 ... ok`,
    `test ${name}::nested ... ok`,
    pad(50, "px"),
    rustPanicHeader(name, "src/px.rs:1:1"),
    "assertion failed: a prefix-named sibling passed, I did not",
  ].join("\n");
  const { tail } = extractAttributedTail(stream, 1500);
  assert(
    extractSpecificAssertion(tail, stream).startsWith(rustPanicHeader(name, "src/px.rs:1:1")),
    `exact-name: neither a::t2 nor a::t::nested answers for a::t (got ${JSON.stringify(extractSpecificAssertion(tail, stream).slice(0, 60))})`,
  );
  const passedToo = `${stream}\ntest ${name} ... ok`;
  assert(
    extractSpecificAssertion(extractAttributedTail(passedToo, 1500).tail, passedToo) ===
      NO_SPECIFIC_ASSERTION,
    "exact-name: the veto does fire once the EXACT name has its own ok — the rule is name-correlated, not off",
  );
}

// ── 5. gatePerAssertion drives the flake suppression on the same verdict ─────
{
  const captured = [
    pad(20, "gp"),
    `test ${PASSING} ... ok`,
    rustPanicHeader(PASSING, "src/gp.rs:2:2"),
    CAPTURE_MESSAGE,
  ].join("\n");
  assert(
    gatePerAssertion(captured) === null,
    `gate: a passing test's captured panic is UNKNOWN to the flake gate, never a known assertion (got ${JSON.stringify(gatePerAssertion(captured))})`,
  );
  const failing = [
    pad(20, "gf"),
    `test gf::t ... FAILED`,
    rustPanicHeader("gf::t", "src/gf.rs:2:2"),
    "assertion failed: a real defect",
  ].join("\n");
  assert(
    gatePerAssertion(failing)?.startsWith(rustPanicHeader("gf::t", "src/gf.rs:2:2")) === true,
    `gate: a genuinely failing panic is a KNOWN assertion to the flake gate (got ${JSON.stringify(gatePerAssertion(failing))})`,
  );
}

// ── 6. the UNOBSERVED-NAME boundary and the #1762 counterweight ─────────────
{
  // A panic whose thread name appears in NO per-test verdict line is not
  // refused: the veto's ONLY evidence is the verdict for the exact name, and
  // neither a target-level tally nor a `---- <name> stdout ----` block label
  // says which test printed a header. The shape this must never swallow is
  // #1762's chain — a green STAGE followed by a later binary dying as `main`,
  // with no capture label and nothing closing below it — which anchors and
  // quotes.
  const chainStage = [
    "running 3 tests",
    "test m::a ... ok",
    "test m::b ... ok",
    "test m::c ... ok",
    "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  ].join("\n");
  const chain = [
    chainStage,
    pad(30, "chain"),
    "thread 'main' panicked at src/main.rs:12:5:",
    "smoke check failed: expected 200 got 500",
  ].join("\n");
  assert(
    extractSpecificAssertion(extractAttributedTail(chain, 1500).tail, chain).startsWith(
      "thread 'main' panicked at src/main.rs:12:5:",
    ),
    "chain shape (#1762): the bare binary panic below a completed green stage still quotes",
  );
  // ...and its control: once `main` has an ok line of its own, the name arm
  // vetoes — the refusals are name-correlated, not a ban on `main`.
  const chainMainOk = chain.replace("running 3 tests", "running 3 tests\ntest main ... ok");
  assert(
    extractSpecificAssertion(extractAttributedTail(chainMainOk, 1500).tail, chainMainOk) ===
      NO_SPECIFIC_ASSERTION,
    "chain shape control: with `test main ... ok` present the veto still fires — the rule is name-correlated",
  );
  // KNOWN-DEFERRED BOUNDARY, deliberately UNPINNED as a QUOTE refusal: a panic
  // on a non-test thread inside an otherwise green target (`worker-N` in a run
  // whose tally closed `0 failed`) and a `#[should_panic]` DOCTEST (`thread
  // 'main' panicked at src/lib.rs:5:5:` beside
  // `test src/lib.rs - parses (line 3) ... ok`) are captured prints whose
  // thread the run never named in a verdict, and they are quoted. Refusing the
  // quote needs cargo's per-target banner identity (`     Running unittests
  // …`, `   Doc-tests pkg`), which no reader in this build parses — and
  // `main` recognises no Rust panic line at all, so the same streams reported
  // honest absence there: the cargo/libtest dialect, and the quoting with it,
  // is this module's. What the shipped code does instead of guessing is
  // `panicCanExcuseChange`: the capture stays quotable to the operator, and a
  // Rust panic excuses a change-added failure ONLY on the base run's own
  // per-test line naming that exact test FAILED — all three cases pinned below.
  const unobserved = [
    "running 2 tests",
    "test g::one ... ok",
    "test g::two ... ok",
    pad(40, "unobs"),
    rustPanicHeader("worker-3", "src/pool.rs:41:9"),
    "assertion failed: the value the change broke",
    "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured",
    "make: *** [Makefile:12: e2e] Error 1",
  ].join("\n");
  const unobservedTail = extractAttributedTail(unobserved, 1500).tail;
  const unobservedAssertion = extractSpecificAssertion(unobservedTail, unobserved);
  assert(
    unobservedAssertion.startsWith("thread 'worker-3' panicked at src/pool.rs:41:9:"),
    `unobserved name (#2341): the worker-thread panic is still QUOTED to the operator (got ${JSON.stringify(unobservedAssertion.slice(0, 60))})`,
  );
  assert(
    baselineExplainsChange(
      {
        status: "red",
        rawStream: unobserved,
        probed: true,
        exitCode: 101,
        assertion: unobservedAssertion,
      },
      [{ text: unobserved, timedOut: false }],
    ) === false,
    "unobserved name (#2341): and the same header never EXCUSES — the run reported no FAILED for that thread, so it is no evidence about the base",
  );
  // The guard is not a ban on panics: the same pair, with the name reported
  // FAILED by the base run's own verdict line, still excuses.
  const failingName = "g::bad";
  const observedFailed = [
    "running 2 tests",
    "test g::one ... ok",
    `test ${failingName} ... FAILED`,
    rustPanicHeader(failingName, "src/bad.rs:3:3"),
    "assertion failed: the value that was already broken at base",
    "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured",
    "error: test failed, to rerun pass `--lib`",
  ].join("\n");
  const failedAssertion = extractSpecificAssertion(observedFailed, observedFailed);
  assert(
    baselineExplainsChange(
      {
        status: "red",
        rawStream: observedFailed,
        probed: true,
        exitCode: 101,
        assertion: failedAssertion,
      },
      [{ text: observedFailed, timedOut: false }],
    ) === true,
    `observed FAILED (#2341): a panic the base run DID report failing still excuses — the gate is evidence, not a ban (assertion ${JSON.stringify(failedAssertion.slice(0, 48))})`,
  );
}

// ── 7. the record is not its own stream: publishers thread the raw run ──────
{
  // The per-worktree RECORD is a formatted, clipped tail; the `test a::t
  // ... ok` line that proves the panic below it is a passing capture sits
  // above the clip. Asked on the record alone the veto was UNDECIDABLE and
  // the capture became a "known assertion" to the flake gate and a
  // "per-workstream defect" to the classifier — a wrong verdict on bytes the
  // clipping edited. Both readers now take the run's raw output alongside.
  const stream = [
    "running 3 tests",
    `test ${PASSING} ... ok`,
    pad(60, "rec"),
    rustPanicHeader(PASSING, "src/a.rs:7:5"),
    CAPTURE_MESSAGE,
    "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
  ].join("\n");
  const { tail } = extractAttributedTail(stream, 300);
  assert(
    tail.includes(rustPanicHeader(PASSING, "src/a.rs:7:5")) &&
      !tail.includes(`test ${PASSING} ... ok`),
    "record divergence: the clipped record really does carry the capture without its verdict",
  );
  const record = `verify command \`${CMD}\` failed in /wt: ${tail}`;
  assert(
    gatePerAssertion(record) !== null,
    "record divergence: asked on the record alone the flake gate still quotes the capture (what the threading exists to fix)",
  );
  assert(
    gatePerAssertion(record, stream) === null,
    `record divergence: with the raw stream the capture is UNKNOWN to the gate, never a known assertion (got ${JSON.stringify(gatePerAssertion(record, stream))})`,
  );
  const withoutStreams = classifyConsolidatedVerifyFailure(2, ["a", "b"], record, { a: record }, stream);
  const withStreams = classifyConsolidatedVerifyFailure(2, ["a", "b"], record, { a: record }, stream, {
    a: stream,
  });
  assert(
    withoutStreams.classification === "per-workstream-defect",
    "record divergence: without the stream the classifier blames the workstream whose test PASSED (the pre-fix shape)",
  );
  assert(
    withStreams.classification !== "per-workstream-defect",
    `record divergence: with the raw stream the classifier never attributes a passing workstream's capture as its defect (got ${withStreams.classification})`,
  );
}

process.exit(failed() ? 1 : 0);
