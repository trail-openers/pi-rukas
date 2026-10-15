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
    if (!rewritten) out.push(...braceExpand(command.slice(start, end)));
    else if (PLAIN_WORD.test(word)) out.push(word);
    else out.push(`'${word.replaceAll("'", `'\\''`)}'`);
    word = "";
    start = -1;
    rewritten = false;
  };
  while (i < n) {
    const c = command[i] ?? "";
    if (c === "\\" && command[i + 1] === "\n") {
      i += 2; // line continuation — mid-word it joins the two halves
      if (start !== -1) rewritten = true;
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

/** A `$'…'` body with bash's ANSI-C escapes decoded (\xHH, \NNN, \uHHHH, \UHHHHHHHH, \cX, …). */
function ansiC(body: string): string {
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    e: "\x1b",
    E: "\x1b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  };
  return body.replace(
    /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/gs,
    (m, e: string) => {
      const code =
        e[0] === "x" || e[0] === "u" || e[0] === "U"
          ? Number.parseInt(e.slice(1), 16)
          : /^[0-7]/.test(e)
            ? Number.parseInt(e, 8)
            : e[0] === "c" && e.length === 2
              ? e.charCodeAt(1) & 0x1f
              : undefined;
      if (code !== undefined) return code <= 0x10ffff ? String.fromCodePoint(code) : m;
      return simple[e] ?? m;
    },
  );
}

/**
 * Brace expansion of an unquoted word (`{gh,pr,merge,17}`, `me{r,}ge`):
 * the innermost `{…,…}` group is expanded repeatedly, bounded so a hostile
 * word cannot blow up — past the bound every alternative becomes its own
 * word (a superset). Sequences (`{1..3}`) and words with no comma group are
 * left as written.
 */
function braceExpand(word: string): string[] {
  let words = [word];
  for (let round = 0; round < 8; round++) {
    let changed = false;
    const next: string[] = [];
    for (const w of words) {
      const m = /\{([^{}]*,[^{}]*)\}/.exec(w);
      if (!m) {
        next.push(w);
        continue;
      }
      changed = true;
      for (const alt of (m[1] ?? "").split(","))
        next.push(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length));
    }
    // Past the bound, fail closed with every alternative as its own word
    // (a superset of the words bash runs) rather than the unexpanded word.
    if (next.length > 256) return word.split(/[{},]+/).filter((w) => w !== "");
    words = next;
    if (!changed) return words.filter((w) => w !== "");
  }
  return words.flatMap((w) => w.split(/[{},]+/)).filter((w) => w !== "");
}
