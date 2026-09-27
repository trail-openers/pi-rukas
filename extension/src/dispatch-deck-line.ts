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
 *   - `collapseToSpaces` — the existing whitespace-collapse shape (feeds
 *                        the deck row hint / live-view arg preview)
 *
 * All functions are pure and synchronous (render hot path, 1 s cadence).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * The visible separator `toTerminalLine` inserts where a newline used to be,
 * so multi-line tool results stay readable on one overlay row.
 */
export const NEWLINE_SEP = " ⏎ ";

// Pre-built regexes for ANSI / control-char stripping. Patterns are built
// from char codes so the source contains no literal control characters
// (biome noControlCharactersInRegex forbids them in regex literals and
// template literals alike). The `new RegExp` constructor is used
// deliberately because the patterns are built from variables.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
// biome-ignore lint/suspicious/noControlCharactersInRegex: patterns built from ESC/BEL char codes
const ANSI_CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
// biome-ignore lint/suspicious/noControlCharactersInRegex: patterns built from ESC/BEL char codes
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g");
// biome-ignore lint/suspicious/noControlCharactersInRegex: patterns built from ESC/BEL char codes
const ANSI_OTHER = new RegExp(`${ESC}[@-Z\\\\]-`, "g");
// biome-ignore lint/suspicious/noControlCharactersInRegex: patterns built from ESC/BEL char codes
const C0_C1 = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

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
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_OTHER, "")
    .replace(C0_C1, "");
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
