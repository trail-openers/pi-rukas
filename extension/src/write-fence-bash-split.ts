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
]);

/** Options of each wrapper that take a separate value (`nice -n 5`, `timeout -s KILL`). */
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  env: ["-u", "--unset", "-S", "--split-string"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
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
  if (name === "timeout" && DURATION.test(args[k]?.text ?? "")) k++;
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
