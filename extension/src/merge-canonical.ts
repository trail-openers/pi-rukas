/**
 * merge-canonical — the merge guard's second view of a command: the words
 * bash actually executes, after quote removal (#962).
 *
 * The matcher's token walk (`rawTokens`, merge-tokens.ts) keeps every quoted
 * run as its own token and leaves backslashes in place, so a command whose
 * words are spelled with escapes or adjacent quoted runs reads as something
 * else: `\gh pr merge 17`, `g"h" pr merge 17`, `gh pr merge 1"7"` (PR 17,
 * read as PR 1), `bash -c gh\ pr\ merge\ 17`, `eval $"gh pr merge 17"`. bash
 * removes those quotes and escapes before it runs anything.
 *
 * `canonicalCommand` rebuilds the command from its shell WORDS: adjacent
 * quoted/unquoted runs are joined into one word and escapes are resolved.
 * A word written with no quoting at all is emitted byte-for-byte (so
 * substitutions and parens keep their structure); a word that needed quote
 * removal is emitted bare when its value is plain, and single-quoted
 * otherwise (so a quoted string stays one inert word). The guard analyses
 * BOTH texts and fails closed when they disagree (merge-analyse.ts).
 */

/** Characters a canonical word may carry without being re-quoted. */
const PLAIN_WORD = /^[A-Za-z0-9_./:=@%+,#-]+$/;

/**
 * The command rebuilt from its shell words, or `undefined` when a quote
 * never closes (the primary walk already fails closed on that shape).
 */
export function canonicalCommand(command: string): string | undefined {
  const out: string[] = [];
  const n = command.length;
  let i = 0;
  let word = "";
  let start = -1;
  let rewritten = false;
  const flush = (end: number) => {
    if (start === -1) return;
    if (!rewritten) out.push(command.slice(start, end));
    else if (PLAIN_WORD.test(word)) out.push(word);
    else out.push(`'${word.replaceAll("'", `'\\''`)}'`);
    word = "";
    start = -1;
    rewritten = false;
  };
  while (i < n) {
    const c = command[i] ?? "";
    if (c === "\\" && command[i + 1] === "\n") {
      i += 2; // line continuation
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && !isRedirectAmp(command, i))) {
      flush(i);
      const pair = (c === "&" || c === "|") && command[i + 1] === c;
      out.push(c === "\n" ? ";" : pair ? c + c : c);
      i += pair ? 2 : 1;
      continue;
    }
    if (/\s/.test(c)) {
      flush(i);
      i++;
      continue;
    }
    if (start === -1) start = i;
    if (c === "\\") {
      word += command[i + 1] ?? "";
      rewritten = true;
      i += 2;
      continue;
    }
    if (c === "'" || (c === "$" && command[i + 1] === "'")) {
      const ansi = c === "$";
      let close = i + (ansi ? 2 : 1);
      while (close < n && command[close] !== "'") close += ansi && command[close] === "\\" ? 2 : 1;
      if (close >= n) return undefined;
      const body = command.slice(i + (ansi ? 2 : 1), close);
      word += ansi ? ansiC(body) : body;
      rewritten = true;
      i = close + 1;
      continue;
    }
    if (c === '"' || (c === "$" && command[i + 1] === '"')) {
      let j = i + (c === "$" ? 2 : 1);
      let closed = false;
      while (j < n) {
        const d = command[j] ?? "";
        if (d === "\\" && j + 1 < n) {
          const e = command[j + 1] ?? "";
          word += '$`"\\\n'.includes(e) ? (e === "\n" ? "" : e) : d + e;
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        word += d;
        j++;
      }
      if (!closed) return undefined;
      rewritten = true;
      i = j + 1;
      continue;
    }
    word += c;
    i++;
  }
  flush(n);
  return out.join(" ");
}

/** `>&`, `<&` and `&>` are redirections, not the `&` separator. */
function isRedirectAmp(s: string, i: number): boolean {
  const prev = s[i - 1];
  return prev === ">" || prev === "<" || s[i + 1] === ">";
}

/** The common ANSI-C escapes of a `$'…'` body (the rest stay verbatim). */
function ansiC(body: string): string {
  return body.replace(/\\(.)/g, (_m, e: string) =>
    e === "n" ? "\n" : e === "t" ? "\t" : e === "\\" || e === "'" || e === '"' ? e : `\\${e}`,
  );
}
