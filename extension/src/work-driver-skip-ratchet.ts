/**
 * Skip-marker detection for the develop-step skip-ratchet gate (PR277). Split
 * out of work-driver.ts (#171) to stay under the module-size guideline
 * (AGENTS.md §12) — pure, standalone string analysis with no state-machine
 * coupling. `verifyStepOutcome` in work-driver.ts is the sole caller.
 */

/**
 * Skip-marker counters — PR277.
 *
 * Scans a single diff line (including the leading +/-) for skip markers,
 * excluding comments and string literals. Single-pass over all markers.
 *
 * R1 fix: counts consecutive backslashes ending at pos-1; a quote is
 *   escaped only when that count is ODD (even count = quote terminates).
 * R2 fix: while outside strings, "//" starts a line comment and the
 *   remainder is ignored (but "//" inside a string does NOT start a
 *   comment).
 */

// Markers the skip-ratchet gate detects. Must stay in sync with the set
// used by verifyStepOutcome when PI_ENSEMBLE_SKIP_RATCHET is active.
export const SKIP_MARKERS = [
  "#[ignore]",
  "it.skip(",
  "describe.skip(",
  "test.skip(",
  "@Disabled",
  "pytest.mark.skip",
  "t.Skip(",
] as const;

/**
 * Count skip markers in a single diff line (including the leading +/-
 * indicator). Returns the number of markers found, excluding those
 * inside comments or string literals.
 *
 * Single-pass: walks the line once, tracking quote-state and a running
 * backslash counter for O(1) escape detection.
 *
 * Comment exclusion: filters full-line comments (`//`, `/*`, `*`, `#`),
 * line-leading block comments, trailing `//` comments, and Rust attributes
 * like `#[ignore]` (NOT treated as comments).
 *
 * Known limitations (single-line analysis, `git diff -U0` yields fragments):
 *
 * - **Unterminated strings on a diff line**: a diff line with an odd number
 *   of quotes (e.g. `+"it.skip(` from a multi-line template literal) will
 *   cause the rest of the line to be parsed as inside a string. Markers
 *   after the unterminated quote are **not counted** (false negative).
 *   Cross-line state cannot be reconstructed reliably from diff fragments.
 *
 * - **Markers on continuation lines inside multi-line strings**: a diff line
 *   that is a continuation of a multi-line template literal (e.g. the second
 *   line `  it.skip("x")`) will look balanced in isolation and the marker
 *   **will be counted** (false positive). Same reconstruction limitation.
 *
 * - **Mid-line block comments**: markers inside a C-style block comment that
 *   starts mid-line ARE counted. Only line-leading `/*` and `*` are filtered.
 *   Adding an `inBlockComment` state is intentionally deferred — the added
 *   complexity costs more than the rare case is worth.
 */
export function countSkipMarkersInDiffLine(line: string): number {
  // Remove the leading +/- and leading whitespace.
  const trimmed = line.slice(1).trimStart();

  // Skip lines that are entirely comments (but NOT Rust attributes like #[ignore]).
  if (trimmed.startsWith("//")) return 0;
  if (trimmed.startsWith("/*")) return 0;
  if (trimmed.startsWith("*")) return 0;
  if (trimmed.startsWith("#") && !trimmed.startsWith("#[")) return 0;

  let count = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let pos = 0;
  let backslashCount = 0;

  while (pos < trimmed.length) {
    const ch = trimmed[pos];

    // Track consecutive backslashes — O(1) incremental counter.
    // A quote is escaped iff backslashCount is ODD at the moment we see it.
    if (ch === "\\") {
      backslashCount++;
      pos++;
      continue;
    }

    // Determine the effective backslash count for this character, then reset.
    const bs = backslashCount;
    backslashCount = 0;

    if (inDoubleQuote) {
      if (ch === '"') {
        if (bs % 2 !== 0) {
          // Escaped quote — stays inside string.
        } else {
          inDoubleQuote = false;
        }
      }
    } else if (inSingleQuote) {
      if (ch === "'") {
        if (bs % 2 !== 0) {
          // Escaped quote.
        } else {
          inSingleQuote = false;
        }
      }
    } else if (inBacktick) {
      if (ch === "`") {
        if (bs % 2 !== 0) {
          // Escaped backtick.
        } else {
          inBacktick = false;
        }
      }
    } else {
      // Outside any string or comment.
      // Check for line-comment start — always extends to end of line.
      if (ch === "/" && trimmed[pos + 1] === "/") {
        break;
      }

      // Check for string starts.
      if (ch === '"') {
        inDoubleQuote = true;
      } else if (ch === "'") {
        inSingleQuote = true;
      } else if (ch === "`") {
        inBacktick = true;
      } else {
        // Check for any skip marker.
        let matchedMarker = false;
        for (const marker of SKIP_MARKERS) {
          if (trimmed.startsWith(marker, pos)) {
            // Word-boundary guard: reject if the character after the marker
            // is an identifier character. Prevents false positives like
            // `pytest.mark.skipif` matching `pytest.mark.skip`, or
            // `@DisabledOnOs` matching `@Disabled`.
            const afterPos = pos + marker.length;
            const nextCh = afterPos < trimmed.length ? trimmed[afterPos] : undefined;
            if (nextCh !== undefined && /[A-Za-z0-9_]/.test(nextCh)) {
              continue; // word-boundary not met; try next marker
            }
            count++;
            pos += marker.length;
            backslashCount = 0;
            matchedMarker = true;
            break; // matched — stop checking other markers at this position
          }
        }
        if (matchedMarker) continue; // skip pos++ (F4: explicit marker advance)
      }
    }

    pos++;
  }

  return count;
}
