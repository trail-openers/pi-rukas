/**
 * git-push-command — the pure predicate behind `developer-push-guard.ts` (#1113).
 *
 * One question, no Pi API and no filesystem: does this bash command push a
 * git remote? It lives apart from the guard so the table test drives the
 * matcher directly (the `discardsUncommittedWork` / `rejectsInteractiveGit`
 * shape in `bash-command-parser.ts`, which `test-subagent-git-guard.ts`
 * exercises the same way).
 *
 * ## The scan-not-anchor + strip-quoted doctrine, and the two ways it fails
 *
 * Every agent command is a chain (`cd x && git push`), so the verb is SEARCHED
 * for, never anchored at word 0. And because a command that merely MENTIONS
 * `git push` in prose must stay allowed (`gh pr comment --body '… git push …'`),
 * quoted runs are stripped before matching — `stripQuotedSegments`, the same
 * helper the destructive-git guard uses.
 *
 * Stripping quoted runs has exactly one dangerous consequence, and it is why
 * this matcher reads quoted bodies: `bash -c 'git push'` / `sh -c "git push"`
 * hand the payload to a shell that WILL run it, and the strip removes it, so a
 * naive matcher reads "nothing here" and lets the push through. `echo "git push"`
 * must still stay allowed. The resolution is the shell's own distinction: a
 * quoted run is a script body when it is the argument of a shell-runner
 * (`bash`/`sh`/`zsh`/`dash`/`ksh`, with `-c`/`-lc`/… or `-`), and prose
 * otherwise. Bodies of the first kind are decoded and asked; everything else
 * stays stripped.
 *
 * ## What counts as the push verb
 *
 * `git [global options] push …`. Global options are matched **positionally,
 * not by a whitelist**, and that is load-bearing. `git -C p push` used to be a
 * MISS here: the globals were spelled as a word list, and a word list cannot
 * express "a flag whose VALUE is the next word", because a value is anything —
 * `p`, `/repo`, `a.b=c`. The shape that matches is a positional walk: one run
 * of global flags (each optionally `=`-attached), each followed by at most one
 * value word, terminated at the verb.
 *
 * A positional walk admits more shapes than a whitelist does, so the question
 * it must not over-answer is "does `git log origin/main..origin/push-handling`
 * become a push?". It does not, and the reason is the boundary after `push`,
 * not the list in front of it: `push` only matches as a complete word, so the
 * ref `origin/push-handling`, the `pusher` tool, and `--push-option` are all
 * rejected by the lookahead — and none of them can be reached by the walk at
 * all, because `log` is not a global flag. That is why no value whitelist (a
 * `[^push]` trick, or rejecting values that begin with `push`) is needed, and
 * why none is present: those approaches fail on `git -c foo=bar push` (the
 * value `foo=bar` must pass) or on a legitimate refspec, while the word
 * boundary does the job on its own.
 * The older `GIT` pattern in `bash-command-parser.ts` handles `-C` only, which
 * is why a separate pattern lives here rather than extending that one: these
 * predicates answer different questions and their false-positive costs differ.
 */

import { stripQuotedSegments } from "./bash-command-parser.ts";

/**
 * One git GLOBAL flag — a flag git reads before the verb (`--git-dir=/repo`,
 * `--no-pager`, `-c k=v`), with its value only in the `=`-attached form. A
 * leading `-` is the only structural fact a guard can rely on: no static list
 * of flag names covers what a developer types, and a list would mean a new git
 * global becomes a way past this guard. `[^;&|\s]` keeps the token inside one
 * simple command.
 *
 * A SPACE-separated value is deliberately NOT consumed, and that is the
 * over-refusal fix of this matcher. `git commit -m 'do not push'` reaches it as
 * `git commit -m "."` — quoted contents are stripped before matching, so prose
 * cannot forge a verb, and a blanked run carries no spaces. If the walk also
 * ate the token after a flag, that dot would become `-m`'s value, the walk
 * would cross the segment boundary, and any later bare `push` — a second
 * command, or a blanked message that merely named the verb — would refuse the
 * COMMIT the develop gate requires. So one flag token per iteration, nothing
 * more. The one shape that costs is git's positional `-C <path>`, recovered by
 * `GIT_C_PUSH` below rather than folded back into this pattern.
 */
