/**
 * write-fence-bash-split — the statement splitter for the bash side of the write
 * fence (#1655).
 *
 * Splits the lexer's token stream into simple commands (a command word and its
 * arguments, with its redirect targets), and strips what sits in front of the
 * command word: shell keywords, assignments, and the wrappers (`env`, `timeout`,
 * `xargs`, …) that run their operand as the command. Also the argument helpers
 * the per-command meanings share.
 */

import type { Tok, Word } from "./write-fence-bash-lex.ts";

/** A simple command: its words (assignments and wrappers not yet stripped) and its redirect targets. */
export interface Simple {
  words: Word[];
  redirects: Word[];
}

/** Shell keywords that precede a simple command without being the command. */
const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "{",
  "}",
  "!",
  "time",
]);

/** Commands that run their operand as the command. Their own options are skipped to reach it. */
const WRAPPERS = new Set([
  "env",
  "nohup",
  "exec",
  "command",
  "builtin",
  "nice",
  "ionice",
  "timeout",
  "xargs",
  "stdbuf",
  // #2200 — a remover behind a privilege or scheduling wrapper is still that remover:
  // `sudo rm -rf <worktree>/src` must be judged (and so refused or allowed) as an `rm`,
  // the way the sibling scanner `bash-destructive-write.ts` already reads them.
  "sudo",
  "doas",
  "setsid",
  "watch",
  "gtimeout",
  "caffeinate",
]);

/** Options of each wrapper that take a separate value (`nice -n 5`, `timeout -s KILL`). */
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  env: ["-u", "--unset", "-S", "--split-string"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  gtimeout: ["-s", "-k", "--signal", "--kill-after"],
  sudo: ["-u", "-g", "-C", "-D", "-p", "-r", "-t", "-U", "--user", "--group", "--chdir"],
  doas: ["-u", "-C"],
  caffeinate: ["-t", "-w"],
  watch: ["-n", "--interval"],
  xargs: [
    "-I",
    "-n",
    "-P",
    "-L",
    "-d",
    "-E",
    "-s",
    "-a",
    "--max-args",
    "--max-procs",
    "--max-lines",
    "--delimiter",
    "--arg-file",
  ],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/** A simple command with its keywords, assignments and wrappers removed, and any `env -C` directories. */
export interface Prefixed {
  words: Word[];
  chdir: Word[];
}

/** The basename of a command word (`/bin/cp` is `cp`). */
export function commandName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The removal commands whose operands are the paths they delete. */
const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred"]);

/** The removal commands the deletion rule (#2200) reads the operands of. */
export function isRemover(name: string): boolean {
  return REMOVERS.has(name);
}

/**
 * The `xargs` options that choose the replacement placeholder, and its default.
 * `-I`/`-i` take the placeholder as their value (`-I{}` and `-I {}` are the same
 * command, as are the GNU `-I` and the BSD `-i` spellings); with neither, xargs
 * substitutes the two-character brace pair.
 */
export const XARGS_REPLACE_OPTIONS = ["-I", "-i"] as const;

/** The placeholder `xargs` substitutes when the command gave it no `-I`/`-i` value. */
export const XARGS_DEFAULT_PLACEHOLDER = "{}";

/**
 * The replacement placeholder of one `xargs …` argument list, read from the words as the
 * child typed them (the wrapper still in front): the value of its `-I`/`-i` in either
 * spelling (`-I{}`, `-I {}`, `-i%`), or xargs' own default `{}` when it named neither.
 * `stripPrefix` consumes a spaced value but leaves an attached one, so both spellings
 * have to be read here rather than from the stripped operands.
 */
export function xargsPlaceholder(args: Word[]): string {
  return xargsPlaceholders(args)[0] ?? XARGS_DEFAULT_PLACEHOLDER;
}

/**
 * Every placeholder this line substitutes: `[]` when no `xargs` replacement option names
 * one (so no word can be mistaken for a substitution), and otherwise each placeholder the
 * line spelled, with xargs' own default `{}` always included — bash and xargs both leave a
 * bare `{}` meaning the replacement when the option carried no value of its own.
 */
export function xargsPlaceholders(args: Word[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined) continue;
    if (isReplaceOption(a)) {
      out.push(args[k + 1]?.text ?? XARGS_DEFAULT_PLACEHOLDER);
      k++;
      continue;
    }
    const attached = attachedPlaceholder(a);
    if (attached !== undefined) out.push(attached);
  }
  return out.length === 0 ? [] : [...new Set([...out, XARGS_DEFAULT_PLACEHOLDER])];
}

/** `-I`/`-i`: the option that takes the replacement placeholder as its NEXT word. */
export function isReplaceOption(a: Word): boolean {
  return XARGS_REPLACE_OPTIONS.includes(a.text as (typeof XARGS_REPLACE_OPTIONS)[number]);
}

/** `-I{}`/`-i%`: the placeholder attached to its option, or undefined for any other word. */
export function attachedPlaceholder(a: Word): string | undefined {
  if (a.text.length <= 2) return undefined;
  const option = a.text.slice(0, 2) as (typeof XARGS_REPLACE_OPTIONS)[number];
  return XARGS_REPLACE_OPTIONS.includes(option) ? a.text.slice(2) : undefined;
}

