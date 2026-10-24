#!/usr/bin/env bun
/**
 * #1762 / #1770 round 2 — the COST and OFFSET contracts of the failure-line
 * reader, measured rather than asserted about.
 *
 * Split out of `test-verify-failure-shapes-b-1762.ts` along the seam AGENTS.md
 * §12 draws (that file had grown past the cap): the stream-reader suite asks what a
 * reader RETURNS; this one asks what it COSTS and WHERE it lands. Three contracts,
 * each of which round 1 did not hold:
 *
 *   - **The candidate walk is bounded, not just the candidate count.** A cap on the
 *     RESULT of an `indexOf` loop is not a cost bound while the loop still walks to
 *     the end of the line hunting for a candidate that never arrives (249 s
 *     measured on a 1 MB line before the walk window).
 *   - **Every inner line of a wrapper's stream is clipped** before the table sees
 *     it, so one pathological line inside a stream cannot hand a regex a document.
 *   - **Anchor offsets survive `\r\n` and `\r`.** A reader that advances by one
 *     character per line drifts a character per line and anchors the evidence tail
 *     inside the line ABOVE the failure — the shape pinned in the drift case below.
 *
 * D2 lives here too: `isNonAssertionLine` is asserted DIRECTLY, so a change that
 * keeps every caller green while loosening the veto itself cannot pass.
 */

import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import { isNonAssertionLine } from "../src/work-driver-verify-assertion.ts";
import { separatorScanWindow } from "../src/work-driver-verify-inner-line.ts";
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
} from "../src/work-driver-verify-failures.ts";
import { CHECKS_BLOCK, CMD, PASSING, TIMING, WT, makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── B1/B2/B3 (#1762 round 2) — the bounds, measured ────────────────────────────────
// Three cost/offset contracts the round-1 code did not hold, each pinned by what
// it costs or where it lands, not by the shape of the code.
{
  // B1 — the candidate WALK is bounded, not just the candidate COUNT. A single line
  // of `": "` repeated is the pathological input: `streamSeparators` walks it with
  // `indexOf`, and a cap on the RESULT still scans for one more. The classifier
  // must answer a line of any size in well under 200 ms.
  const wrapperOf = (payload: string): string =>
    `verify command \`${CMD}\` failed in ${WT}: ${payload}`;
  for (const [label, payload] of [
    ["8 KiB", ": ".repeat(4 * 1024)],
    ["1 MB", ": ".repeat(512 * 1024)],
  ] as const) {
    const line = wrapperOf(payload);
    const started = performance.now();
    const got = classifyFailureLine(line);
    const ms = performance.now() - started;
    assert(got === undefined, `walk bound (${label}): padding alone reports no failure`);
    // A generous wall bound: the point is that the cost is CONSTANT in the line's
    // length, and the unbounded scan measured 249 s on a 1 MB line — three orders
    // of magnitude above this. A slow machine must not fail this for being slow, so
    // the bound is loose on purpose; a regression that restores an unbounded scan
    // cannot hide under it.
    assert(ms < 2000, `walk bound (${label}): classified in ${ms.toFixed(1)} ms (< 2000 ms)`);
  }
  // The window itself is derived from the classifier's bound, so the two cannot
  // drift: a walk window below `FAILURE_LINE_SCAN_MAX` would let a harness prefix
  // eat the gate's report, and one unbounded is the cost the item closes.
  assert(
    separatorScanWindow() > FAILURE_LINE_SCAN_MAX,
    `walk bound: the window is at least the scan window (${separatorScanWindow()})`,
  );

  // B2 — an INNER line of a wrapper's stream is clipped too. A wrapper whose stream
  // is one pathological line must not hand `matchShape` an unclipped document.
  {
    const wide = wrapperOf(`${CHECKS_BLOCK}\n${"a, failed ".repeat(200_000)}`);
    const started = performance.now();
    const got = classifyFailureLine(wide);
    const ms = performance.now() - started;
    assert(
      got?.shape === "script-tally",
      `inner clip: the gate's own line still classifies behind a pathological neighbour (got ${JSON.stringify(got)})`,
    );
    assert(ms < 2000, `inner clip: classified in ${ms.toFixed(1)} ms (< 2000 ms)`);
  }

  // B3 — offsets survive `\r\n`. The evidence tail must START at the failure line,
  // which is only true if the anchor offset advanced by the width of every
  // separator it crossed rather than by one character.
  {
    const fail = "✗ the token comparison disagreed with the fixture";
    const crlf = [TIMING, PASSING, fail, TIMING].join("\r\n");
    const tail = extractAttributedTail(crlf, 800);
    assert(tail.attributed, "crlf: the failure line anchors the tail");
    assert(
      tail.tail.startsWith(fail),
      `crlf: the tail starts EXACTLY at the failure line (got ${JSON.stringify(tail.tail.slice(0, 60))})`,
    );
    const cr = [TIMING, PASSING, fail, TIMING].join("\r");
    const crTail = extractAttributedTail(cr, 800);
    assert(
      crTail.attributed && crTail.tail.startsWith(fail),
      `cr: a bare-carriage-return stream anchors exactly (got ${JSON.stringify(crTail.tail.slice(0, 60))})`,
    );
    // The regression this pins: under the old `+1` advance the offset drifted one
    // character per line, so a three-line preamble anchored the tail one character
    // EARLY — the last character of the line above the failure.
    const drift = ["0123456789", "0123456789", fail].join("\r\n");
    const driftTail = extractAttributedTail(drift, 800);
    assert(
      driftTail.tail === fail,
      `crlf: no drift from the lines above (got ${JSON.stringify(driftTail.tail)})`,
    );
  }

  // D2 — the extractor's non-assertion veto is one predicate, asserted directly
  // here so a change that keeps the callers green while loosening the veto fails.
  for (const [line, why] of [
    ["FAILED: smoke-tests/test-x.ts", "a bare marker names a file, not an assertion"],
    ["$ bun run check", "an echoed command is a passing stage, not an assertion"],
    [`api_key = ${"a".repeat(24)}`, "a credential-shaped line is never evidence"],
  ] as const) {
    assert(
      isNonAssertionLine(line) === true,
      `isNonAssertionLine (${why}): ${JSON.stringify(line)} is refused`,
    );
  }
  assert(
    isNonAssertionLine(CHECKS_BLOCK) === false,
    "isNonAssertionLine: the gate's own failing-check line is not refused",
  );
}

console.log(failed() ? "\nFAILED" : "\nAll #1762 round-2 cost and offset checks passed.");
process.exit(failed() ? 1 : 0);