const GIT_GLOBAL = String.raw`-{1,2}[^;&|\s]+`;

/**
 * `git … push` as a whole word: preceded by start-of-string or a shell
 * operator/space, optionally wrapped in `oo` (the verbose-runner prefix this
 * harness rewrites commands to), then any run of git globals, then `push` as a
 * complete word. The lookahead after `push` is `-`-aware on purpose: the verb
 * followed by a flag is still the verb, so `--` must NOT reject it, while a
 * longer word that merely starts with it (`pushmirror`, `pusher`) is not it and
 * `--push-option` never becomes it. That boundary — not the global pattern — is
 * what keeps `git log origin/main..origin/push-handling` open.
 */
const GIT_PUSH = new RegExp(
  String.raw`(?:^|[;&|]|\s)(?:oo\s+)?git(?:\s+${GIT_GLOBAL})*\s+push(?![-\w])(?:[^;&|\n]*)`,
);

/**
 * The same verb reached through git's ONE positional global, `-C <path>`,
 * which takes its directory as a separate word and so is invisible to the
 * flag-only walk above. Scoped to `-C` with a required value: that is the shape
 * a developer actually issues (`git -C .worktrees/issue-1113 push`), and
 * narrowing it to this one flag is precisely what keeps
 * `git commit -m "." … push` unmatched — a general "flag then any value" walk
 * would need no second pattern at all and would refuse the commit.
 */
const GIT_C_PUSH =
  /(?:^|[;&|]|\s)(?:oo\s+)?git(?:\s+[^;&|\s]+)*\s+-C\s+[^;&|\s]+(?:\s+[^;&|\s]+)*\s+push(?![-\w])(?:[^;&|\n]*)/;

/** A word that is a shell-runner program (basename only, path prefixes allowed). */
const SHELL_RUNNER = /(?:^|\/)(?:ba|z|k|da)?sh$/i;

/** A flag that makes the next quoted run a script BODY rather than a string. */
const COMMAND_FLAG = /^-{1,2}[a-z]*c(?:=.*)?$/i;

/** One shell-operator-separated segment of a command. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of command) {
    if (quote !== undefined) {
      cur += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
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
 * Drop the quotes DELIMITING each balanced quoted run, keeping everything
 * inside — `'git push'` → `git push`. A regex replace (`/(["'])/g`) is wrong
 * here: it deletes the delimiters as it goes, so the two spaces of `git push`
 * collapse into the tokeniser's own split and the verb loses its argument.
 * `unquoteKeepQuotes` in `review-accept-guard.ts` walks the same line for the
 * same reason.
 */
