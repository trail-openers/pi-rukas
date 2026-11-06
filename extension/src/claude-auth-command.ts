/**
 * claude-auth-command — the pure predicate behind `claude-auth-guard.ts`.
 *
 * One question, no Pi API and no filesystem: does this bash command RUN
 * `claude auth logout` / `claude auth login`? Not: does it contain that text.
 * The distinction is the whole design, and it has two opposing failure modes,
 * one in each direction:
 *
 *   - anchored at word 0 → `git status; claude auth logout` is allowed, since
 *     every agent command is a chain;
 *   - matched as a substring → `grep "claude auth logout" notes.md` and a PR
 *     body explaining the command are refused, which is the cost this harness
 *     has already paid twice (`git-push-command.ts`'s prose rule, the
 *     review-accept guard's substring reading).
 *
 * The shape that gets both: a complete-word scan per shell segment, where the
 * segment's PROGRAM decides whether it runs the binary or merely carries the
 * text. A quoted run is kept as one word, never flattened into argv — that is
 * what makes `grep "claude auth logout" notes.md` carry the verb without
 * running it. The exceptions are the two shapes where quoted text really does
 * run: the script body of a shell-runner (`bash -c '…'`, the same seam
 * `git-push-command.ts` owns) and the body of a `$( … )`.
 *
 * Deliberately NOT reused from that module: `stripQuotedSegments` blanking and
 * `extractCommandPrefix`. Blanking cannot express `bash -c`, and the prefix
 * walk collapses every quoted run to `<arg>` and stops at the first flag, so
 * `timeout 30 claude …`, `sudo claude …` and `env FOO=1 claude …` all resolve
 * to the WRAPPER and a prefix comparison on them never sees the verb at all.
 * The unwrap here is therefore its own small loop.
 */

/** The subcommands that destroy or replace the CLI's credentials. */
const AUTH_VERBS = new Set(["logout", "login"]);

/** The binary whose auth subcommands are refused. */
const CLAUDE = "claude";

/** A quoted or bare run that carries the subcommand group: `auth`. */
const AUTH_WORD = "auth";

/** Leading process wrappers, with the positional argument each one consumes. */
const WRAPPERS: Record<string, number> = {
  env: 0,
  sudo: 0,
  nohup: 0,
  nice: 2,
  timeout: 1,
  stdbuf: 1,
  time: 0,
  command: 1,
};

/** A shell-runner program (basename only; a path prefix is allowed). */
const SHELL_RUNNER = /(?:^|\/)(?:ba|z|k|da)?sh$/i;

/** A flag that makes the next quoted run a script BODY rather than a string. */
const COMMAND_FLAG = /^-{1,2}[a-z]*c(?:=.*)?$/i;

/**
 * One shell-operator-separated segment, splitting outside quotes AND outside
 * `$( … )`: a `;` inside a substitution belongs to the substituted script, not
 * to the outer command, so splitting there would hand back `…) tail` — the tail
 * with its leading command already cut away.
 */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let parenDepth = 0;
  for (const ch of command) {
    if (quote !== undefined) {
      cur += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" && cur.endsWith("$")) parenDepth++;
    if (parenDepth > 0) {
      cur += ch;
      if (ch === ")") parenDepth--;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** A `$( … )` body, quote-aware, from an open paren; empty when unbalanced. */
function substitutionBody(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

/** Every `$( … )` body of a text. */
function substitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") {
      const body = substitutionBody(text, i + 1);
      if (body !== "") out.push(body);
    }
  }
  return out;
}

/** One word of a segment: its text, and whether a quote delimited any of it. */
interface Word {
  text: string;
  quoted: boolean;
}

/**
 * The words of a segment. Each balanced quoted run is kept as ONE word
 * (delimiters removed) rather than flattened, so a quoted argument cannot
 * forge argv: `grep "claude auth logout" notes.md` reads as the program `grep`
 * with the verb sitting in an argument.
 */
function segmentWords(seg: string): Word[] {
  const words: Word[] = [];
  let text = "";
  let quoted = false;
  let quote: string | undefined;
  const flush = () => {
    if (text !== "" || quoted) words.push({ text, quoted });
    text = "";
    quoted = false;
  };
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else {
        // An escape inside double quotes consumes its pair, so `\"` stays part
        // of the word rather than ending it.
        if (quote === '"' && ch === "\\") i++;
        else text += ch;
      }
      quoted = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === "\\" && i + 1 < seg.length) {
      text += seg[i + 1];
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    text += ch;
  }
  flush();
  return words;
}

