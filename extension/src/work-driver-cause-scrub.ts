/**
 * work-driver-cause-scrub — #1675: the one text scrub every cause surface runs
 * before it prints or stores an explanation. The cause verdict is scrubbed
 * once, at its producer (causeForCycle in work-driver-cause-for.ts), so the
 * headless JSON, the markdown body, the in-chat message and the queue line
 * carry identical text. The renderers still call causeSafeText, which is
 * idempotent: it is the fallback for a state file written before the producer
 * scrubbed.
 *
 * What it removes:
 *   - the "dependencies are still missing" hint, unless a dependency signature
 *     is on an extracted failing line (depsHintApplies, #1673). The hint's
 *     opening phrases come from work-driver-deps-hint.ts, the module that
 *     writes them, so the two cannot drift;
 *   - the N=1 "cannot be attributed to a per-workstream defect" wording, which
 *     is replaced with the verify command's own failing line (#1675 criterion 5);
 *   - ANSI control sequences, C0/DEL control characters and invisible bidi or
 *     zero-width characters, which a tool's output can carry into a comment or
 *     a log line.
 *
 * `escapeMarkdownText` escapes untrusted text where it lands in a heading,
 * where a code span is not available.
 */

import { DEPS_HINT_STARTS } from "./work-driver-deps-hint.ts";
import { depsHintApplies } from "./work-driver-verify-record.ts";

/** Removes a dependency hint that the extracted failing lines do not support. */
export function scrubDepsHint(text: string): string {
  if (!DEPS_HINT_STARTS.some((s) => text.includes(s))) return text;
  if (depsHintApplies(text)) return text;
  let out = text;
  for (const start of DEPS_HINT_STARTS) {
    for (let i = out.indexOf(start); i >= 0; i = out.indexOf(start)) {
      // A hint runs to the end of its line. Its own text can carry `: ` (a
      // worktree problem string does), so the first `: ` is not its end and
      // cutting there would leave a fragment of the problem behind.
      const newline = out.indexOf("\n", i);
      out = out.slice(0, i) + (newline < 0 ? "" : out.slice(newline));
    }
  }
  return out;
}

/** The N=1 sentence the pre-#1675 classifier wrote, and what it now says. */
const STALE_N1 =
  "single-workstream cycle: the consolidated failure cannot be attributed to a per-workstream defect — park as needs-human with the specific assertion";
const N1_REPLACEMENT = "the verify command failed (the specific assertion is named above)";

/** A CSI final byte: the character that ends an ESC [ sequence. */
function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/** Bidi overrides and isolates, zero-width characters, and the BOM: invisible text that can reorder or hide a line. */
function isInvisible(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff
  );
}

/**
 * Strips ANSI CSI sequences, control characters and invisible bidi/zero-width characters. Tabs and newlines become a
 * space so a multi-line value stays one line. Written as a char-code scan, not
 * a regex, so no control character appears in a pattern.
 */
export function stripControls(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x1b && text.charCodeAt(i + 1) === 0x5b) {
      let j = i + 2;
      while (j < text.length && !isCsiFinal(text.charCodeAt(j))) j++;
      i = j;
      continue;
    }
    if (code === 0x09 || code === 0x0a) {
      out += " ";
      continue;
    }
    if (code < 0x20 || code === 0x7f || isInvisible(code)) continue;
    out += text[i];
  }
  return out;
}

/** Every explanation and evidence line passes through here before it is printed. */
export function causeSafeText(text: string): string {
  return scrubDepsHint(stripControls(text)).split(STALE_N1).join(N1_REPLACEMENT);
}

/** Backslash-escapes the markdown punctuation untrusted text could use to build links, images or markup. */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`[\]()!@#<>|*_]/g, "\\$&");
}
