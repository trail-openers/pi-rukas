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
 * Round-3 (adversarial finding 1): the segment head walk previously bailed
 * on any token that was not a wrapper, a shell-eval word, or a forge word —
 * so control-flow / compound-construct shapes (`if …; then gh pr merge 17;
 * fi`, `for …; do gh pr merge 17; done`, `function f { gh pr merge 17; };
 * f`, `! gh pr merge 17`, `{ gh pr merge 17; }`) never reached the verb
 * regex and the merge read as "not a merge". Those tokens are now treated
 * as transparent (see TRANSPARENT_KEYWORDS in merge-wrappers.ts): the walk
 * advances past them until it finds the forge word, because the merge runs
 * in the same shell with the same credentials. Quoted tokens are checked
 * first and bail, so a quoted `"if"` argument can never fake the
 * transparent path.
 *
 * The fix: before matching a segment, strip the leading wrappers REPEATEDLY
 * (bash itself unwraps iteratively: `nohup sudo nice gh …` is all one
 * invocation), so `gh`/`glab` ends up where the verb regex expects it.
 * The wrapper-stripping head match lives in merge-wrappers.ts (moved from
 * here after this file breached the 500-line §12 limit); the wrappers are
 * the same set `stripLeadingWrappers` in bash-command-parser.ts skips for
 * allowlist prefix extraction (extended with `oo` and `sudo`, which have
 * no flags at all), re-implemented over the raw tokens because that module
 * is imported BY this module's caller (bash-merges-pr.ts) — importing it
 * back would be a cycle.
 */

import { rawTokens, unquoteArg } from "./merge-tokens.ts";
import { matchMergeVerb, skipLeadingWrappers } from "./merge-wrappers.ts";

export { matchMergeVerb };

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
 * Leading PROCESS wrappers in front of the shell-eval word are skipped
 * before the word is identified — `exec bash -c …`, `sudo bash -c …`,
 * `timeout 30 bash -c …`, `nohup bash -c …`, … are the same invocation as
 * the bare form, and only recognising the shell-eval word at token 0 left
 * those merges invisible (#955 lens round 3, PM-verified bypass). The
 * wrapper vocabulary (and flag/value skipping) is the SAME one
 * `matchMergeVerb` uses, via `skipLeadingWrappers` in merge-wrappers.ts.
 *
 * Returns the inner string, or undefined when the command does not invoke
 * one of these shells (an `env VAR=…` prefix is consumed transparently —
 * the walk lands on the real command word, so `env FOO=1 bash -c '…'`
 * unwraps to `…`).
 */
export function mergeVerbUnwrapOne(command: string): string | undefined {
  const tokens = rawTokens(command);
  if (tokens.terminated === false) return undefined;
  const list = tokens.list;
  let i = 0;
  const n = list.length;
  while (i < n) {
    const t = list[i] ?? "";
    if (t === ";" || t === "&&" || t === "|" || t === "||") {
      i++;
      continue; // a new segment starts — the invocation must head a segment
    }
    // #955 adversarial round 4: a token that starts with a BACKSLASH is a
    // literal (escaped) character, not a command word — it can never name
    // a shell. Without this check a leading `\\` in front of a quoted body
    // (`git commit -m \\'pr merge\''`) would fall through to the wrapper
    // walk and (the walk landing on the quoted body as the "command") the
    // quoted body would be unwrapped as if it were a real shell-eval
    // invocation — the false-positive the reviewer tested.
    if (t[0] === "\\") return undefined;
    // A quoted token is not a command word.
    if (t[0] === "'" || t[0] === '"') return undefined;
    // Process wrappers in front of the shell-eval word (`exec bash -c …`,
    // `sudo -u x bash -c …`, `timeout 30 bash -c …`, …) are the same
    // invocation as the bare form — skip them with the shared vocabulary
    // (`skipLeadingWrappers`, merge-wrappers.ts). It does NOT handle
    // `env -S "…"` (the quoted command string is the unwrap target, not a
    // flag value), so `env` is consumed here with its `-S` special case.
    if (
      t === "oo" ||
      t === "env" ||
      t === "exec" ||
      t === "sudo" ||
      t === "command" ||
      t === "builtin" ||
      t === "nohup" ||
      t === "timeout" ||
      t === "stdbuf" ||
      t === "nice" ||
      t === "time" ||
      t === "eval"
    ) {
      if (t === "env") {
        // `env [-S "…"] [-u VAR | …] [VAR=…]… <cmd>` — skip flags and
        // assignments; `-S` takes a quoted string argument that IS the
        // command — unwrap to it directly (#955 adversarial round 1:
        // `env -S "gh pr merge 17"` is the same merge as the bare form).
        i++;
        while (i < n) {
          const e = list[i] ?? "";
          if (e.startsWith("-")) {
            if (e === "-S" || e === "--string") {
              const s = list[i + 1];
              if (s === undefined) return undefined;
              const sq = s[0];
              if (sq !== "'" && sq !== '"' && !s.startsWith("$'")) return undefined;
              const inner = unquoteArg(s);
              return inner.length > 0 ? inner : undefined;
            }
            i++;
            if (e === "-u" || e === "--unset" || e === "-C" || e === "--chdir") i++;
            continue;
          }
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) {
            i++;
            continue;
          }
          break;
        }
        if (i >= n) return undefined;
      } else {
        // `command`/`sudo`/`nohup`/… are process wrappers — `skipLeadingWrappers`
        // consumes them and the loop re-tests the landed token. `eval` is the
        // ONE wrapper that is also a shell-eval word: `skipLeadingWrappers`
        // treats it transparently ONLY when its argument is unquoted (the
        // transparent `eval gh pr merge 17` case — the walk advances past
        // `eval` to the forge word), and stops at `eval` when the argument is
        // quoted (the `eval "gh pr merge 17"` case — the shell-eval branch
        // below unwraps the quoted body). The quote-aware handling lives
        // entirely in `skipLeadingWrappers`; the loop just advances past the
        // wrapper and re-tests the landed token (the eval branch below
        // handles the quoted case). The loop always advances — the previous
        // version used `continue` here, which re-entered the loop without
        // advancing `i`, spinning forever on `eval "…"` / `command eval "…"`.
        i = skipLeadingWrappers(list, i);
      }
      if (i >= n) return undefined;
      continue; // re-loop: the command word follows the wrapper
    }
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
  const skipQuote = (start: number): number | undefined => {
    const q = text[start] ?? "";
    let i = start;
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
