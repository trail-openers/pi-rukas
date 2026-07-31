#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: PR277 R7: direct unit tests for countSkipMarkersInDiffLine.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { SKIP_MARKERS, countSkipMarkersInDiffLine } from "../src/work-driver-skip-ratchet.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// ============================================================================
// PR277 — R7: direct unit tests for countSkipMarkersInDiffLine
// ============================================================================
{
  // R1 regression: even number of backslashes — the quote DOES terminate.
  assert(
    countSkipMarkersInDiffLine('+const p = "a\\\\"; it.skip("x")') === 1,
    "R7: even backslashes before quote — quote terminates, marker after string counts",
  );

  // #[ignore] alone on a line counts 1 (Rust attribute, not a comment).
  assert(
    countSkipMarkersInDiffLine("+#[ignore]") === 1,
    "R7: #[ignore] alone counts 1 (Rust attribute)",
  );

  // Shell comment with # prefix — should NOT count.
  assert(
    countSkipMarkersInDiffLine("+# a shell comment mentioning it.skip(") === 0,
    "R7: shell comment # it.skip( counts 0",
  );

  // Multiple same-marker instances on one line.
  assert(
    countSkipMarkersInDiffLine('+it.skip("a"); it.skip("b"); it.skip("c")') === 3,
    "R7: three it.skip( on one line counts 3",
  );

  // Marker inside double quotes counts 0.
  assert(
    countSkipMarkersInDiffLine('+console.log("it.skip(")') === 0,
    "R7: it.skip( inside double quotes counts 0",
  );

  // Marker inside single quotes counts 0.
  assert(
    countSkipMarkersInDiffLine("+console.log('it.skip(')") === 0,
    "R7: it.skip( inside single quotes counts 0",
  );

  // Marker inside backtick template literal counts 0.
  assert(
    countSkipMarkersInDiffLine('+`it.skip("test")`') === 0,
    "R7: it.skip( inside backticks counts 0",
  );

  // R2 regression: trailing comment — should NOT count.
  assert(
    countSkipMarkersInDiffLine('+code(); // it.skip("later")') === 0,
    "R7: trailing comment // it.skip( counts 0",
  );

  // "http://example.com" followed by a real marker — the // inside string
  // must NOT start a comment, so the real marker still counts.
  assert(
    countSkipMarkersInDiffLine('+const u = "http://example.com"; it.skip("x")') === 1,
    "R7: // inside string does not start comment; real marker after counts 1",
  );

  // C-style comment line — should NOT count.
  assert(
    countSkipMarkersInDiffLine("+// TODO: convert to it.skip(") === 0,
    "R7: full line // comment counts 0",
  );

  // Multi-line comment start — should NOT count.
  assert(
    countSkipMarkersInDiffLine('+/* it.skip("test") */') === 0,
    "R7: /* comment start counts 0",
  );

  // Multi-line comment continuation — should NOT count.
  assert(
    countSkipMarkersInDiffLine('+* it.skip("test")') === 0,
    "R7: * comment continuation counts 0",
  );

  // ODD number of backslashes — the quote IS escaped, marker is still in string.
  assert(
    countSkipMarkersInDiffLine('+const p = "a\\"; it.skip("x")') === 0,
    "R7: odd backslashes (1) — quote escaped, marker in string counts 0",
  );

  // describe.skip(
  assert(
    countSkipMarkersInDiffLine('+describe.skip("suite")') === 1,
    "R7: describe.skip( counts 1",
  );

  // @Disabled
  assert(countSkipMarkersInDiffLine("+@Disabled") === 1, "R7: @Disabled counts 1");

  // pytest.mark.skip
  assert(
    countSkipMarkersInDiffLine('+@pytest.mark.skip(reason="flaky")') === 1,
    "R7: pytest.mark.skip counts 1",
  );

  // t.Skip(
  assert(countSkipMarkersInDiffLine('+t.Skip("no db")') === 1, "R7: t.Skip( counts 1");

  // Negative line (removal) — countSkipMarkersInDiffLine returns positive count,
  // caller applies the sign.
  assert(
    countSkipMarkersInDiffLine('-it.skip("old")') === 1,
    "R7: negative line returns positive count (sign applied by caller)",
  );

  // F1: word-boundary guard — pytest.mark.skipif should NOT match pytest.mark.skip.
  assert(
    countSkipMarkersInDiffLine('+pytest.mark.skipif(sys.platform == "win32")') === 0,
    "R7: pytest.mark.skipif does NOT match pytest.mark.skip (word boundary)",
  );

  // F1: pytest.mark.skip at end of line counts 1.
  assert(
    countSkipMarkersInDiffLine("+pytest.mark.skip") === 1,
    "R7: pytest.mark.skip at end of line counts 1",
  );

  // F1: pytest.mark.skip with (reason) counts 1 — paren is not an identifier char.
  assert(
    countSkipMarkersInDiffLine('+pytest.mark.skip(reason="x")') === 1,
    "R7: pytest.mark.skip(reason=...) counts 1 (paren is boundary)",
  );

  // F1: @DisabledOnOs should NOT match @Disabled.
  assert(
    countSkipMarkersInDiffLine("+@DisabledOnOs(OS.WINDOWS)") === 0,
    "R7: @DisabledOnOs does NOT match @Disabled (word boundary)",
  );

  // F1: @Disabled alone at end of line counts 1.
  assert(countSkipMarkersInDiffLine("+@Disabled") === 1, "R7: @Disabled at end of line counts 1");

  // F1: @Disabled with reason counts 1 — paren is not an identifier char.
  assert(
    countSkipMarkersInDiffLine('+@Disabled("flaky")') === 1,
    'R7: @Disabled("flaky") counts 1 (paren is boundary)',
  );

  // F5: known limitation — unterminated string on a diff line hides later markers.
  // From a multi-line template literal, the second line is a fragment with odd quotes.
  assert(
    countSkipMarkersInDiffLine('+"it.skip(') === 0,
    "R7: known limitation: unterminated string on a diff line hides later markers (false negative)",
  );

  // F6: known limitation — mid-line block comment is NOT filtered.
  // Only line-leading /* and * are excluded; mid-line /* */ passes through.
  assert(
    countSkipMarkersInDiffLine('+code() /* it.skip("x") */') === 1,
    "R7: known limitation: mid-line block comment is not filtered (false positive)",
  );

  // F1 invariant: no SKIP_MARKERS entry is a proper prefix of another.
  // This pins the corrected break→continue semantics in
  // countSkipMarkersInDiffLine: the word-boundary guard uses `continue` so
  // the loop genuinely tries the next marker after a boundary rejection.
  // With the current marker set this distinction is latent (no marker is a
  // prefix of another), but it is a live trap: adding `pytest.mark.skipif`
  // after `pytest.mark.skip` would silently never match the longer marker
  // if the guard used `break`. This invariant fails loudly the day someone
  // adds an overlapping marker, exactly when the break→continue fix matters.
  for (const a of SKIP_MARKERS) {
    for (const b of SKIP_MARKERS) {
      if (a === b) continue;
      assert(
        !b.startsWith(a),
        `R7 invariant: "${a}" is not a proper prefix of "${b}" — if this fails, the word-boundary loop must use 'continue' (not 'break')`,
      );
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
