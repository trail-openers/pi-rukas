/**
 * merge-lex-views — the three views of a command string the merge classifier
 * reads, and the patterns they are matched with.
 *
 * `merge-allowlist.ts` owns what a command *means*; this module owns the three
 * ways of looking at its text before anything means anything:
 *
 *   - `MERGE_WORD` / `VERB_PAIR` / `FORGE_WORD` / `HTTP_CLIENT` — the literal
 *     words a merge, a forge or an HTTP client is spelled with;
 *   - `BRACE_EXPANSION` — the `{a,b}` / `{a..b}` pattern bash would expand;
 *   - `ansiC` — the escapes of a `$'…'` body decoded the way bash decodes them;
 *   - `quotedView` — the command with quoted contents removed (or kept);
 *   - `hasComplexCommandWord` — whether any segment's command word is expanded,
 *     quoted or escaped, i.e. whether the tool bash would even exec is readable
 *     (`VAR=…` assignments before the word are skipped).
 *
 * They live together because they are only ever consulted as a set — the
 * trigger (merge-trigger.ts) tests all of them against the raw text and its
 * widened view, and the bound (merge-size.ts) asks the trigger the same
 * question. Splitting them from `merge-allowlist.ts` follows the seam #1417
 * already drew when the trigger moved out: the classifier keeps the decision,
 * the text views keep their patterns, and neither crosses into the other's
 * business (AGENTS.md §12 — the limit falls on the seam, not on a comment
 * budget).
 *
 * Linearity is load-bearing on every one of these: they run on every bash
 * tool_call. Each pattern is anchored, bounded or literal, and the bounded
 * ones are bounded *because* an unbounded version was measured quadratic
 * (#962 review). Every predicate here is a move out of `merge-allowlist.ts`,
 * not a rewrite: these decide which commands the guard reads.
 */

/**
 * A merge verb even when the forge CLI runs under another name (`./g pr merge
 * 17`): `pr merge` / `mr merge` / `mr accept` (glab's alias).
 */
export const VERB_PAIR = /(?:^|[^a-z0-9_])[pm]r\s+(?:merge|accept)(?![a-z0-9_])/i;

/** The words that name a merge: the bare noun, and each forge's API name for one. */
export const MERGE_WORD =
  /(?:^|[^a-z0-9_])merge(?![a-z0-9_])|mergepullrequest|enablepullrequestautomerge|mergerequestaccept|acceptmergerequest|mergerequestmerge|mergemergerequest|automerge|mergebranch|mergequeue|enqueuepullrequest/i;

/** A word that puts the command next to a forge: a forge CLI, an HTTP client, a script runner, a forge host. */
export const FORGE_WORD =
  /(?:^|[^a-z0-9_])(?:gh|glab|hub|curl|wget|https?|python3?|node|bun|deno|ruby|perl)(?![a-z0-9_])|api\.github\.com|gitlab|octokit/i;

/** An HTTP client, whether or not it is aimed at a forge. */
export const HTTP_CLIENT = /(?:^|[^a-z0-9_])(?:curl|wget|https?|httpie)(?![a-z0-9_])/i;

/**
 * A `{a,b}` / `{a..b}` pattern bash would expand (matched on the unquoted
 * view). The runs are bounded so the match stays LINEAR: unbounded, this
 * backtracks quadratically on `{` followed by a long `a,a,a,…` (#962 review).
 */
export const BRACE_EXPANSION = /\{[^{}\s,]{0,256}(?:,|\.\.)[^{}\s]{0,256}\}/;

/** ANSI-C escapes that spell one character. Anything else stays literal. */
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
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

/**
 * One escape of an ANSI-C body, as bash would tokenise it. `g`-flagged because
 * `ansiC` is the only consumer and replaces every match; a pattern shared with
 * a `.test()` caller would carry `lastIndex` between calls.
 */
export const ANSI_ESCAPE_PATTERN =
  /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g;

/**
 * Decode the escapes of an ANSI-C `$'…'` body. One bash would not decode
 * (out-of-range code point, `\x` with no digits, unknown letter) is kept
 * literal as `\` plus its text, never dropped — a word the shell would not
 * produce must not be rebuilt into a merge word the shell would.
 */
export function ansiC(body: string): string {
  return body.replace(ANSI_ESCAPE_PATTERN, (whole, e: string) => {
    if (e.length > 1 && /^[xuU]/.test(e)) {
      const code = Number.parseInt(e.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (/^[0-7]/.test(e)) return String.fromCodePoint(Number.parseInt(e, 8));
    return ANSI_ESCAPES[e] ?? whole;
  });
}

/**
 * The command with single-quoted contents removed (literal to bash), and
 * double-quoted contents too unless `keepDouble`. Quote marks stay, so a
 * removed word still leaves its `''` / `""` behind; escapes are skipped whole
 * so a `\"` cannot open or close a quote.
 */
export function quotedView(command: string, keepDouble: boolean): string {
  let out = "";
  let quote: "'" | '"' | undefined;
  const chars = [...command];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    if (ch === "\\" && quote !== "'") {
      const next = chars[i + 1] ?? "";
      i += 1;
      if (quote === undefined || keepDouble) out += ch + next;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
        out += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        out += ch;
      } else if (keepDouble) out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    out += ch;
  }
  return out;
}

/** Split on unquoted command separators; each piece is the raw text of one simple command. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (/[;&|\n`()]/.test(ch)) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Whether any segment's command word (after `VAR=…` assignments) is expanded,
 * quoted or escaped — `"$GH" pr merge`, `g"h" pr merge`, `$G api …/merge`.
 * Where that is true, the tool bash would exec is not readable from this text,
 * so there is nothing for the grammar to check.
 *
 * Byte-identical to the predicate this module was cut from: moving a trigger
 * predicate is a move, not a rewrite — a looser version here silently holds
 * merges, a tighter one silently lets an expanded command word through.
 */
export function hasComplexCommandWord(command: string): boolean {
  return segments(command).some((seg) => {
    const word = seg
      .trim()
      .split(/\s+/)
      .find((w) => !/^[A-Za-z_]\w*=/.test(w));
    return word !== undefined && /[$`'"\\]/.test(word);
  });
}
