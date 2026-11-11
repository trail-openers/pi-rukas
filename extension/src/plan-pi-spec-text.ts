/**
 * The text primitives the `pi-spec v1` mapper runs over its inputs: the clip, the
 * one-line collapse, and the slice of one `## <heading>` section of a drafted body.
 * Kept out of `plan-pi-spec.ts` so the mapper stays under the size cap with its
 * placement and omission logic, the same seam as `plan-pi-spec-fences.ts`.
 */
import { AC_FALLBACK } from "./plan-validate.ts";

/**
 * Clip to `max` UTF-16 code UNITS, never splitting a surrogate pair.
 *
 * The ceiling every caller enforces is measured in `.length` — the same units
 * `parsePiSpec`, the forge cap and the budget reservation are counted in — so a
 * code-point clip would let astral text (emoji, CJK extension B) over-run the very
 * bound it is supposed to keep. A trailing high surrogate is dropped rather than
 * left dangling.
 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(max - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, max - 1);
  return out;
}

/**
 * One printable line: control characters become spaces, a lone surrogate becomes
 * U+FFFD, and whitespace runs collapse. Iterated by code point, so a valid surrogate
 * pair (an emoji) arrives whole; only an unpaired surrogate is in the surrogate range.
 */
export function oneLine(s: string): string {
  const printable = Array.from(s, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) return "�";
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return " ";
    return ch;
  });
  return printable.join("").replace(/\s+/g, " ").trim();
}

/**
 * `## <heading>` ... content up to the next `## ` (or end of body). Exported for
 * the one reader that needs the section's RAW text rather than its bullets —
 * `plan-pi-spec.ts` reads the `Descriptor:` line out of `## Context & motivation`.
 *
 * The pattern is assembled from plain (non-template) string literals, and that
 * is load-bearing: inside a template literal `\s` and `\S` lose their backslashes,
 * so `[\s\S]` silently becomes the class `[sS]` - which matches neither a space nor
 * a newline - and a `\n` written for a regex class becomes the two characters
 * backslash and n. Either way the lazy capture stops at the section's first
 * line, the mapper finds zero criteria, and the issue files with NO spec block
 * and no error anywhere. A regex source that must contain a backslash is built
 * from String.raw / plain literals, never from a template.
 */
const NOT_NL = String.raw`[^\n]`;
const ANY = String.raw`[\s\S]`;
const SLICE_HEAD = String.raw`^## `;
const SLICE_TAIL = String.raw`*\n`;
export const SECTION_SLICE = (heading: string): RegExp =>
  new RegExp(`${SLICE_HEAD}${heading}${NOT_NL}${SLICE_TAIL}(${ANY}*?)(?=^## |$(?!${ANY}))`, "gm");

/** The bullets of one `## <heading>` section, in order, status-only bullets dropped. */
export function sectionBullets(body: string, heading: string): string[] {
  const m = SECTION_SLICE(heading).exec(body);
  if (!m?.[1]) return [];
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(
      (l) => l !== "" && !l.startsWith("_") && !l.startsWith(AC_FALLBACK) && !l.startsWith("..."),
    );
}

// Why `sectionBullets` above drops the `AC_FALLBACK` bullet instead of filing it
// as a criterion: it is the ONE string `plan-draft.ts` renders when no criterion
// exists and the one `validateDraft` refuses a plan over, so `plan-validate.ts`
// is the only spelling that cannot drift. This used to be an
// `AC_FALLBACK_BULLET = AC_FALLBACK` alias — a third name for one string nobody
// keeps in step, and the day it drifts the mapper files the placeholder as AC1.
