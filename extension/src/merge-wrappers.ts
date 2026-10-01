/**
 * merge-wrappers — the wrapper-stripping unit of the merge guard's
 * segment-head matcher (#955, round-2 hardening).
 *
 * Moved from merge-verb-head.ts (which sat over the 500-line §12 limit)
 * without any change to the code or comments: the shell keywords the head
 * walk treats as transparent, the wrapper sets, the forge-word normaliser
 * and the wrapper-stripping head match live here; merge-verb-head.ts
 * imports the head match back.
 */

import { rawTokens } from "./merge-tokens.ts";
import { mergeVerbHeadRegex } from "./merge-tokens.ts";

/**
 * The shell keywords that open a control-flow / compound construct (`if`,
 * `for`, `while`, `until`, `function`, `select`, `case`) or a compound-list
 * delimiter (`then`, `do`, `!`, `{`, `}`, `)`). The segment-head matcher
 * treats every one of them as TRANSPARENT — the merge verb can head any
 * command of a compound-list (adversarial round 3, finding 1), and bailing
 * on them was the bypass. Quoted tokens are never transparent (they are
 * data, checked first by the quote test). `function` is handled separately
 * because it optionally takes a name token.
 */
const TRANSPARENT_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
  "until",
  "select",
  "case",
  "esac",
  "!",
  "{",
  "}",
  ")",
]);

/**
 * Wrapper words that take NO flags: the next token is the real command.
 * `exec` re-executes the shell's own invocation as the new command
 * (`exec gh pr merge 17` runs the merge identically to the bare form) —
 * it is a wrapper, not a command head.
 */
const BARE_WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "sudo", "oo"]);

/**
 * The forge command word, normalised: a path ending in `/gh` or `/glab`
 * is the same invocation as the bare name (`/usr/bin/gh pr merge 17`,
 * `/opt/homebrew/bin/gh …`).
 */
function forgeWord(t: string): string | undefined {
  if (t === "gh" || t === "glab") return t;
  if (/^\/.*\/(gh|glab)$/.test(t)) return t.split("/").pop();
  return undefined;
}

/**
 * Scan a segment's leading tokens and return the forge command word when
 * the segment HEAD is a merge invocation under any number of wrappers.
 *
 * `undefined` when the segment is not a merge invocation (or the token
 * walk is unparseable — the caller treats that as "no match here", the
 * fail-closed paths upstream own the refusal).
 */
