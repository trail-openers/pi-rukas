/**
 * merge-like — the merge guard's backstop predicate (#1317): does this raw
 * command TEXT look like it could merge a PR/MR, whatever the parser made of
 * it?
 *
 * The guard's readers (merge-parse.ts, bash-merges-pr.ts, merge-canonical.ts)
 * each recognise a set of shapes. A shape none of them can read falls through
 * to "not a merge" — the bypass class #1317 closes. This predicate is the
 * systematic floor under all of them: a command that is merge-like but yields
 * no readable merge head, or whose readings failed, is refused as
 * "unrecognised" (or "unparsed") instead of allowed.
 *
 * Merge-like means (case-insensitive, quotes/escapes/braces stripped so a
 * spelled-out word still matches):
 *   - the word `merge` together with a `gh` / `glab` word (`git merge` is
 *     exempt — it is not a forge command);
 *   - a REST path ending in `/merge` (`pulls/17/merge`, `merge_requests/7/merge`);
 *   - an ANSI-C `$'…'` or a brace group `{a,b}` (they can spell `merge`) next
 *     to a forge word.
 *
 * Deliberate over-refusal: a quoted prose argument that spells `merge` next to
 * gh/glab (`gh pr comment 5 --body "please merge"`) is refused. Put such text
 * in `--body-file` (docs/troubleshooting.md → "A merge was refused: the guard
 * cannot read this command").
 *
 * The exemption rule (#1317 review): a segment is exempt ONLY when it is an
 * `echo` / `printf` / `git commit -m` that runs nothing it prints, with no
 * substitution, redirection, here-doc, pipe-out or interpreter word anywhere
 * in the command that could make it execute. A forge REST call the door itself
 * reads as a read is also exempt (isRestRead — the door is the one source of
 * that verdict). Nothing else is exempt.
 */

import { isRestRead } from "./bash-merges-pr.ts";
import { isRedirectAmpAt, isSeparatorToken, rawTokens, unquoteArg } from "./merge-tokens.ts";

const FORGE_WORD = /(?<![A-Za-z0-9_])(?:gh|glab)(?![A-Za-z0-9_])/i;
const MERGE_WORD = /(?<![A-Za-z0-9_])merge(?![A-Za-z0-9_.-])/i;
const GIT_MERGE = /(?<![A-Za-z0-9_])git\s+merge(?![A-Za-z0-9_.-])/gi;
const REST_MERGE = /\/merge(?![A-Za-z0-9_.-])/i;
const SPELLED_FORM = /\{[^{}]*,[^{}]*\}|\$'/;

/** `text` with the outer quoting, escapes and brace/paren noise removed in two ways. */
function variants(text: string): string[] {
  const noLine = text.replace(/\\\n/g, "");
  // Separator-like noise becomes a space (`{gh,pr,merge,17}` → words).
  const loose = noLine.replace(/[(){}$`,]/g, " ").replace(/["'\\]/g, "");
  // Quote-like noise is deleted (`g"h" pr m"erge"` → `gh pr merge`).
  const tight = noLine.replace(/[(){}$`,"'\\]/g, "");
  return [loose, tight].map((s) => s.replace(GIT_MERGE, "git"));
}

/** True when `text` could merge a PR/MR (see the module doc). */
export function mergeLike(text: string): boolean {
  const forms = variants(text);
  if (forms.some((s) => (FORGE_WORD.test(s) && MERGE_WORD.test(s)) || REST_MERGE.test(s))) {
    return true;
  }
  return SPELLED_FORM.test(text) && forms.some((s) => FORGE_WORD.test(s));
}

/** Command words that run another command's text. No exempt segment may contain one. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "source",
  ".",
  "eval",
  "xargs",
  "exec",
  "env",
  "command",
  "builtin",
  "nohup",
  "timeout",
  "nice",
  "time",
  "sudo",
  "busybox",
  "watch",
  "parallel",
]);

/** A substitution, backtick or process substitution: its body runs, and a split cannot see inside it. */
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

/**
 * `text` with the parts the shell does NOT expand blanked out: single-quoted
 * runs, `$'…'` strings and backslash escapes. What remains is the text whose
 * substitutions and redirections really run (`echo '$(x)'` and `echo "\$(x)"`
 * run nothing). An unterminated single quote leaves the text whole.
 */
function expandable(text: string): string {
  let out = "";
  let i = 0;
  let inDouble = false;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c === "\\") {
      out += "_";
      i += 2;
      continue;
    }
    if (!inDouble && (c === "'" || (c === "$" && text[i + 1] === "'"))) {
      const ansi = c === "$";
      let j = i + (ansi ? 2 : 1);
      while (j < text.length && text[j] !== "'") j += ansi && text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return text;
      out += "_".repeat(j + 1 - i);
      i = j + 1;
      continue;
    }
    if (c === '"') inDouble = !inDouble;
    out += c;
    i++;
  }
  return out;
}

