/**
 * work-driver-exec-error — attribution-aware evidence-tail extraction.
 *
 * #723 — `.pi/verify-cmd` is one shell line chaining several sub-commands
 * (typecheck, biome, then a smoke-test loop) into a single combined
 * stdout+stderr stream. A naive `.slice(-N)` of that stream can splice the
 * tail of an earlier PASSING sub-command onto the START of a later FAILING
 * one, so a handoff reads as "biome failed" when biome actually exited 0 and
 * a smoke test two sub-commands later is what failed.
 *
 * `.pi/verify-cmd`'s smoke-test loop prints `FAILED: <test file>` immediately
 * before re-running the failing test verbosely (see the file itself). That
 * line is a reliable anchor: when present, the tail starts there rather than
 * at a fixed byte offset from the end, so the reported evidence begins at the
 * actual failure, not wherever the fixed-size window happens to land.
 *
 * Accepted limitation: the anchor is `^FAILED: .+$`, matched anywhere in the
 * combined stream and resolved to the LAST occurrence. A test whose own
 * verbose output happens to print a line of that exact shape (e.g. a test
 * asserting on marker-parsing text elsewhere in this codebase) could shift
 * the anchor away from the real verify-cmd marker and lose attribution for
 * that run. This is deliberately not special-cased — disambiguating "which
 * FAILED: line is the real one" would require either a distinguishing
 * prefix `.pi/verify-cmd` doesn't provide (it's project-supplied, not owned
 * by this repo) or brittle heuristics over test output shapes. The fallback
 * path (`attributed: false`) is the safety net when the anchor is wrong or
 * absent; test-exec-error-attribution.ts pins the last-marker behaviour so
 * this tradeoff stays deliberate and visible.
 */

/** The exact marker `.pi/verify-cmd`'s smoke-test loop emits on failure. */
const FAILED_MARKER_RE = /^FAILED: .+$/gm;

/** Result of tail extraction: the text, and whether it's anchored evidence. */
export interface AttributedTail {
  /** The extracted, bounded evidence tail. */
  tail: string;
  /** True when `tail` starts at a `FAILED:` marker (attribution is sound). */
  attributed: boolean;
}

/**
 * Extract an evidence tail from combined command output, anchored on the
 * failure marker when present so a passing sub-command's output is never
 * misattributed as the cause. Falls back to the last `maxLen` chars when no
 * marker is found (a single-command failure, or a shape this doesn't know
 * about) — the pre-#723 behaviour, preserved as the fallback rather than the
 * default, but now flagged via `attributed: false` rather than silently.
 */
export function extractAttributedTail(combined: string, maxLen: number): AttributedTail {
  const trimmed = combined.trim();
  if (!trimmed) return { tail: "", attributed: false };
  // Anchor on the LAST marker — a chain can only fail once (the loop
  // `exit 1`s right after), but staying on the last occurrence keeps this
  // correct if a future verify-cmd shape prints more than one.
  const matches = [...trimmed.matchAll(FAILED_MARKER_RE)];
  const last = matches[matches.length - 1];
  if (last?.index !== undefined) {
    const fromMarker = trimmed.slice(last.index);
    if (fromMarker.length <= maxLen) return { tail: fromMarker, attributed: true };
    // Still bound the size — the verbose re-run after the marker can itself
    // be long — but preserve BOTH ends: the marker line (attribution) and
    // the tail of the anchored region (where the real assertion failure /
    // diff / stack trace lives), not just the head.
    const newline = fromMarker.indexOf("\n");
    const markerLine = newline === -1 ? fromMarker : fromMarker.slice(0, newline);
    const elision = "\n...\n";
    const remaining = maxLen - markerLine.length - elision.length;
    const tail =
      remaining > 0
        ? markerLine + elision + fromMarker.slice(-remaining)
        : fromMarker.slice(0, maxLen);
    return { tail, attributed: true };
  }
  return { tail: trimmed.slice(-maxLen), attributed: false };
}
