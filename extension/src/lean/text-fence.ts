/**
 * lean/text-fence — the renderers that keep untrusted text from becoming structure in a PR body, an issue
 * comment, or a specialist's prompt.
 *
 * Every field these print comes from OUTSIDE the run: criterion text is what the issue author typed, a verify
 * reason is the tail of a build log, a gate label is a reviewer's wording. Printed raw, a `### heading` inside
 * any of them is a heading of the comment — or, in a fixer's brief, a prompt section the step never wrote, and
 * a ``` inside a reason closes the fence the poster opened. Public-text discipline is about not leaking; this
 * is about not being spoofed.
 *
 * Three shapes because the fields need different guarantees: a reason is multi-line prose that stays readable
 * (fenced); a cell or title stays ONE line (every control character goes); a value inside backticks stays one
 * line without the escaping a cell needs.
 *
 * `joinNotes` runs the other way: it composes a reason from the clauses that existed, leaving no bare `; `.
 */

/** Control characters that still read as text inside a fence: newline and tab. */
const FENCE_KEEP = /[\n\t]/;
/**
 * Every control character, including \n, \r and \t, plus the three Unicode line separators that are NOT
 * `\p{Cc}`: U+2028 / U+2029 and U+0085 (NEL). JS treats the first two as line terminators, so a `oneLine` that
 * leaves them in can still end the row.
 */
const ANY_CONTROL = /[\p{Cc}\u2028\u2029\u0085]/gu;
/**
 * A run of 3+ backticks — the sequence that would close or open a fence. Backticks only, because CommonMark
 * requires a closing fence to use the opener's character; the one place the fence's character is decided.
 */
const BACKTICK_RUN = /`{3,}/g;
const HORIZONTAL_ELLIPSIS = "…";
/**
 * The line a clipped fence says instead of stopping dead.
 *
 * A fence is the one shape here that keeps newlines, so the reader takes it for a document — and one that
 * simply ends is indistinguishable from a complete one. The cut is stated inside the fence with the number
 * that caused it: silent truncation is a lie by omission to the only reader who cannot check.
 */
const TRUNCATION_MARKER = (max: number): string => `[truncated at ${String(max)} characters]`;

/** Replace control characters that are not \n or \t with a space. */
function soften(s: string): string {
  let out = "";
  for (const ch of s)
    out +=
      ch.charCodeAt(0) < 0x20 ||
      ch.charCodeAt(0) === 0x7f ||
      ch === "\u2028" ||
      ch === "\u2029" ||
      ch === "\u0085"
        ? FENCE_KEEP.test(ch)
          ? ch
          : " "
        : ch;
  return out;
}

/**
 * Untrusted multi-line text, fenced so it stays text.
 *
 * The fence is ` ```text `, rendering as code and never as headings. Any run of 3+ backticks in the payload is
 * neutralised by swapping each backtick for U+02CB (same count), so nothing inside closes it early.
 *
 * The truncation marker is emitted INSIDE the fence and AFTER neutralisation — never payload text that looks
 * like the marker, never itself mangled. A payload at or under `max` gains nothing; the marker's absence is
 * what makes its presence meaningful.
 *
 * `notice` is that line's text for callers that must say WHICH payload was cut. A regex substitution hits the
 * *first* match and a payload can quote the other's marker, so substituted text never becomes a notice.
 */
export function fenceText(s: string, max: number, notice?: string): string {
  let body = soften(s);
  const clipped = body.length > max;
  if (clipped) body = `${body.slice(0, max)}${HORIZONTAL_ELLIPSIS}`;
  body = body.replace(BACKTICK_RUN, (run) => "\u02cb".repeat(run.length));
  return `\`\`\`text\n${body}${clipped ? `\n${notice ?? TRUNCATION_MARKER(max)}` : ""}\n\`\`\``;
}

/**
 * Untrusted text as ONE line of markdown: a cell, a title, a bullet. Every control character goes — including
 * \n and \t, which would end the row — and `|` is escaped so a cell opens no column the header never declared.
 */
export function oneLine(s: string, max: number): string {
  let out = s.replace(ANY_CONTROL, " ").replace(/\|/g, "\\|");
  out = out.replace(/ {2,}/g, " ").trim();
  if (out.length > max) out = `${out.slice(0, max)}${HORIZONTAL_ELLIPSIS}`;
  return out;
}

/**
 * Untrusted text sitting in a prompt as a bare inline value: a path in a bullet, a gate's name.
 *
 * `oneLine` escapes `|` — right in a cell, wrong inside backticks where the backslash reads as part of the
 * path. A prompt needs only the *structure* refused, so nothing else is rewritten.
 */
export function promptText(s: string, max: number): string {
  let out = s.replace(ANY_CONTROL, " ").replace(/ {2,}/g, " ").trim();
  if (out.length > max) out = `${out.slice(0, max)}${HORIZONTAL_ELLIPSIS}`;
  return out;
}

/** A list inside a reason line: the first `cap` items, then how many more. */
export function clipList(items: readonly string[], cap: number): string {
  return items.length > cap
    ? `${items.slice(0, cap).join(", ")} (+${String(items.length - cap)} more)`
    : items.join(", ");
}

/**
 * The `; `-joined non-empty parts of one reason line: an empty clause leaves no bare separator behind.
 */
export function joinNotes(parts: string[]): string {
  return parts.filter((p) => p !== "").join("; ");
}
