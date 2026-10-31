/**
 * lean/text-fence — the renderers that keep untrusted text from becoming
 * structure in a PR body, an issue comment, or a specialist's prompt.
 *
 * Every field these print comes from OUTSIDE the run: a criterion's text is a
 * string the issue author typed, a verify reason is the tail of a build log, and
 * a review step's gate label is a reviewer's own wording while its frozen-path
 * list is read back from a durable state file. Printed raw, a `### heading`
 * inside any of them is a heading of the comment — or, in a fixer's brief, a
 * section of the prompt the step never wrote. A ``` inside a reason closes
 * whatever fence the poster opened — so the rest of the log becomes the
 * poster's markdown. AGENTS.md's public-text discipline is about not leaking;
 * this is about not being spoofed.
 *
 * Three shapes because the three fields need different guarantees: a reason is
 * multi-line prose that must stay readable, so it is fenced; a table cell or a
 * title must stay ONE line, so every control character goes, including the
 * newlines a fence would keep; and a value that goes inside backticks must stay
 * one line without the markdown escaping a cell needs.
 */

/** Control characters that still read as text inside a fence: newline and tab. */
const FENCE_KEEP = /[\n\t]/;
/**
 * Every control character, including \n, \r and \t, plus the three Unicode line
 * separators that are NOT `\p{Cc}`: U+2028 / U+2029 (line/paragraph separator)
 * and U+0085 (NEL). JS treats the first two as line terminators and some
 * markdown/rendering stacks do too, so a `oneLine` that leaves them in can still
 * end the row, and a fenced reason gains a line no fence was opened for.
 */
const ANY_CONTROL = /[\p{Cc}\u2028\u2029\u0085]/gu;
/** A run of 3+ backticks — the sequence that would close or open a fence. */
const BACKTICK_RUN = /`{3,}/g;
const HORIZONTAL_ELLIPSIS = "…";

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
 * The fence is ` ```text `, which renders as code and never as headings: a
 * `### INJ` inside it is a line of a block, not a section of the comment. Any
 * run of 3+ backticks in the payload is neutralised by swapping each backtick
 * for U+02CB (same count), so no sequence inside can close the fence early.
 */
export function fenceText(s: string, max: number): string {
  let body = soften(s);
  if (body.length > max) body = `${body.slice(0, max)}${HORIZONTAL_ELLIPSIS}`;
  body = body.replace(BACKTICK_RUN, (run) => "\u02cb".repeat(run.length));
  return `\`\`\`text\n${body}\n\`\`\``;
}

/**
 * Untrusted text as ONE line of markdown: a table cell, a title, a bullet.
 *
 * Every control character goes — including \n and \t, which would end the row
 * or the line — and `|` is escaped so a cell cannot open a column that the
 * table's header never declared.
 */
export function oneLine(s: string, max: number): string {
  let out = s.replace(ANY_CONTROL, " ").replace(/\|/g, "\\|");
  out = out.replace(/ {2,}/g, " ").trim();
  if (out.length > max) out = `${out.slice(0, max)}${HORIZONTAL_ELLIPSIS}`;
  return out;
}

/**
 * Untrusted text that has to sit in a prompt as a bare inline value: a path in a
 * bullet, a gate's name in a heading.
 *
 * `oneLine` is almost it, but not quite: it escapes `|`, which is right in a table
 * cell and wrong inside backticks where the backslash now reads as part of the
 * path. What a prompt actually needs refused is the *structure*: a `\n` that opens
 * a new heading, a `\r` that rewrites the line, the Unicode separators some
 * renderers treat as line breaks. So every control character goes — none is kept,
 * as `fenceText` keeps newline — and nothing else is rewritten, because a fenced
 * bullet cannot become a heading without one.
 *
 * This is not cosmetic for the fixer's brief. Its frozen-path list is read back
 * from the durable state file and its gate label comes out of a reviewer's reply;
 * either could otherwise open a section of the prompt the step never wrote.
 */
export function promptText(s: string, max: number): string {
  let out = s.replace(ANY_CONTROL, " ").replace(/ {2,}/g, " ").trim();
  if (out.length > max) out = `${out.slice(0, max)}${HORIZONTAL_ELLIPSIS}`;
  return out;
}
