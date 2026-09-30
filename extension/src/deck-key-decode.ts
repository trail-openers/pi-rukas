/**
 * #915 — what a key event INSERTS into the agent view's always-focused
 * input line (dispatch-deck-live-view-component.ts).
 *
 * The view's printable-key detection spans TWO protocol dialects at once:
 * the legacy one (a single raw char per keypress) and the Kitty keyboard
 * protocol (CSI-u sequences, auto-negotiated by pi-tui's ProcessTerminal
 * in every modern terminal — Kitty, WezTerm, Ghostty, iTerm2, Windows
 * Terminal). With Kitty active, a plain "a" arrives as `\x1b[97u`, not
 * "a", so the legacy single-char branch never fires and the fallback must
 * know CSI-u.
 *
 * The decision (exported as `decodeInsertable`):
 *   - a single printable ASCII char (32–126) → insert it as-is;
 *   - a Kitty CSI-u / modifyOtherKeys sequence that decodes to a
 *     PRINTABLE character (the strict `decodeKittyPrintable` — the
 *     decoder pi-tui's own Input component uses) → insert the decoded
 *     character (covers non-ASCII: é, CJK, emoji, and shifted letters);
 *   - the start of a bracketed paste (`\x1b[200~`) → strip the marker
 *     (pi-tui's ProcessTerminal wraps every paste in
 *     `\x1b[200~…\x1b[201~`; the end marker is swallowed as unknown) and
 *     filter the pasted content per code point (insertables in,
 *     newlines/CR/tabs to spaces, C0/C1 controls, DEL and PUA dropped —
 *     see `filterPlainText`);
 *   - any other multi-char plain text (an IME composition commit, or
 *     terminal text delivered without bracketed-paste mode) → the same
 *     per-code-point filter;
 *   - everything else (unknown escape sequences — F-keys, mouse SGR,
 *     alt+x, arrow keys, the paste end marker, lone ESC, control bytes)
 *     → swallow. Garbage in the message buffer would desync the
 *     terminal line accounting (the #927 class).
 *
 * The decode result is validated: a non-empty string whose every code
 * point is ≥ 32. That admits é/CJK/emoji (code points 128+) and rejects
 * the control/empty shapes without a per-shape allow-list.
 *
 * Key-release (Kitty flag 2) is filtered in the component BEFORE this
 * decoder is called; the guard at the top of `decodeInsertable` is
 * defence in depth so the decoder stays safe even if the component ever
 * changes shape.
 *
 * Known trade (measured against the pinned pi-tui): the strict
 * decoder is LENIENT about malformed `;u` shapes — a sequence whose
 * numeric prefix is not the pressed key's code point (`\x1b[101u` for
 * "a") reads the sequence tail and decodes to a spurious single
 * character ("e"). pi-tui's own Input component accepts exactly this
 * behaviour (it calls `decodeKittyPrintable` and inserts the result
 * unvalidated), so the view's input matches the rest of the TUI; the
 * alternative — swallowing the spurious decode — would drop characters
 * on terminals that emit those shapes, which is worse. Correct well-formed
 * CSI-u (the common case) decodes exactly: `\x1b[97u` → "a",
 * `\x1b[97;2u` → "a" (shift reported), `\x1b[1101u` → U+1101, F-keys and
 * functional keys (`\x1b[57357u`, `\x1b[57363u`, …) decode to undefined
 * and are swallowed — no raw escape sequence ever reaches the buffer.
 */

import { decodeKittyPrintable, isKeyRelease } from "@earendil-works/pi-tui/dist/keys.js";

/** The bracketed-paste markers pi-tui's ProcessTerminal wraps pastes in. */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * The per-code-point insertability predicate, shared by the legacy
 * single-char path, the CSI-u validation loop, and the per-code-point
 * filter over pasted / multi-char plain text. A code point inserts
 * when it is ≥ 32 and NOT: DEL (127), a C1 control (0x80–0x9F), or a
 * Kitty functional key. The functional-key range is the Private Use
 * Area U+E000–U+F8FF — where Kitty actually places its function keys
 * (F1 = U+E00C…57356, …) — NOT "U+E000 and up": that reading would
 * reject every astral code point (emoji, CJK Ext-B) that terminals
 * legitimately emit as user text.
 */