/** A word as the shell handed it over: no quote contributed any of its text. */
function isBare(word: Word): boolean {
  return !word.quoted;
}

/**
 * The executable of a segment: the first word past `KEY=value` assignments and
 * known wrappers (and the positional each wrapper consumes), as a basename.
 *
 * A word a quote TOUCHED ends the walk rather than naming the program: it is an
 * argument, so the command whose head was quoted (`"claude" auth logout`,
 * `env "claude" auth logout`) is one the guard cannot read, and the harness
 * precedent for that reading is the allowlist's own tokeniser, which blanks a
 * quoted run to `<arg>` and matches nothing. `grep "claude auth logout" f` is
 * inert by the same rule — its head is `grep`, not a quoted word.
 */
function programOf(words: Word[]): string | undefined {
  let i = 0;
  while (i < words.length) {
    const word = words[i] as Word;
    if (!isBare(word)) return undefined;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) {
      i++;
      continue;
    }
    const basename = word.text.slice(word.text.lastIndexOf("/") + 1);
    const consumed = Object.prototype.hasOwnProperty.call(WRAPPERS, basename)
      ? WRAPPERS[basename]
      : undefined;
    if (consumed !== undefined) {
      i += 1 + consumed;
      continue;
    }
    return basename;
  }
  return undefined;
}

/** Whether any word of the segment runs a shell with a `-c`-style flag. */
function runsShell(words: Word[]): boolean {
  const shellAt = words.findIndex((w) => SHELL_RUNNER.test(w.text));
  if (shellAt < 0) return false;
  return words.slice(shellAt + 1).some((w) => COMMAND_FLAG.test(w.text));
}

/** Whether a word is the `auth` group name (quoted or not — argv sees both the same). */
function isAuthWord(word: Word | undefined): boolean {
  return word?.text === AUTH_WORD;
}

/** A bare flag word — one the shell hands over as an option, not a value. */
function isFlag(word: Word | undefined): boolean {
  return word !== undefined && isBare(word) && word.text.startsWith("-");
}

/**
 * Does this word list run `claude auth <login|logout>`?
 *
 * Each word is matched whole, so a word that merely CONTAINS the verb
 * (`--message=claude auth logout`, `auth logout-helper`) is not it. Claude's
 * own global options may sit between the binary and `auth`; a flag is skipped
 * WITH its value (`--config /tmp claude auth logout` is the mutation), so the
 * scan stops at the first word that is neither a flag nor one such pair — which
 * is also what keeps `claude --file auth logout` open: `auth` there is the
 * value of a flag that takes a path, not a group name.
 */
function runsAuthVerb(words: Word[]): boolean {
  if (programOf(words) !== CLAUDE) return false;
  let i = words.findIndex((w) => w.text === CLAUDE || w.text.endsWith(`/${CLAUDE}`));
  if (i < 0) return false;
  i++;
  while (isFlag(words[i])) i += 2;
  if (!isAuthWord(words[i])) return false;
  const verb = words[++i] as Word | undefined;
  return verb !== undefined && AUTH_VERBS.has(verb.text);
}

/**
 * Whether this command runs the CLI's auth login/logout, visibly or inside a
 * script body a shell will execute. Never echoes any part of the command.
 */
export function runsClaudeAuth(command: string): boolean {
  if (!command) return false;
  const queue: string[] = [command];
  while (queue.length > 0) {
    const text = queue.shift() as string;
    for (const seg of segments(text)) {
      const words = segmentWords(seg);
      if (runsAuthVerb(words)) return true;
      // A quoted body re-enters the queue only where a SHELL will execute it:
      // the argument of a shell-runner (`bash -c '…'`). Any other quoted run is
      // an argument, and an argument that spells the verb is prose
      // (`grep "claude auth logout" notes.md`) — whatever program carries it.
      // `$( … )` bodies are the exception asked separately: the shell runs them
      // from any position, including inside a carrier's argument.
      const rerun: string[] = [];
      if (runsShell(words)) rerun.push(...words.filter((w) => w.quoted).map((w) => w.text));
      // The substitution bodies of this segment, unless the shell-runner branch
      // already handed that quoted run over as a script body.
      rerun.push(...substitutions(seg));
      queue.push(...rerun);
    }
  }
  return false;
}