/** Whether one word is xargs' replacement placeholder rather than a path it names. */
export function isXargsPlaceholder(text: string, placeholder: string): boolean {
  return text === placeholder || text === XARGS_DEFAULT_PLACEHOLDER;
}

/**
 * The non-option operands of a removal command; `--` ends the options. The deletion
 * rule reads these for `unlink` and `shred`, which the writers table has no entry
 * for, and to tell a remover that named its paths from one whose targets arrive on
 * standard input (`xargs … rm -rf`, whose wrapper the splitter has already stripped).
 */
export function removalOperands(args: Word[]): Word[] {
  return operands(args);
}

/** Non-option operands. `--` ends the options, and `-` alone is stdin/stdout. */
export function operands(args: Word[]): Word[] {
  return operandsWith(args, []);
}

/**
 * Non-option operands, where the options named in `valued` take the following word
 * as their value (`truncate -s 0 file`: `0` is not an operand).
 */
export function operandsWith(args: Word[], valued: readonly string[]): Word[] {
  const out: Word[] = [];
  let optionsOver = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined) continue;
    if (!optionsOver && a.text === "--") {
      optionsOver = true;
      continue;
    }
    if (!optionsOver && a.text.startsWith("-") && a.text !== "-") {
      if (valued.includes(a.text)) k++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** The value of each named option, from `-x VALUE` or `--name=VALUE`. */
export function optionValues(args: Word[], names: readonly string[]): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined) continue;
    if (names.includes(a.text)) {
      const value = args[k + 1];
      if (value !== undefined) out.push(value);
      k++;
      continue;
    }
    const eq = names.find((n) => n.startsWith("--") && a.text.startsWith(`${n}=`));
    if (eq !== undefined) {
      out.push({ text: a.text.slice(eq.length + 1), dyn: a.dyn });
      continue;
    }
    // A two-character short option takes its value attached: `-o/abs/x`, `-C/abs`.
    const short = names.find(
      (n) =>
        n.length === 2 && n[0] === "-" && n[1] !== "-" && a.text.length > 2 && a.text.startsWith(n),
    );
    if (short !== undefined) out.push({ text: a.text.slice(2), dyn: a.dyn });
  }
  return out;
}

/** Skip the options (and any value or duration) a wrapper takes before the command it runs. */
function wrapperArgCount(name: string, args: Word[], chdir: Word[]): number {
  const valued = VALUE_OPTIONS[name] ?? [];
  let k = 0;
  while (k < args.length) {
    const a = args[k]?.text ?? "";
    if (name === "env" && ASSIGNMENT.test(a)) {
      k++;
      continue;
    }
    if (a === "--") {
      k++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    if (name === "env" && (a === "-C" || a === "--chdir")) {
      const dir = args[k + 1];
      if (dir) chdir.push(dir);
      k += 2;
      continue;
    }
    if (name === "env" && a.startsWith("--chdir=")) {
      chdir.push({ text: a.slice("--chdir=".length), dyn: args[k]?.dyn ?? false });
      k++;
      continue;
    }
    k += valued.includes(a) ? 2 : 1;
  }
  if (name === "timeout" || name === "gtimeout") {
    if (DURATION.test(args[k]?.text ?? "")) k++;
  }
  return k;
}

/** Strip keywords, assignments and wrapper commands from the front of a simple command. */
export function stripPrefix(words: Word[]): Prefixed {
  const chdir: Word[] = [];
  let w = words;
  for (;;) {
    const head = w[0]?.text;
    if (head === undefined) break;
    if (ASSIGNMENT.test(head) || KEYWORDS.has(head)) {
      w = w.slice(1);
      continue;
    }
    const name = commandName(head);
    if (!WRAPPERS.has(name)) break;
    w = w.slice(1 + wrapperArgCount(name, w.slice(1), chdir));
  }
  return { words: w, chdir };
}

/** One step of a command line: a simple command, or the separator (`&&`, `|`, `(`, `)`, …) after one. */
export type Step = { kind: "command"; simple: Simple } | { kind: "sep"; text: string };

/** Split the token stream at separators, collecting each command's redirect targets. */
export function simpleCommands(toks: Tok[]): Step[] {
  const out: Step[] = [];
  let cur: Simple = { words: [], redirects: [] };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (!t) continue;
    if (t.kind === "word") {
      cur.words.push(t.word);
      continue;
    }
    if (t.text === ">" || t.text === "<" || t.text === "dup") {
      // A redirect consumes the next word: its target for `>`, a discarded operand otherwise.
      const nx = toks[k + 1];
      if (nx?.kind === "word") {
        k++;
        if (t.text === ">") cur.redirects.push(nx.word);
      }
      continue;
    }
    if (t.text === "<<") continue;
    out.push({ kind: "command", simple: cur }, { kind: "sep", text: t.text });
    cur = { words: [], redirects: [] };
  }
  out.push({ kind: "command", simple: cur });
  return out;
}
