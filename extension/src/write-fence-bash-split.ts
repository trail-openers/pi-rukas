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
  // #2200 — a remover behind a namespace, tracing or sandboxing wrapper is still that
  // remover: `busybox rm -rf <shared>` runs busybox's own `rm` and `strace -f rm -rf
  // <shared>` runs `rm` under the tracer, so neither spelling escapes the judgement.
  "busybox",
  "strace",
  "ltrace",
  "unshare",
  "chroot",
  "nsenter",
  "firejail",
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
  strace: ["-o", "-P", "-e", "-s"],
  ltrace: ["-o", "-e", "-n", "-x"],
  unshare: ["-m", "-u", "-i", "-p", "-n", "-U", "--map-users", "--map-groups"],
  chroot: ["--userspec", "--groups", "--chdir"],
  nsenter: ["-t", "-p", "-m", "-u", "-i", "-n", "-U", "-G", "--target", "--root"],
  firejail: ["--name", "--root", "--home", "--net", "--dns", "--include", "--profile", "--user"],
};

/** Assignments of the form `NAME=VALUE`, which `env` and a command prefix accept. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The wrapper that takes the new root as a POSITIONAL argument before the program it runs:
 * `chroot NEWROOT PROG`. One positional only — consuming the command itself would leave a
 * remover the reader never saw.
 */
const POSITIONAL_ROOT_WRAPPERS = ["chroot"] as const;
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
 * The `xargs` options that choose the replacement placeholder, and its default. `-I` (the
 * GNU spelling) always takes the placeholder as its value; `-i` (the BSD spelling) takes it
 * OPTIONALLY, so the word after a bare `-i` is the command when it is an option (`-i rm -rf
 * {}`, where xargs substitutes its own `{}`) and the placeholder when it is not (`-i % rm
 * %`). With neither, xargs substitutes the two-character brace pair.
 */
export const XARGS_REPLACE_OPTIONS = ["-I", "-i"] as const;

/** The placeholder `xargs` substitutes when the command gave it no `-I`/`-i` value. */
export const XARGS_DEFAULT_PLACEHOLDER = "{}";