/** A segment and the separator that follows it (`""` at the end of the command). */
interface Piece {
  text: string;
  next: string;
}

/** The separator operator starting at `i`, with its length, or undefined. */
function separatorAt(s: string, i: number): { op: string; len: number } | undefined {
  const c = s[i] ?? "";
  const d = s[i + 1] ?? "";
  if (c === "\n" || c === ";") return { op: ";", len: 1 };
  if ((c === "&" && d === "&") || (c === "|" && d === "|")) return { op: c + c, len: 2 };
  if (c === "|" && d === "&") return { op: "|&", len: 2 };
  if (c === "|") return { op: "|", len: 1 };
  if (c === "&" && !isRedirectAmpAt(s, i)) return { op: "&", len: 1 };
  return undefined;
}

/** The command split into segments, each with the separator that follows it (quote-aware). */
function pieces(command: string): Piece[] {
  const out: Piece[] = [];
  let cur = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i] ?? "";
    if (ch === "'" || ch === '"') {
      const start = i;
      i++;
      while (i < n && command[i] !== ch) i += ch === '"' && command[i] === "\\" ? 2 : 1;
      i++;
      cur += command.slice(start, i);
      continue;
    }
    if (ch === "\\") {
      cur += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    const sep = separatorAt(command, i);
    if (sep !== undefined) {
      out.push({ text: cur, next: sep.op });
      cur = "";
      i += sep.len;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push({ text: cur, next: "" });
  return out;
}

/**
 * The command with its provably inert segments removed (see the module doc).
 * Unreadable quoting returns the whole command — nothing is exempted when the
 * segments cannot be trusted.
 */
export function executableText(command: string): string {
  if (rawTokens(command).terminated === false) return command;
  // A substitution's body runs whatever the split says, so nothing is exempt
  // in a command that contains one.
  const substitution = SUBSTITUTION.test(expandable(command));
  return pieces(command)
    .filter((p) => substitution || !dropped(p))
    .map((p) => p.text)
    .join(";");
}

/** True when a segment's text is not executed, or is a REST read the door agrees with. */
function dropped(p: Piece): boolean {
  if (p.next === "|" || p.next === "|&") return false;
  return isInertSegment(p.text) || isRestRead(p.text);
}

/**
 * A segment whose text is provably not executed: its head is `echo` or
 * `printf` (they run nothing they print), or `git commit` with a message
 * (`-m` is data). No redirection, here-doc, `${…}` or substitution character
 * and no interpreter word may appear in it.
 */
function isInertSegment(text: string): boolean {
  if (/[<>`]|\$\{|\$\(/.test(expandable(text))) return false;
  const toks = rawTokens(text);
  if (toks.terminated === false) return false;
  const words = toks.list.filter((t) => !isSeparatorToken(t)).map(unquoteArg);
  if (words.some((w) => INTERPRETERS.has(w.split("/").pop() ?? w))) return false;
  const [head = "", second = ""] = words;
  if (head === "echo" || head === "printf") return true;
  return (
    head === "git" &&
    second === "commit" &&
    words.some((w) => w === "-m" || w === "--message" || w.startsWith("--message="))
  );
}
