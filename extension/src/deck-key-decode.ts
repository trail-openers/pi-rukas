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
 *     `\x1b[200~…\x1b[201~`; the end marker is swallowed as unknown);
 *   - any other multi-char plain text (an IME composition commit, or
 *     terminal text delivered without bracketed-paste mode) → insert with
 *     newlines collapsed to spaces;
 *   - everything else (unknown escape sequences — F-keys, mouse SGR,
 *     alt+x, arrow keys, the paste end marker, lone ESC, control bytes)
 *     → swallow. Garbage in the message buffer would desync the
 *     terminal line accounting (the #927 class).
 *
 * The decode result is validated: a non-empty string whose every code
 * point is ≥ 32. That admits é/CJK/emoji (code points 128+) and rejects
 * the control/empty shapes without a per-shape allow-list.
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

import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  parseKey,
} from "@earendil-works/pi-tui/dist/keys.js";

/**
 * The view's command keys (the NON-printing keys that drive the view,
 * checked with `matchesKey` in the component BEFORE this decoder runs).
 * The decoder is a pure function of `data`; listing the keys here keeps
 * the two sides reviewable side by side.
 */
export const VIEW_COMMAND_KEYS = [
  "escape",
  "ctrl+t",
  "enter",
  "backspace",
  "up",
  "down",
  "pageUp",
  "pageDown",
  "home",
  "end",
] as const;

/** True when `data` carries one of the view's command keys. */
export function isViewCommandKey(data: string): boolean {
  return VIEW_COMMAND_KEYS.some((k) => matchesKey(data, k));
}

/** The bracketed-paste markers pi-tui's ProcessTerminal wraps pastes in. */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

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
    // Single-char legacy input: insert printable ASCII only. Control
    // chars (0–31) and DEL (127) are swallowed. (A lone ESC and a lone
    // raw ctrl+t are handled upstream as command keys; they fall to the
    // swallow here if the component ever changes shape.)
    const code = data.charCodeAt(0);
    return code >= 32 && code <= 126 ? data : undefined;
  }
  if (data.startsWith("\u001b")) {
    // A multi-char escape sequence.
    if (data.includes(PASTE_START)) {
      // A bracketed paste (pi-tui wraps every paste in \x1b[200~ …
      // \x1b[201~; the end marker may ride in the same chunk or arrive
      // separately and is swallowed as an unknown sequence). Strip the
      // markers and insert the content with newlines collapsed — the
      // same shape the paste-free path below produces.
      return data.split(PASTE_START).join("").split(PASTE_END).join("").replace(/\n+/g, " ");
    }
    // First: a PRINTABLE encoding (Kitty CSI-u or modifyOtherKeys)?
    // decodeKittyPrintable returns a character for those (the strict
    // decoder — see the module header for the trade on malformed `;u`
    // shapes and why not decodePrintableKey).
    // pi-tui's strict decoder returns `String.fromCodePoint(n)` for ANY
    // numeric prefix — it does NOT check the code point against the
    // terminal's actual printable range. Functional keys (F1 = U+E015,
    // up = U+E017, alt+x = U+0085, …) "decode" to spurious code points
    // that are NOT user text. The guard: a string whose every code point
    // is in the printable range [32, 0x7F] ∪ [0xA0, 0xE000) — excluding
    // C1 controls (0x80–0x9F) and Kitty functional keys (U+E000+).
    const decoded = decodeKittyPrintable(data);
    if (typeof decoded === "string") {
      let printable = decoded.length > 0;
      for (const ch of decoded) {
        const cp = ch.codePointAt(0);
        if (cp === undefined || cp < 32 || (cp >= 0x80 && cp < 0xa0) || cp >= 0xe000) {
          printable = false;
          break;
        }
      }
      if (printable) return decoded;
      // Decoded to a non-printable (control, C1, or functional key):
      // fall through to the swallow check.
    }
    // Second: a recognised NON-printable (arrow, F-key, functional
    // CSI-u, legacy \x1b[5~, alt+x, …)? pi-tui's key vocabulary —
    // `matchesKey` for the view's own command keys and `parseKey` for
    // the rest — covers the sequences a terminal emits. If pi-tui
    // knows the key, it is a command, not text: swallow it (the
    // component handles the keys it cares about; unknown command keys
    // like F1 simply do nothing).
    if (isViewCommandKey(data) || parseKey(data) !== undefined) return undefined;
    // Unknown escape sequence: swallow. Inserting raw ESC bytes into the
    // buffer would desync the terminal (sanitizeText strips them at
    // render, so the typed text would vanish invisibly — worse than
    // losing the keypress).
    return undefined;
  }
  // Multi-char plain text: an IME composition commit, or terminal text
  // delivered without bracketed-paste mode. Insert, newlines collapsed
  // to spaces (a paste's newlines would desync the one-line input; the
  // collapse keeps it readable).
  return data.replace(/\n+/g, " ");
}