export function matchMergeVerb(text: string): string | undefined {
  // The verb door: `gh pr merge` / `glab mr merge`, number optional.
  // (#955 round-2: the verb no longer runs as one whole-command regex — it
  // is matched per segment head here, after stripping wrapper words, so the
  // number optionality now also holds for wrapped/inner invocations.)
  const tokens = rawTokens(text);
  if (tokens.terminated === false) return undefined;
  const list = tokens.list;
  let i = 0;
  while (i < list.length) {
    const t = list[i] ?? "";
    // A quote- or variable-substituted command word is not the bare shape
    // the guard unwraps — no forge word to match, and not a wrapper.
    if (t[0] === "'" || t[0] === '"' || t[0] === "$" || t === "`" || t[0] === "(") return undefined;
    // The segment head matched a forge word: run the verb regex on the
    // remaining tokens. A non-merge forge command (`gh pr view …`, `glab
    // mr view …`) is a HEAD test that returns undefined — the caller falls
    // through to the REST doors for this segment. Do NOT advance past the
    // forge word into the transparent-keyword walk: the forge word IS a
    // command, and advancing past it would let a non-merge read as a merge
    // if a verb happened to appear later in the same segment.
    const forge = forgeWord(t);
    if (forge) {
      const rest = [t, ...list.slice(i + 1)].join(" ");
      const isMerge = mergeVerbHeadRegex(forge).test(rest);
      return isMerge ? forge : undefined;
    }
    // Round-3 (adversarial finding 1): a control-flow / compound-construct
    // token is TRANSPARENT — it does not end the walk. The merge verb can
    // head any segment of a compound-list command (`if true; then gh pr
    // merge 17; fi`, `for i in 1; do gh pr merge 17; done`, `function f {
    // gh pr merge 17; }; f`, `! gh pr merge 17`, `{ gh pr merge 17; }`),
    // and bailing on any of these tokens was the bypass: the verb door
    // never fired and the merge read as "not a merge". Advancing over them
    // mirrors what the shell does — the merge runs in the same shell, with
    // the same credentials. Quoted tokens already failed the quote test
    // above, so a quoted `"if"` argument can never fake this path.
    if (t === "function") {
      // `function name { … }` or `function { … }` — advance past the name
      // (if present) so the walk can reach the body's command head.
      if (i + 1 < list.length && (list[i + 1] ?? "") !== "{") i++;
      i++;
      continue;
    }
    if (TRANSPARENT_KEYWORDS.has(t)) {
      i++;
      continue;
    }
    if (BARE_WRAPPERS.has(t)) {
      i++;
      // `sudo` takes optional flags (`-u user`, `-E`, etc.) — skip them.
      if (t === "sudo") {
        while (i < list.length) {
          const f = list[i] ?? "";
          if (f.startsWith("-")) {
            i++;
            // `-u` takes a value; other flags are bare.
            if (f === "-u" || f === "--user") i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    let j = i + 1;
    if (t === "timeout") {
      // `timeout [--signal=X|-s X|-k N|-v|-p …] <duration>` — the duration
      // is the last argument before the command; skip flags then one
      // positional.
      j = i + 1;
      while (j < list.length) {
        const f = list[j] ?? "";
        if (f === "--" || f === "-v" || f === "-p") {
          j++;
          continue;
        }
        if (f.startsWith("-")) {
          // A flag: take its value token when the flag takes one —
          // space-separated (`-s TERM`, `-k 5`) or `--flag=value` (the
          // value is inside the token, nothing to skip).
          j++;
          if (f.startsWith("--") && !f.includes("=")) j++;
          else if (f.length === 2) j++; // a short flag (`-s`, `-k`) takes a value
          continue;
        }
        break;
      }
      // The duration (if any) is the next positional — skip it; the
      // command word follows.
      if (j < list.length && !list[j]?.startsWith("-")) j++;
      i = j;
      continue;
    }
    if (t === "stdbuf") {
      // `stdbuf [-oL] <cmd>` — skip flags (no positional); the command
      // word follows the flags directly.
      j = i + 1;
      while (j < list.length) {
        const f = list[j] ?? "";
        if (f.startsWith("-")) {
          j++;
          continue;
        }
        break;
      }
      i = j;
      continue;
    }
    if (t === "nice") {
      j = i + 1;
      while (j < list.length) {
        const f = list[j] ?? "";
        if (f === "-n") {
          j += 2; // `-n <N>`
          continue;
        }
        if (f.startsWith("-")) {
          j++;
          continue;
        }
        break;
      }
      i = j;
      continue;
    }
    if (t === "time") {
      j = i + 1;
      while (j < list.length) {
        const f = list[j] ?? "";
        if (f === "-p") {
          j++;
          continue;
        }
        break;
      }
      i = j;
      continue;
    }
    if (t === "env") {
      // `env [-i | -u VAR | --unset VAR | -C DIR | --chdir DIR | …] [VAR=…]…
      // <cmd>` — skip flags (skipping the value token of the flags that
      // take one) and VAR=VAL assignments. `-u`/`--unset` (repeated),
      // `-C`/`--chdir` and `--ignore-unknown` are the flags whose value
      // token must not be read as the command word: `env -u FOO gh pr
      // merge 17` is the merge — walking past `-u` and stopping at `FOO`
      // (the round-1 skip-all-dashes walk) made `FOO` the "command word"
      // and the door stayed open.
      j = i + 1;
      while (j < list.length) {
        const e = list[j] ?? "";
        if (e.startsWith("-")) {
          j++;
          if (e === "-u" || e === "--unset" || e === "-C" || e === "--chdir") j++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) {
          j++;
          continue;
        }
        break;
      }
      i = j;
      continue;
    }
    return undefined; // anything else: the segment head is not a merge invocation
  }
  return undefined;
}
