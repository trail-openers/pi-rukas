/**
 * merge-verb-head — the segment-head matcher for the merge guard's verb
 * door (#955, round-2 hardening).
 *
 * The legacy matcher ran one regex over the quote-stripped WHOLE command
 * (with a bare `oo\s+` wrapper). It saw a command only after the shell
 * evaluator — and the shapes below all survive quote-stripping intact, so
 * they bypassed the guard (adversarial round 2 of #955, confirmed by
 * execution):
 *
 *   - process-wrapper prefixes: `timeout 30 gh pr merge 17`, `command gh
 *     pr merge 17`, `nohup … &`, `sudo …`, `nice …`, `time …`, `oo …`
 *     (bare), `env -i …`, `stdbuf -oL …`;
 *   - a forge path instead of a bare name: `/usr/bin/gh pr merge 17`;
 *   - a command word inside a subshell or command substitution — that is
 *     handled by the caller, which extracts the `( … )` / `$( … )` / backtick
 *     bodies and recurses with `matchMergeVerb` (the same treatment `bash -c`
 *     bodies already get);
 *   - nested shell eval past the unwrap budget — the caller fails those
 *     closed.
 *
 * The fix: before matching a segment, strip the leading wrappers REPEATEDLY
 * (bash itself unwraps iteratively: `nohup sudo nice gh …` is all one
 * invocation), so `gh`/`glab` ends up where the verb regex expects it.
 * The wrappers are the same set `stripLeadingWrappers` in
 * bash-command-parser.ts skips for allowlist prefix extraction (extended
 * with `oo` and `sudo`, which have no flags at all), re-implemented here
 * over the raw tokens because that module is imported BY this module's
 * caller (bash-merges-pr.ts) — importing it back would be a cycle.
 */

import { rawTokens, unquoteArg } from "./merge-tokens.ts";

