/**
 * lean/text-fence — the two renderers that keep untrusted text from becoming
 * structure in a PR body or an issue comment.
 *
 * Both fields a lean step prints come from OUTSIDE the run: a criterion's text
 * is a string the issue author typed, and a verify reason is the tail of a
 * build log. Printed raw, a `### heading` inside either is a heading of the
 * comment, and a ``` inside a reason closes whatever fence the poster opened —
 * so the rest of the log becomes the poster's markdown. AGENTS.md's public-text
 * discipline is about not leaking; this is about not being spoofed.
 *
 * Two shapes because the two fields need different guarantees: a reason is
 * multi-line prose that must stay readable, so it is fenced; a table cell or a
 * title must stay ONE line, so every control character goes, including the
 * newlines a fence would keep.
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
