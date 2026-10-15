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
 */

import { isSeparatorToken, rawTokens, shellSegments, unquoteArg } from "./merge-tokens.ts";

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

/**
 * The command with its `echo` / `printf` segments removed. Those commands
 * never run their arguments, so a merge-like word inside one is data (the
 * existing inert-quoted-string contract: `echo "gh pr merge 12"` is allowed).
 * Unreadable quoting returns the whole command — nothing is exempted when the
 * segments cannot be trusted.
 */
export function executableText(command: string): string {
  if (rawTokens(command).terminated === false) return command;
  return shellSegments(command)
    .filter((seg) => !isInertSegment(seg))
    .join(";");
}

/**
 * A segment whose merge-like text is provably NOT executed:
 *   - `echo` / `printf` never run their arguments;
 *   - `git commit`: a message (`-m "…gh pr merge 12"`) is data;
 *   - `sh|bash|zsh|dash -c WORD` with a plain word body: the shell runs only
 *     WORD (the rest are `$0…`), so `bash -c gh pr merge 17` runs `gh`;
 *   - a forge `api` call with an explicit GET and no body fields: the REST
 *     door already reads it as a read (test-merge-guard-962 / -955-rest).
 * Each exemption only applies to the zero-merge-head backstop: a merge the
 * readers DO find is still refused, wherever it sits.
 */
function isInertSegment(seg: string): boolean {
  const words = rawTokens(seg)
    .list.filter((t) => !isSeparatorToken(t))
    .map(unquoteArg);
  const [head = "", second = "", third = ""] = words;
  if (head === "echo" || head === "printf") return true;
  if (head === "git" && second === "commit") return true;
  if (/^(?:sh|bash|zsh|dash)$/.test(head) && second === "-c") return /^[\w./-]+$/.test(third);
  return isExplicitGetApi(words);
}

/**
 * A forge `api` call the REST door reads as a read: no body field, and the
 * method is GET. `glab api` defaults to GET; `gh api` defaults to a write, so
 * it needs an explicit GET (the door's own rules, bash-merges-pr.ts).
 */
function isExplicitGetApi(words: string[]): boolean {
  const forge = words.findIndex((w) => /^(?:gh|glab)$/.test(w.split("/").pop() ?? ""));
  if (forge === -1 || words[forge + 1] !== "api") return false;
  const rest = words.slice(forge + 2);
  const bodyField = rest.some(
    (w) => /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(w) || /^-[fF]./.test(w),
  );
  const methods = rest.flatMap((w, k) => {
    if (/^(?:--method|-X)$/.test(w)) return [rest[k + 1] ?? ""];
    const inline = /^(?:--method=|-X)(\S+)$/.exec(w);
    return inline?.[1] ? [inline[1]] : [];
  });
  const isGet = (m: string) => /^get$/i.test(m);
  const isRead = /^glab$/.test(words[forge] ?? "")
    ? methods.every((m) => isGet(m) || /^head$/i.test(m))
    : methods.length > 0 && methods.every(isGet);
  return isRead && !bodyField;
}