/** Wrapper words that take NO flags: the next token is the real command. */
const BARE_WRAPPERS = new Set(["command", "builtin", "nohup", "sudo", "oo"]);

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
  const tokens = rawTokens(text);
  if (tokens.terminated === false) return undefined;
  const list = tokens.list;
  let i = 0;
  while (i < list.length) {
    const t = list[i] ?? "";
    // A quote- or variable-substituted command word is not the bare shape
    // the guard unwraps — no forge word to match, and not a wrapper.
    if (t[0] === "'" || t[0] === '"' || t[0] === "$" || t === "`") return undefined;
    const forge = forgeWord(t);
    if (forge) {
      // The forge word found: the segment is a merge invocation when the
      // remaining tokens carry `pr merge` / `mr merge` (the number is
      // optional; `-R`/`--repo` before the verb is allowed).
      const rest = [t, ...list.slice(i + 1)].join(" ");
      // The regex is anchored to the START of `rest` (the forge word is the
      // first token). `(?:-R ...|--repo ...)?` is optional, so the verb
      // follows the forge word directly (one space). `pr merge` / `mr merge`
      // is the merge verb; the trailing `(?:\s|$)` ensures `merge` is a
      // whole token (not a prefix of a longer word).
      return new RegExp(
        `^(?:${forge}|/\\S*/${forge})\\s+(?:-R\\s+\\S+|--repo\\s+\\S+)?\\s*(?:pr|mr)\\s+merge(?:\\s|$)`,
      ).test(rest)
        ? forge
        : undefined;
    }
    if (BARE_WRAPPERS.has(t)) {
      i++;
      continue;
    }
    let j = i + 1;
    if (t === "timeout" || t === "stdbuf") {
      // `timeout [--signal=X|-s X|-k N|-p|-v …] <duration>` — the duration
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
          // A flag: take its value token when it has one (`-s TERM`),
          // or none (`--signal=TERM`, `-k` is positional too).
          j++;
          if (f.startsWith("-") && !f.slice(1).startsWith("-") && !f.includes("=")) j++;
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
      // `env [-i] [VAR=…]… <cmd>` — skip flags and VAR=VAL assignments.
      j = i + 1;
      while (j < list.length) {
        const e = list[j] ?? "";
        if (e.startsWith("-")) {
          j++;
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

/**
 * Unwrap ONE shell-eval layer (`bash -c …`, `sh -c …`, `eval …`, with
 * `env`/`oo` wrappers) to its quoted string argument. Exported so the
 * merge guard can walk the layers itself when extracting the repo flag
 * (which can appear before the verb, in the pre-verb portion of the
 * command).
 *
 * The token walk is over the RAW command (quote-aware, offsets preserved —
 * unlike stripQuotedSegments, which drops quoted interiors and cannot be
 * used to locate argument text). The invocation is identified among
 * UNQUOTED tokens; the argument is the first quoted token that follows it.
 * This is what makes `bash -c 'echo "pr merge"'` safe: the recursive match
 * then runs on `echo "pr merge"`, where the quoted verb is inert the same
 * way `echo "gh pr merge 12"` is inert at the top level.
 *
 * Returns the inner string, or undefined when the command does not invoke
 * one of these shells (an `env VAR=…` prefix is consumed transparently —
 * the walk lands on the real command word, so `env FOO=1 bash -c '…'`
 * unwraps to `…`).
 */
export function mergeVerbUnwrapOne(command: string): string | undefined {
  const tokens = rawTokens(command);
  if (tokens.terminated === false) return undefined;
  let i = 0;
  const n = tokens.list.length;
  while (i < n) {
    const t = tokens.list[i] ?? "";
    if (t === ";" || t === "&&" || t === "|" || t === "||") {
      i++;
      continue; // a new segment starts — the invocation must head a segment
    }
    if (t === "oo") {
      i++;
      continue; // the oo wrapper: the real command word follows
    }
    if (t === "env") {
      i++;
      // Skip env flags (--null, -i, --, …) and VAR=VAL assignments.
      while (i < n) {
        const e = tokens.list[i] ?? "";
        if (e.startsWith("-")) {
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) {
          i++;
          continue;
        }
        break;
      }
      if (i >= n) return undefined;
      continue; // re-loop: the command word follows the env assignments
    }
    const q = t[0];
    if (q === "'" || q === '"') return undefined; // a quoted token is not a command word
    if (t === "bash" || t === "sh" || t === "zsh" || t === "dash") {
      // Consume flag tokens up to (and including) the -c/-lc flag; the
      // quoted string argument is the first quoted token after it.
      let j = i + 1;
      let sawC = false;
      while (j < n) {
        const f = tokens.list[j] ?? "";
        if (f === "-c" || f === "-lc") {
          sawC = true;
          j++;
          break;
        }
        if (f.startsWith("-")) {
          j++;
          continue;
        }
        break;
      }
      if (!sawC) return undefined;
      const arg = tokens.list[j];
      if (arg === undefined) return undefined;
      const aq = arg[0];
      if (aq !== "'" && aq !== '"' && !arg.startsWith("$'")) return undefined; // unquoted -c body is not the shape the guard unwraps
      const inner = unquoteArg(arg);
      return inner.length > 0 ? inner : undefined;
    }
    if (t === "eval") {
      const arg = tokens.list[i + 1];
      if (arg === undefined) return undefined;
      const aq = arg[0];
      if (aq !== "'" && aq !== '"' && !arg.startsWith("$'")) return undefined;
      const inner = unquoteArg(arg);
      return inner.length > 0 ? inner : undefined;
    }
    return undefined; // any other first token: this is not a shell-eval command
  }
  return undefined;
}

/**
 * The bodies of subshell and command-substitution constructs in the
 * (already unwrapped) segment: `( … )` subshells, `$( … )` substitutions
 * and backtick substitutions, found by a quote-aware balanced scan. Each
 * body is a real inner command that the verb matcher must run recursively,
 * the same as `bash -c` bodies. A quote is always the start of a quoted
 * argument (never a construct), so quotes are skipped whole and can never
 * open a construct.
 */
export function innerBodies(text: string): string[] {
  const bodies: string[] = [];
  const n = text.length;
  let error = false;
  // Find the matching close for a construct opened at `open`/`close` chars,
  // skipping quoted runs and recursing into nested opens. `end` is the index
  // just past the matching close. Backticks are treated as plain chars here
  // (nested backticks inside a paren construct are not the shape the guard
  // unwraps — the top-level backtick scan owns those).
  const scanParen = (open: number, close: number): number | undefined => {
    let depth = 1;
    let i = open + 1;
    while (i < n) {
      const c = text[i] ?? "";
      if (c === "'" || c === '"') {
        const q = c;
        i++;
        while (i < n) {
          if (q === '"' && text[i] === "\\" && i + 1 < n) {
            i += 2;
            continue;
          }
          if (text[i] === q) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (c === "(") {
        depth++;
        i++;
        continue;
      }
      if (c === ")") {
        depth--;
        i++;
        if (depth === 0) return i;
        continue;
      }
      i++;
    }
    error = true; // unbalanced ( — the caller fails closed
    return undefined;
  };
  // Skip a quoted run starting at `i`; returns the index just past the
  // closing quote, or undefined on an unterminated quote.
  const skipQuote = (i: number): number | undefined => {
    const q = text[i] ?? "";
    i++;
    while (i < n) {
      if (q === '"' && text[i] === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (text[i] === q) {
        return i + 1;
      }
      i++;
    }
    return undefined;
  };
  // The top-level backtick body, quote-aware: an escaped backtick (\`) is
  // literal; a `$(` inside is skipped as a nested construct (bash does not
  // evaluate it as part of the backtick body).
  const scanBacktick = (open: number): number | undefined => {
    let i = open + 1;
    while (i < n) {
      const c = text[i] ?? "";
      if (c === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (c === "`") return i;
      if (c === "$" && (text[i + 1] ?? "") === "(") {
        const end = scanParen(i + 1, i + 1);
        if (end === undefined) return undefined;
        i = end;
        continue;
      }
      i++;
    }
    return undefined; // unterminated backtick — the caller fails closed
  };
  let i = 0;
  while (i < n && !error) {
    const c = text[i] ?? "";
    if (c === "'" || c === '"') {
      const end = skipQuote(i);
      if (end === undefined) {
        error = true;
        break;
      }
      i = end;
      continue;
    }
    if (c === "(") {
      const end = scanParen(i, i);
      if (end === undefined) break;
      bodies.push(text.slice(i + 1, end - 1));
      i = end;
      continue;
    }
    if (c === "$" && (text[i + 1] ?? "") === "(") {
      const end = scanParen(i + 1, i + 1);
      if (end === undefined) break;
      bodies.push(text.slice(i + 2, end - 1));
      i = end;
      continue;
    }
    if (c === "`") {
      const end = scanBacktick(i);
      if (end === undefined) {
        error = true;
        break;
      }
      bodies.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return bodies;
}
