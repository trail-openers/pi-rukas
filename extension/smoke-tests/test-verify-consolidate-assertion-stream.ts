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
 *   - the tie-break: the LAST per-test line for the exact name decides, so an
 *     earlier `ok` beside a later `FAILED` for that name does not veto;
 *   - the name match is EXACT — `a::t` is answered for by neither `a::t2` nor
 *     `a::t::nested`;
 *   - `gatePerAssertion`, which drives the flake re-run suppression, sees the
 *     same verdict on the same bytes.
 */

import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "../src/work-driver-consolidation-classify.ts";
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

// ── 3. the tie-break: the LAST per-test line for the exact name decides ──────
{
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
    extractSpecificAssertion(tail, stream).startsWith(rustPanicHeader(name, "src/tb.rs:6:6")),
    "tie-break: an earlier ok beside a later FAILED for the SAME name does not veto — the run's final word is FAILED",
  );
  const stillGreen = stream.replace(`test ${name} ... FAILED`, `test tb::other ... FAILED`);
  assert(
    extractSpecificAssertion(extractAttributedTail(stillGreen, 1500).tail, stillGreen) ===
      NO_SPECIFIC_ASSERTION,
    "tie-break: with the later FAILED moved to another name, this name's ok is the last word and it vetoes",
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

process.exit(failed() ? 1 : 0);
