/**
 * work-driver-plan-unfence-code — #1167: the code-block strip that guards the
 * unfence extraction.
 *
 * Split out of work-driver-plan-unfence-extract.ts for the AGENTS.md §12 line
 * cap. One export, one job: remove fenced and indented examples from an issue
 * body BEFORE any token is extracted from it.
 *
 * Why it exists: an issue's DECISIONS section quotes an example
 * (`import x from "src/legacy.ts"`) to show the shape the change must NOT
 * become. That file is not a requirement, and a pass that read it as one
 * would unfence a file the issue never asked anyone to touch.
 *
 * Why it is a LINE WALK and not one regex: the same three rules read (and
 * test) far better as line tests than as one alternation with a backreference,
 * and the indent rule cannot be expressed as a `\s` quantifier here. On the
 * engines in use `/^\s*~/` matches `"- ~~~"` — a list item — while the
 * equivalent `/^ {0,3}~/` does not. A strip that removes real prose is worse
 * than one that leaves an example in, so the indent is taken off as data
 * first (`dedent`) and every pattern is anchored with no leading quantifier.
 */

const FENCE_MARKER = /^(`{3,}|~{3,})/;
const HEADING_LINE = /^#{1,6}\s/;
const CLOSER_SUFFIX = /^[ \t]*$/;
/** Content after a 4+ space indent: non-space, or a comment. */
const INDENTED_CONTENT = /^\S/;
const LEADING_WS = /^[ \t]+/;

/** True when the line is whitespace then the fence marker, nothing before it. */
function isFenceMarginLine(line: string): boolean {
  return line === (dedent(line, 3) ?? line);
}

/** Leading whitespace (spaces/tabs only) up to `max`; undefined when deeper. */
function dedent(line: string, max: number): string | undefined {
  const m = LEADING_WS.exec(line);
  const indent = m ? m[0].length : 0;
  return indent > max ? undefined : line.slice(indent);
}

/** 4+ leading spaces/tabs then content, or an indented comment. */
function isIndentedCode(line: string): boolean {
  const m = LEADING_WS.exec(line);
  if (!m || m[0].length < 4) return false;
  const rest = line.slice(m[0].length);
  return INDENTED_CONTENT.test(rest) || rest.startsWith("#");
}

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** The index of the closing fence line for `marker`, or -1 when unterminated. */
function findFenceClose(lines: string[], from: number, marker: string): number {
  for (let j = from; j < lines.length; j++) {
    const candidate = dedent(lines[j] ?? "", 3);
    if (candidate?.startsWith(marker) && CLOSER_SUFFIX.test(candidate.slice(marker.length)))
      return j;
  }
  return -1;
}

/**
 * Fenced (``` / ~~~) and 4-space-indented code blocks, removed. Stripped lines
 * become empty lines so heading positions keep reading the same to the caller.
 *
 *   - a fence delimiter is a line whose only leading whitespace is spaces or
 *     tabs (at most 3 — Markdown's own fence indent limit) followed by ``` or
 *     ~~~.
 *   - the block runs to the first line that is the same marker again (same
 *     leading-whitespace rule), or, if that never comes, to the next ATX
 *     heading or the end of the body — an issue that forgets to close its
 *     fence must not leak the example into the extraction. An opener that is
 *     NOT a margin line (`- ``` `, `> ``` `) with no closer is prose: the
 *     fail-closed reading keeps it and every path it seems to name.
 *   - an indented block runs through consecutive lines indented 4+ spaces,
 *     blank lines and indented comments included (a commented-out call is
 *     example code too), and stops at the first line of real prose.
 */
export function stripCodeBlocks(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = dedent(line, 3);
    const fence = open === undefined ? null : FENCE_MARKER.exec(open);
    if (fence) {
      const marker = fence[1] ?? "";
      const close = findFenceClose(lines, i + 1, marker);
      if (close > 0) {
        out.push("");
        i = close;
        continue;
      }
      if (!isFenceMarginLine(line)) {
        out.push(line);
        continue;
      }
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = dedent(lines[j] ?? "", 3);
        if (candidate !== undefined && HEADING_LINE.test(candidate)) {
          end = j;
          break;
        }
      }
      out.push("");
      i = end - 1;
      continue;
    }
    if (isIndentedCode(line)) {
      // Markdown's own rule: the block runs to the LAST indented line,
      // swallowing the blank lines between — which is why a commented-out
      // call inside an example is stripped too.
      let j = i;
      let last = i;
      while (j < lines.length) {
        if (isIndentedCode(lines[j] ?? "")) last = j;
        else if (!isBlank(lines[j] ?? "")) break;
        j++;
      }
      out.push("");
      i = last;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