/** A token xargs could substitute: `{}`, or one made of substitution characters (`%`, `%%`, `-#`). */
const OPTION_SHAPED = /^(?:\{\}|[-%+^@#~]+)/;

/** A path, not a substitution token: a `/` anywhere, or a leading `~`, `./` or `../`. */
const PATH_SHAPED = /^(?:\.{0,2}[~/]|[\w.~+-]*\/)/;

/**
 * Whether the word after `xargs`' `-I`/`-i` is that option's replacement string rather than
 * the command it runs. A command name never reads as a substitution token and neither does a
 * path, so a word of either shape is the command and its operand stays judged.
 */
function isReplaceValue(text: string | undefined): boolean {
  return text === undefined || text.startsWith("-") || OPTION_SHAPED.test(text);
}

/** A bare `{}` — the token xargs substitutes when `-I`/`-i` took no value of its own. */
function isBracePlaceholder(text: string): boolean {
  return text === "{}";
}

/** Whether one word is this xargs' replacement placeholder rather than a path it names. */
export function isXargsPlaceholder(text: string, placeholder: string): boolean {
  if (text === XARGS_DEFAULT_PLACEHOLDER) return true;
  return text === placeholder && OPTION_SHAPED.test(text);
}

/**
 * Every placeholder this `xargs …` argument list substitutes, read from the words as the
 * child typed them (the wrapper still in front): `[]` when nothing on the line is a
 * substitution (so no word may be mistaken for one), otherwise every placeholder the line
 * spelled — the value attached to `-I`/`-i` (`-I{}`, `-i%`), and the spaced value (`-I {}`,
 * `-i %`) only when it is option-shaped — with xargs' own default `{}` included whenever
 * the line substitutes at all, because a bare `{}` left by the wrapper is what xargs itself
 * replaces in that case. A bare `-i` (the BSD short form, whose value is optional) and a
 * `-I` that took no value both mean the default. A spaced value that reads as a path is a
 * path the child typed and not a token, so it is absent from this set and stays judged.
 */
export function xargsPlaceholders(args: Word[]): string[] {
  const out: string[] = [];
  let substitutes = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined) continue;
    if (isReplaceOption(a)) {
      substitutes = true;
      const value = args[k + 1]?.text;
      // A `-I`/`-i` whose next word is another option (or nothing) took no value, so xargs
      // substitutes its own `{}`. A value that reads as a PATH — it contains a `/` or starts
      // with `~`/`.` — is the child's own string: xargs substitutes exactly it, so it stays out
      // of this set and its operand is judged as the path it is. That is how `xargs -I <shared>
      // rm -rf <shared>`, an `xargs -I ./out rm -rf ./<run>`, and an `xargs -I ~ rm -rf ~` are
      // refused on the path they name. The one non-path value the option really takes (`%`,
      // `%%`, `-#`) is a token, not a path, and joins the set; so does the bare brace spelling
      // xargs uses when it took no value at all, which `find` cannot name.
      if (value === undefined || OPTION_SHAPED.test(value)) out.push(XARGS_DEFAULT_PLACEHOLDER);
      else if (!PATH_SHAPED.test(value)) out.push(value);
      k++;
      continue;
    }
    const attached = attachedPlaceholder(a);
    if (attached !== undefined) {
      substitutes = true;
      out.push(attached);
      continue;
    }
    if (isXargsPlaceholder(a.text, XARGS_DEFAULT_PLACEHOLDER)) substitutes = true;
  }
  if (!substitutes) return [];
  return [...new Set([...out, XARGS_DEFAULT_PLACEHOLDER])];
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

/**
 * Drop the words that are this line's xargs placeholders — each stands for one matched
 * name, so it names no path. `[]` from `xargsPlaceholders` leaves the words untouched,
 * which is what keeps a `find … -exec rm {} +` judged on its start paths rather than on a
 * brace, and a `rm` that named only `{}` left to the unnamed-target refusal.
 *
 * The words are dropped only on the shape that makes them a substitution rather than the
 * path the child typed (`isPlaceholderWord`), because a spaced `-I`/`-i` VALUE survives the
 * wrapper with the same text as the token: `xargs -I <shared> rm -rf <shared>` hands `rm`
 * that path on every run, and dropping the operand dropped the only word naming the victim.
 */
export function withoutPlaceholder(words: Word[], args: Word[]): Word[] {
  const placeholders = new Set(xargsPlaceholders(args));
  return words.filter((w) => !isPlaceholderWord(w.text, placeholders));
}

/**
 * Whether one word is a substitution token rather than a path: one of this line's
 * placeholders, and not a path the child could have typed. xargs' own `{}` is always a
 * token; a spaced `-I`/`-i` value is one only when it is option-shaped (`%`, `%%`, `-#`), so
 * the same text appearing as an operand to the right of the command is judged as a path.
 */
function isPlaceholderWord(text: string, placeholders: ReadonlySet<string>): boolean {
  return placeholders.has(text) && (text === XARGS_DEFAULT_PLACEHOLDER || OPTION_SHAPED.test(text));
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

/**
 * Skip the options (and any value or duration) a wrapper takes before the command it runs.
 *
 * `xargs` is the one wrapper whose value is optional: after `-i` the word is the command when
 * it is an option (`-i rm -rf {}`) and the replacement string when it is not (`-i % rm %`),
 * so the value is consumed only in the second case. `-I` always takes its value. Getting this
 * wrong leaves the command behind as the first word of the stripped result, which is how an
 * `xargs …` line stopped being read as the remover it runs.
 */
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
    if (a === "-") break;
    if (!a.startsWith("-")) {
      // A wrapper that takes the new root as a POSITIONAL argument has exactly one here,
      // before the command it runs (`chroot NEWROOT rm …`); a wrapper that takes none stops
      // at its command. Consuming more than one would swallow the command itself, and a
      // remover whose wrapper's name is the only thing the reader saw is a remover the rule
      // never judged.
      if (POSITIONAL_ROOT_WRAPPERS.includes(name as "chroot")) {
        k++;
      }
      break;
    }
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
    if (name === "xargs" && XARGS_REPLACE_OPTIONS.includes(a as "-I" | "-i")) {
      // `xargs` is the one wrapper whose value is OPTIONAL, and its value can be any string,
      // so the word after a bare `-i`/`-I` is the command when it is an option (`-i rm -rf {}`,
      // xargs substituting its own `{}`) and the replacement string when it is not (`-I % rm
      // %`). Consuming a word that was really the command leaves the remover behind as the
      // first word of the result, which is how an `xargs …` line stopped being read as the
      // remover it runs — so the value is consumed only when it reads as a token, and the walk
      // STOPS at the command rather than reading on through its operands (`xargs -I <shared>
      // rm -rf <shared>` would otherwise treat its own `-rf` and target as more options).
      const value = args[k + 1]?.text;
      if (isReplaceValue(value)) {
        k += 2;
        continue;
      }
      const command = args[k + 2];
      if (command === undefined || isRemover(commandName(command.text))) return k + 2;
      k++;
      continue;
    }
    if (!a.startsWith("-") || a === "-") break;
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
    const n = 1 + wrapperArgCount(name, w.slice(1), chdir);
    w = w.slice(n);
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
