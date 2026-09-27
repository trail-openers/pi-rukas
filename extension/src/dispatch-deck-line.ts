/**
 * Single-row terminal-safe rendering for untrusted content (#839 live view,
 * deck roster rows, steer prompts).
 *
 * pi-tui's differential renderer requires every string returned by
 * `render(width)` (or stored in a widget Text row) to be exactly ONE
 * terminal row whose `visibleWidth` is ≤ the column budget. A raw newline,
 * carriage return, tab, C0/C1 control character, or a stray ANSI escape
 * from UNTRUSTED content (child assistant text, tool arguments, tool results,
 * entry labels, key fragments) desyncs its line accounting — the overlay
 * text interleaves with the main chat, every 1 s re-render leaves a new
 * ghost copy in scrollback, and the ghosting survives the overlay close.
 *
 * These helpers sanitise untrusted text ONCE at the render boundary so no
 * deck surface can emit a line that violates the invariant:
 *
 *   - `sanitizeText`   — normalise + strip control chars / ANSI escapes
 *   - `toTerminalLine` — the one-line form: newlines → ` ⏎ `, width-bounded
 *   - `toTerminalLines` — the wrapping form (split on newlines, each row
 *                        width-bounded) for surfaces that may render
 *                        multiple rows (#916 full wrapping)
 *   - `collapseToSpaces` — whitespace-collapses to ONE line (feeds the deck
 *                        row hint / live-view arg preview); the ` ⏎ ` newline
 *                        separator belongs to `toTerminalLine`, NOT here
 *
 * All functions are pure and synchronous (render hot path, 1 s cadence).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * The visible separator `toTerminalLine` inserts where a newline used to be,
 * so multi-line tool results stay readable on one overlay row.
 */
export const NEWLINE_SEP = " ⏎ ";

// ANSI / control-char stripping is a plain character scanner (no regexes,
// so no control characters appear in the source at all): the scanner
// recognises ESC (0x1b) sequences — CSI (`[`), OSC (`]`), or a single
// following char — plus C1 CSI (0x9b `[`) the same way, and drops remaining
// C0/C1 code points (a lone 0x9b is a stray C1 char, dropped alone — the
// same shape the pre-#927 regex pipeline produced, where only `ESC [` was
// a CSI escape and a bare `9b` fell to the C0/C1 sweep).
const CODE_ESC = 0x1b;
const CODE_CSI_C1 = 0x9b;
const CODE_BEL = 0x07;

/** Drop ANSI escape sequences and stray C0/C1 control characters. */
function stripAnsiAndControl(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === CODE_ESC || (ch === CODE_CSI_C1 && text.charCodeAt(i + 1) === 0x5b)) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI: skip through the final byte (0x40–0x7e).
        for (let j = i + 2; j < text.length; j++) {
          if (text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e) {
            i = j;
            break;
          }
        }
      } else if (next === 0x5d) {
        // OSC: skip until BEL or the ST sequence (ESC `\`).
        for (let j = i + 2; j < text.length; j++) {
          if (text.charCodeAt(j) === CODE_BEL) {
            i = j;
            break;
          }
          if (text.charCodeAt(j) === CODE_ESC && text.charCodeAt(j + 1) === 0x5c) {
            i = j + 1;
            break;
          }
        }
      } else {
        // ESC + single char: drop both (also a lone ESC at end of string).
        i += 1;
      }
    } else if ((ch < 0x20 && ch !== 0x0a && ch !== 0x09) || (ch >= 0x7f && ch <= 0x9f)) {
      // Remaining C0 (except \n / \t, handled separately) and C1: drop.
    } else {
      out += text.charAt(i);
    }
  }
  return out;
}

/**
 * Sanitise untrusted text into terminal-safe characters:
 *
 *   - normalise `\r\n` / `\r` to `\n`;
 *   - replace tabs with single spaces;
 *   - strip ANSI escape sequences (CSI / OSC / other ESC sequences) — the
 *     text comes from child tool output and assistant text, NOT from the
 *     component's own theme styling;
 *   - strip remaining C0/C1 control characters (BEL, NUL, etc.).
 *
 * Deliberately does NOT touch `\n` — the row-shaping is the caller's call
 * (collapse vs split).
 */
export function sanitizeText(text: string): string {
  const normalised = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return stripAnsiAndControl(normalised).replaceAll("\t", " ");
}

/**
 * Width-bound a terminal-safe string with a visible ellipsis. Uses pi-tui's
 * `truncateToWidth`, so CJK / emoji wide characters are measured by
 * `visibleWidth`, not by char count. A ≤0 width yields an empty string, so
 * an over-full row can never overflow its budget.
 */
export function boundedLine(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…");
}

/**
 * One terminal-safe line, width-bounded. Newlines inside the text collapse
 * to the visible ` ⏎ ` separator (the live-view overlay's layout — one row
 * per event; #916 adds real wrapping via `toTerminalLines`). The result is
 * guaranteed: no `\n` / `\r` / control chars, `visibleWidth` ≤ `width`.
 */
export function toTerminalLine(text: string, width: number): string {
  return boundedLine(sanitizeText(text).replace(/\n+/g, NEWLINE_SEP), width);
}

/**
 * Multiple terminal-safe lines, each width-bounded, split on newlines of the
 * sanitised text. For surfaces that render a wrapped multi-line block
 * (#916) — every returned row independently satisfies the single-row
 * invariant `toTerminalLine` enforces.
 */
export function toTerminalLines(text: string, width: number): string[] {
  const rows = sanitizeText(text).split("\n");
  return rows.map((r) => (r.length === 0 ? " " : boundedLine(r, width)));
}

/**
 * Whitespace-collapse to a single line (the shape the deck roster hint and
 * the live-view arg preview already used, `replaceAll(/\s+/g, " ")`), with
 * the full sanitisation applied FIRST so control chars and ANSI escapes
 * cannot survive into the deck row or the overlay. The caller bounds the
 * length; the width-bound (CJK safety) is applied at render time by the
 * surface that knows its own column budget.
 */
export function collapseToSpaces(text: string): string {
  return sanitizeText(text).replaceAll(/\s+/g, " ").trim();
}
