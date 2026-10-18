/**
 * write-fence-bash-heredoc — heredocs for the bash lexer (#1655).
 *
 * A heredoc body is data, not commands, so the lexer skips it. This module finds
 * the delimiter word after `<<` / `<<-`, and the end of each body that follows
 * the line its operator sits on. Both return positions in the command text, or
 * -1 when a quote in the delimiter is not closed.
 */

/** A heredoc whose body starts on the line after the operator. */
export interface Heredoc {
  delim: string;
  strip: boolean;
}

/**
 * The delimiter word of a heredoc (`<<EOF`, `<<-'EOF'`) starting at `src[i]`, which is
 * the first `<`. Returns the delimiter, its strip flag and the position after it, or
 * -1 when a quote inside it is not closed.
 */
export function heredocDelimiter(
  src: string,
  i: number,
): { delim: string; strip: boolean; end: number } | -1 {
  let j = i + 2;
  const strip = src[j] === "-";
  if (strip) j++;
  while (src[j] === " " || src[j] === "\t") j++;
  let delim = "";
  while (j < src.length && !/[\s;&|()<>]/.test(src[j] ?? "")) {
    const c = src[j] ?? "";
    if (c === '"' || c === "'") {
      const close = src.indexOf(c, j + 1);
      if (close < 0) return -1;
      delim += src.slice(j + 1, close);
      j = close + 1;
      continue;
    }
    if (c !== "\\") delim += c;
    j++;
  }
  return { delim, strip, end: j };
}

/** The heredoc bodies that follow a newline, as data to skip. Returns the position after the last one read. */
export function skipHeredocBodies(src: string, from: number, heredocs: Heredoc[]): number {
  let i = from;
  for (const doc of heredocs.splice(0)) {
    while (i < src.length) {
      const eol = src.indexOf("\n", i);
      const line = src.slice(i, eol < 0 ? src.length : eol);
      i = eol < 0 ? src.length : eol + 1;
      if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
    }
  }
  return i;
}
