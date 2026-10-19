/**
 * write-fence-bash-heredoc — heredocs for the bash lexer (#1655).
 *
 * A heredoc body is data, not commands, so the lexer skips it. This module finds
 * the delimiter word after `<<` / `<<-`, and the end of each body that follows
 * the line its operator sits on. Both return positions in the command text, or
 * -1 when a quote in the delimiter is not closed.
 *
 * An unquoted delimiter does not make the body data to the shell: `$(…)` and
 * backticks in it run as commands. Those are returned for the caller to judge.
 */

import { skipBacktick, skipSubst } from "./write-fence-bash-words.ts";

/** A heredoc whose body starts on the line after the operator. */
export interface Heredoc {
  delim: string;
  strip: boolean;
  /** Any quoting in the delimiter turns off expansion in the body. */
  quoted: boolean;
}

/**
 * The delimiter word of a heredoc (`<<EOF`, `<<-'EOF'`) starting at `src[i]`, which is
 * the first `<`. Returns the delimiter, its strip and quoted flags and the position after
 * it, or -1 when a quote inside it is not closed.
 */
export function heredocDelimiter(
  src: string,
  i: number,
): { delim: string; strip: boolean; quoted: boolean; end: number } | -1 {
  let j = i + 2;
  const strip = src[j] === "-";
  if (strip) j++;
  while (src[j] === " " || src[j] === "\t") j++;
  let delim = "";
  let quoted = false;
  while (j < src.length && !/[\s;&|()<>]/.test(src[j] ?? "")) {
    const c = src[j] ?? "";
    if (c === '"' || c === "'") {
      const close = src.indexOf(c, j + 1);
      if (close < 0) return -1;
      delim += src.slice(j + 1, close);
      quoted = true;
      j = close + 1;
      continue;
    }
    if (c === "\\") quoted = true;
    else delim += c;
    j++;
  }
  return { delim, strip, quoted, end: j };
}

/**
 * The heredoc bodies that follow a newline. Each is skipped as data; an unquoted body's
 * text is pushed to `unquoted` for its substitutions to be judged. Returns the position
 * after the last one read.
 */
export function skipHeredocBodies(
  src: string,
  from: number,
  heredocs: Heredoc[],
  unquoted: string[],
): number {
  let i = from;
  for (const doc of heredocs.splice(0)) {
    let body = "";
    while (i < src.length) {
      const eol = src.indexOf("\n", i);
      const line = src.slice(i, eol < 0 ? src.length : eol);
      i = eol < 0 ? src.length : eol + 1;
      if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
      body += `${line}\n`;
    }
    if (!doc.quoted) unquoted.push(body);
  }
  return i;
}

/**
 * The command substitutions in an unquoted heredoc body: each `$(…)` and backtick
 * body, which the shell runs. A backslash escapes the next character. Undefined when
 * one never closes.
 */
export function heredocSubstitutions(body: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "`") {
      const end = skipBacktick(body, i);
      if (end < 0) return undefined;
      out.push(body.slice(i + 1, end - 1));
      i = end;
    } else if (c === "$" && body[i + 1] === "(") {
      const end = skipSubst(body, i);
      if (end < 0) return undefined;
      out.push(body.slice(i + 2, end - 1));
      i = end;
    } else {
      i++;
    }
  }
  return out;
}