function isInsertableCodePoint(cp: number): boolean {
  return cp >= 32 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0) && !(cp >= 0xe000 && cp <= 0xf8ff);
}

/**
 * Filter a paste / plain-text chunk per code point: insertables pass
 * through; newlines, CR and tabs collapse to spaces (same shape as the
 * newline collapse below); everything else (C0/C1 controls, DEL, Kitty
 * functional PUA) is dropped. Runs of spaces the mapping produces are
 * collapsed to a single space, as the newline collapse does.
 */
function filterPlainText(data: string): string {
  let out = "";
  for (const ch of data) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInsertableCodePoint(cp)) {
      out += ch;
    } else if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out += " ";
    }
  }
  return out.replace(/\s+/g, " ");
}

/**
 * The text one key event inserts into the input line — or `undefined` to
 * swallow the event (see the module header for the decision table).
 */
export function decodeInsertable(data: string): string | undefined {
  if (data.length === 0) return undefined;
  // Key-release (Kitty flag 2, `\x1b[…:3u`): never insert. Guarded here
  // as well as in the component (defence in depth — a release's CSI-u
  // prefix can decode to a printable char, so without this guard a
  // release would insert its press twin).
  if (isKeyRelease(data)) return undefined;
  if (data.length === 1) {
    // Single-char legacy input: insert any printable character — not just
    // ASCII. Control chars (< 32), DEL (127) and C1 (0x80–0x9F) are
    // swallowed; a lone surrogate (0xD800–0xDFFF) is not a character at
    // all and is swallowed too. (A lone ESC and a lone raw ctrl+t are
    // handled upstream as command keys; they fall to the swallow here if
    // the component ever changes shape.)
    const code = data.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return undefined;
    return isInsertableCodePoint(code) ? data : undefined;
  }
  if (data.startsWith("\u001b")) {
    // A multi-char escape sequence.
    if (data.includes(PASTE_START)) {
      // A bracketed paste (pi-tui wraps every paste in \x1b[200~ …
      // \x1b[201~; the end marker may ride in the same chunk or arrive
      // separately and is swallowed as an unknown sequence). Strip the
      // markers and filter the content per code point — the same shape
      // the paste-free path below produces.
      return filterPlainText(data.split(PASTE_START).join("").split(PASTE_END).join(""));
    }
    // First: a PRINTABLE encoding (Kitty CSI-u or modifyOtherKeys)?
    // decodeKittyPrintable returns a character for those (the strict
    // decoder — see the module header for the trade on malformed `;u`
    // shapes and why not decodePrintableKey).
    // pi-tui's strict decoder returns `String.fromCodePoint(n)` for ANY
    // numeric prefix — it does NOT check the code point against the
    // terminal's actual printable range. Functional keys (F1 = U+E00C
    // = 57356, up = U+E00E, …) "decode" to spurious code points that are
    // NOT user text. The guard (isInsertableCodePoint): a string whose
    // every code point is ≥ 32 and none is DEL, C1 (0x80–0x9F), or a
    // Kitty functional key (the PUA U+E000–U+F8FF only — astral text
    // like emoji or CJK Ext-B must still insert).
    const decoded = decodeKittyPrintable(data);
    if (typeof decoded === "string") {
      let printable = decoded.length > 0;
      for (const ch of decoded) {
        const cp = ch.codePointAt(0);
        if (cp === undefined || !isInsertableCodePoint(cp)) {
          printable = false;
          break;
        }
      }
      if (printable) return decoded;
      // Decoded to a non-printable (control, C1, or functional key):
      // fall through to the swallow check.
    }
    // Any other escape sequence: swallow — recognised command keys
    // (arrows, F-keys, legacy CSI, alt+x, …) and unknown sequences
    // alike. Inserting raw ESC bytes into the buffer would desync the
    // terminal (sanitizeText strips them at render, so the typed text
    // would vanish invisibly — worse than losing the keypress).
    return undefined;
  }
  // Multi-char plain text: an IME composition commit, or terminal text
  // delivered without bracketed-paste mode. Filter per code point
  // (insertables in, newlines/CR/tabs to spaces, controls dropped —
  // the same filter the bracketed-paste branch applies; a paste's
  // newlines would desync the one-line input, and the collapse keeps it
  // readable).
  return filterPlainText(data);
}
