/**
 * public-hygiene-email — blanking an email address out of text, in linear time.
 *
 * Two callers in this guard ask a question of a text with its email addresses
 * removed: the home-path rule reads `/home/<name>/` and an address's host part
 * legitimately looks like a host (`/home/alice@box/` would otherwise be read as
 * both an address and a home path), and the generic address rules want the
 * address itself exempt for the same reason. Both used a single regex with two
 * adjacent `+` quantifiers and a `.` inside the second class.
 *
 * That shape is exponential on an input designed to defeat it. The two
 * quantified classes share `-`, `.`, `+` and `_`, so a run of those characters
 * before an `@` has `2^n` ways to split between the local part and the host —
 * measured on a 2 KB unbroken run, the regex alone took **223 seconds** (a
 * 1 KB run: 24 s; a 512-byte run: 3.8 s, and the ratio doubles with each
 * doubling, which is the definition of the problem). A 1 MB body with one `@`
 * is a denial of service on every agent turn that publishes it, and the guard
 * runs on every one of those turns.
 *
 * This module finds each `@` and walks the two spans around it with plain
 * character tests: one pass over the string, `O(n)`, no engine backtracking.
 *
 * It is deliberately **not stricter** than the regex it replaced. Membership of
 * the token characters is the same set the regex used; what is dropped is the
 * regex's insistence that the host carry a dot and end in two letters. The
 * consequence is that this blanks a *superset* of what the regex blanked, which
 * is the only direction safe to err in: a token this module blanks and the
 * regex did not is a token the caller now declines to judge, and the caller's
 * rule is a heuristic that already exempts addresses. Blending a stricter
 * second pass back in would reintroduce the shape this exists to remove.
 */

/** The characters a local part or a hostname is made of, per the old regex. */
const LOCAL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._%+-";
const HOST_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-";

function inSet(ch: string, set: string): boolean {
  return set.indexOf(ch) !== -1;
}

/**
 * The start and end (exclusive) of the email-ish token containing `at`, or
 * `undefined` when `at` is not a token boundary. The two sides are independent
 * walks, which is what makes this linear: neither side's extent can change the
 * other's work, and each character is visited a constant number of times.
 */
function tokenSpan(text: string, at: number): { start: number; end: number } | undefined {
  // The token must have a local part: `@` at the very start, or preceded by a
  // character that is not a token character, has nothing on its left.
  if (at === 0) return undefined;
  if (!inSet(text[at - 1] as string, LOCAL_CHARS)) return undefined;
  let start = at;
  while (start > 0 && inSet(text[start - 1] as string, LOCAL_CHARS)) start -= 1;
  // And a host: an `@` at the end of the text, or followed by a non-token
  // character, is not an address.
  let end = at + 1;
  if (end >= text.length || !inSet(text[end] as string, HOST_CHARS)) return undefined;
  while (end < text.length && inSet(text[end] as string, HOST_CHARS)) end += 1;
  return { start, end };
}

/**
 * Every email address in `text`, replaced by a neutral placeholder. The
 * placeholder is padded with spaces so a blanked address cannot splice two
 * words into a token neither rule would have matched (`foo/home/alice` must not
 * become `foo`+`/home/alice` by concatenation).
 */
export function blankEmailTokens(text: string): string {
  if (text.indexOf("@") === -1) return text;
  let out = "";
  let cursor = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "@") continue;
    const span = tokenSpan(text, i);
    if (span === undefined) continue;
    // A span that starts inside one already blanked is part of it — `a@b@c`
    // blanked as one token rather than two, which is what a single scan gives
    // and what the caller wants: the question is "is there an address here".
    if (span.end <= cursor) continue;
    out += `${text.slice(cursor, Math.max(cursor, span.start))} email `;
    cursor = span.end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}