function unquote(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      // An unpaired quote: keep the character and step over it — a scan that
      // cannot advance is a hung guard, and a guard that hangs is worse than
      // one that misses.
      if (end < 0) {
        out += c;
        i += 1;
        continue;
      }
      out += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The quoted bodies a shell will EXECUTE, as bare text. Each segment that runs
 * a shell with a `-c`-style flag contributes its quoted arguments: bash takes
 * the first as the program and the rest as `$0`/`$1`…, and a push can hide in
 * any of them, so every quoted run in such a segment is asked.
 *
 * Exported for the table test: it is the seam that separates "the guard
 * unwraps shells" from "the guard got lucky on a substring", and the test
 * asserts the shell body is caught by THIS path, not the visible one.
 */
export function executedBodies(command: string): string[] {
  const bodies: string[] = [];
  // The quoted runs of the WHOLE command, in order, with their delimiters
  // removed — a quoted argument is ONE shell word, so `"git push"` is a body
  // that must read as two words, not as the fragments `"git` and `push"` a
  // whitespace tokeniser of the raw line would produce.
  const runs = quotedRuns(command);
  // `segments()` splits on `;`/`|`/`&`/newline OUTSIDE quotes only, so an
  // unbalanced quote swallows the rest of the line into one segment — which is
  // the fail-closed direction for the BODY scan: `bash -c 'git push` (unterminated)
  // still yields `git push` as a body, and the matcher refuses it. It is
  // deliberately NOT the direction `stripQuotedSegments` takes for the visible
  // scan, where an unterminated quote returns the raw command so the injection
  // regex sees everything. Two views, each tuned to its own question.
  for (const seg of segments(command)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.some((w) => SHELL_RUNNER.test(unquote(w)))) continue;
    // bash's command flag must follow the shell word (`sh -c …`), not merely
    // appear in the segment — `grep -c 'x' bash` runs grep, not a shell.
    const shellAt = words.findIndex((w) => SHELL_RUNNER.test(unquote(w)));
    const after = words.slice(shellAt + 1);
    if (!after.some((w) => COMMAND_FLAG.test(unquote(w)))) continue;
    for (const body of runs) {
      if (body.trim() !== "") bodies.push(body);
    }
  }
  return bodies;
}

/**
 * Every balanced quoted run of the command, delimiters removed, in order.
 * Quoting is what makes a shell word carry spaces, so this is the only view
 * from which `bash -c "git push"` reads as the program `git push`.
 */
function quotedRuns(command: string): string[] {
  const runs: string[] = [];
  let i = 0;
  while (i < command.length) {
    const open = command[i] as string;
    if (open !== "'" && open !== '"') {
      i += 1;
      continue;
    }
    const close = command.indexOf(open, i + 1);
    // An unpaired quote: everything to end-of-line is what the shell will
    // report as an error, but reading it as a body is the fail-closed choice.
    if (close < 0) {
      runs.push(command.slice(i + 1));
      break;
    }
    runs.push(command.slice(i + 1, close));
    i = close + 1;
  }
  return runs;
}

/**
 * Does this command push a git remote — visibly, or inside a script body a
 * shell will execute?
 *
 * Returns the matched span (for the refusal message) or undefined. The span is
 * the text as the caller wrote it, so the refusal quotes something the agent
 * actually ran.
 */
export function pushesRemote(command: string): string | undefined {
  if (!command) return undefined;
  // 1. The visible forms: chained shapes, `git -C <path> push`, `oo git push`,
  //    force flags and refspecs — the verb is what identifies the act, not its
  //    arguments. Two patterns, one question: `GIT_PUSH` reads globals in their
  //    attached form, `GIT_C_PUSH` the positional `-C <path>` a flag-only walk
  //    must not consume (see their comments for why merging them refuses
  //    commits).
  const visible =
    GIT_PUSH.exec(stripQuotedSegments(command))?.[0]?.trim() ??
    GIT_C_PUSH.exec(stripQuotedSegments(command))?.[0]?.trim();
  if (visible) return visible;
  // 2. The hidden form: a payload handed to a shell. Asked only of bodies the
  //    shell will actually run, so `echo "git push"` and a PR comment naming
  //    the verb stay allowed.
  for (const body of executedBodies(command)) {
    const hit = GIT_PUSH.exec(stripQuotedSegments(body))?.[0]?.trim();
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Whether the command runs `git push` from inside a script body (`bash -c
 * '…'`). Kept as a named export so the table test can assert the SPLIT — that
 * the hidden form is caught by the body path and not by the visible one, which
 * is the difference between a matcher that unwraps shells and one that got
 * lucky on a substring.
 */
export function pushRunsCommand(command: string): string | undefined {
  if (!command) return undefined;
  const bodies = executedBodies(command);
  if (bodies.length === 0) return undefined;
  for (const body of bodies) {
    const hit = GIT_PUSH.exec(stripQuotedSegments(body))?.[0]?.trim();
    if (hit) return hit;
  }
  return undefined;
}
