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
 * `bin/gh pr merge 17`, `./gh pr merge 17`). #955 adversarial round 2,
 * finding 2: relative forge paths (`./gh`, `bin/gh`) were not matched —
 * only absolute paths were. The check now uses the basename uniformly,
 * covering absolute, relative, and bare forms in one test.
 */
function forgeWord(t: string): string | undefined {
  if (t === "gh" || t === "glab") return t;
  if (t.includes("/")) {
    const base = t.split("/").pop();
    if (base === "gh" || base === "glab") return base;
  }
  return undefined;
}

/**
 * Skip the leading process wrappers (and their flags/values) of a token
 * list, starting at index `i`: the BARE_WRAPPERS (with `sudo`'s optional
 * flags), the flag-taking wrappers (`timeout`, `stdbuf`, `nice`, `time`,
 * `env`), the `VAR=VALUE` assignment prefix, and the transparent
 * control-flow keywords. Returns the index of the token the walk lands on
 * (the real command word, or the first token it cannot skip past).
 *
 * Extracted from `matchMergeVerb`'s walk so the shell-eval unwrapper in
 * merge-verb-head.ts can skip the SAME wrappers before identifying the
 * shell-eval word (`exec bash -c …`, `sudo bash -c …`, `timeout 30 bash
 * -c …`, …): a process wrapper in front of `bash -c` is the same invocation
 * as the bare form, and the unwrapper that only recognised the shell-eval
 * word at token 0 left those merges invisible (#955 lens round 3). The
 * caller still applies the quote/paren/substitution checks per token — the
 * shell-eval word is DATA for this walk, so it stops here. A FORGE word
 * also stops the walk (the walk lands on a command word and the caller
 * decides: the shell-eval unwrapper owns the forge case itself, and
 * `matchMergeVerb` tests its head before calling). Never advances past
 * the list end: the caller owns the "nothing left" refusal.
 */
export function skipLeadingWrappers(tokens: string[], start: number): number {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    // A forge word is a command, not a wrapper — the walk stops and lets
    // the caller decide (see the jsdoc above).
    if (forgeWord(t) !== undefined) return i;
    // A VAR=VALUE assignment prefix is transparent — the shell sets the
    // variable and runs the NEXT token as the command (the same treatment
    // `matchMergeVerb` gives it).
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    // The transparent control-flow keywords: a merge (or a shell-eval
    // invocation) can head any command of a compound-list, and the wrappers
    // can sit behind them the same way.
    if (t === "function") {
      if (i + 1 < tokens.length && (tokens[i + 1] ?? "") !== "{") i++;
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
        while (i < tokens.length) {
          const f = tokens[i] ?? "";
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
      while (j < tokens.length) {
        const f = tokens[j] ?? "";
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
      if (j < tokens.length && !(tokens[j] ?? "").startsWith("-")) j++;
      i = j;
      continue;
    }
    if (t === "stdbuf") {
      // `stdbuf [-oL] <cmd>` — skip flags (no positional); the command
      // word follows the flags directly.
      j = i + 1;
      while (j < tokens.length) {
        const f = tokens[j] ?? "";
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
      while (j < tokens.length) {
        const f = tokens[j] ?? "";
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
      while (j < tokens.length) {
        const f = tokens[j] ?? "";
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
      // take one) and VAR=VAL assignments.
      j = i + 1;
      while (j < tokens.length) {
        const e = tokens[j] ?? "";
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
    return i; // anything else: a command word (or an unskippable token)
  }
  return i;
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
  // The wrapper vocabulary (BARE_WRAPPERS, `sudo` flags, `timeout`/
  // `stdbuf`/`nice`/`time`/`env` flag+value skipping, `VAR=VALUE`
  // prefixes, transparent keywords) lives in `skipLeadingWrappers`; the
  // walk below only keeps the checks specific to a FORGE-word head — the
  // quote/substitution and paren checks (which `skipLeadingWrappers`
  // deliberately defers to the caller) and the forge-word head test.
  let i = 0;
  while (i < list.length) {
    const t = list[i] ?? "";
    // A quote- or variable-substituted command word is not the bare shape
    // the guard unwraps — no forge word to match, and not a wrapper.
    if (t[0] === "'" || t[0] === '"' || t[0] === "$" || t === "`") return undefined;
    // A leading `(` or `)` (subshell delimiter) is not a command word.
    // `rawTokens` glues an adjacent paren to the next word (`(gh`), so
    // strip it and re-test the remainder as the command head (#955
    // adversarial round 1: `(gh pr merge 17` — the paren made `gh` land
    // inside the first token and the merge read as "not a merge").
    if (t[0] === "(" || t[0] === ")") {
      const rest = t.slice(1);
      if (rest.length === 0) {
        i++;
        continue;
      }
      const forge = forgeWord(rest);
      if (forge) {
        const seg = [rest, ...list.slice(i + 1)].join(" ");
        const isMerge = mergeVerbHeadRegex().test(seg);
        return isMerge ? forge : undefined;
      }
      i++;
      continue;
    }
    // The segment head matched a forge word: run the verb regex on the
    // remaining tokens. A non-merge forge command (`gh pr view …`, `glab
    // mr view …`) is a HEAD test that returns undefined — the caller falls
    // through to the REST doors for this segment. Do NOT advance past the
    // forge word into the wrapper walk: the forge word IS a command, and
    // advancing past it would let a non-merge read as a merge if a verb
    // happened to appear later in the same segment.
    const forge = forgeWord(t);
    if (forge) {
      const rest = [t, ...list.slice(i + 1)].join(" ");
      const isMerge = mergeVerbHeadRegex().test(rest);
      return isMerge ? forge : undefined;
    }
    // Everything that is not a forge word is either a leading wrapper
    // (BARE_WRAPPERS, `timeout`, `stdbuf`, `nice`, `time`, `env`, the
    // `VAR=VALUE` prefix, the transparent control-flow keywords — see
    // `skipLeadingWrappers` for the vocabulary and flag rules) or a
    // command word that is not a merge invocation. The walk lands on the
    // real command word; a forge head is matched there (the walk stops at
    // forge words), anything else is not a merge invocation.
    i = skipLeadingWrappers(list, i);
    if (i >= list.length) break;
    const landed = list[i] ?? "";
    const landedForge = forgeWord(landed);
    if (landedForge) {
      const rest = [landedForge, ...list.slice(i + 1)].join(" ");
      const isMerge = mergeVerbHeadRegex().test(rest);
      return isMerge ? landedForge : undefined;
    }
    return undefined;
  }
  return undefined;
}
