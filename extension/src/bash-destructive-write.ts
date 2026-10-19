/**
 * bash-destructive-write — the pure predicate that says whether a bash command
 * touches memory in a way the guard refuses: `vipune update <id> -t "…"` rewrites a
 * row's content, `vipune delete` and `vipune prune` remove or demote rows (#1666).
 *
 * The verb decision is fail-closed. Every `vipune` word in a simple command is read
 * as an invocation: after the global options, the first remaining word must be a
 * literal known subcommand, or the verdict is `unresolved`. Globs, braces,
 * expansions and unknown words are therefore refused rather than guessed at. Off the
 * command position only a literal `delete` / `prune` / `update -t` directly after the
 * word refuses (see vipuneVerdict). This
 * module has no Pi imports on purpose: the Pi hook that refuses the call lives in
 * memory-write-guard.ts, and the allowlist matcher (bash-command-parser.ts) imports
 * the boolean wrapper, so the one rule has one owner.
 *
 * Shapes read: quotes, `VAR=value` prefixes, the wrappers in WRAPPERS (with their
 * option arguments), `bash -c` and `eval` bodies, `find -exec`, subshells, `$(…)`,
 * and backticks. A guardrail against accidental rewrites, not a security boundary.
 */

import path from "node:path";

/** How deep `bash -c` / `eval` bodies are followed before the predicate gives up. */
const MAX_DEPTH = 4;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `find` actions that run their argument words as a command, up to a `;` or `+`. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** A redirection word, with or without its target: `2>/dev/null`, `>out`, `2>&1`, `&>out`. */
const REDIRECT = /^(?:\d*[<>]|&>)/;
/** A redirection operator whose target is the next word: `>`, `2>`, `>>`, `>&`, `&>`, `&>>`. */
const REDIRECT_OPERATOR_ONLY = /^(?:\d*[<>][>&|]?|&>>?)$/;
/**
 * Process wrappers the predicate sees through. `timeout` also takes one DURATION
 * word before the command.
 */
const WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "sudo",
  "doas",
  "timeout",
  "gtimeout",
  "caffeinate",
  "ionice",
  "xargs",
  "nice",
  "stdbuf",
  "time",
  "setsid",
  "watch",
]);
/** Shell reserved words that prefix a simple command (`do vipune …`, `{ vipune …; }`, `! vipune …`). */
const SHELL_KEYWORDS = new Set([
  "!",
  "{",
  "}",
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
]);
/**
 * Wrapper options that consume the following word, per wrapper (`env -u NAME`,
 * `sudo -u USER`, `nice -n N`, `stdbuf -o MODE`, `time -f FORMAT`).
 */
const OPTION_ARGS = new Map<string, ReadonlySet<string>>([
  ["env", new Set(["-u", "-C"])],
  ["exec", new Set(["-a"])],
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-p", "-r", "-t", "-U"])],
  ["doas", new Set(["-u", "-C"])],
  ["timeout", new Set(["-s", "-k"])],
  ["gtimeout", new Set(["-s", "-k"])],
  ["caffeinate", new Set(["-t", "-w"])],
  ["ionice", new Set(["-c", "-n", "-p", "-P", "-u"])],
  ["xargs", new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"])],
  ["nice", new Set(["-n"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["watch", new Set(["-n"])],
  ["time", new Set(["-f", "-o"])],
]);
/** `env -S STRING`, `-SSTRING`, `--split-string STRING`, `--split-string=STRING`. */
const ENV_SPLIT = /^(?:-S|--split-string=?)(.*)$/;
/**
 * True when the `&` at `src[i]` belongs to a redirection (`2>&1`, `>&2`, `<&0`,
 * `&>out`, `&>>out`) rather than separating commands. An escaped `\>` is a literal
 * character, so the `&` after it still separates.
 */
function isRedirectAmp(src: string, i: number): boolean {
  if (src[i + 1] === ">") return true;
  if (src[i - 1] !== ">" && src[i - 1] !== "<") return false;
  let backslashes = 0;
  for (let j = i - 2; j >= 0 && src[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 0;
}

/** Shell-quote one word, so it re-tokenises as the same word. */
const quoteWord = (w: string): string => `'${w.replace(/'/g, "'\\''")}'`;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Split a command into simple commands, each a list of unquoted words. Quotes
 * are honoured; `;`, `|`, `&`, `(`, `)` and newline end a simple command.
 * `$(…)` and backticks are command substitutions: each opens a new command,
 * quoting restarts inside it (a `"` before it does not carry in), and the
 * closing `)` or backtick restores the quoting the substitution interrupted,
 * inside double quotes too, because a substitution there still runs.
 */
export function simpleCommands(src: string): string[][] {
  const cmds: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  // Open substitutions: the quoting to restore and the character that closes it.
  const subst: Array<{ restore: '"' | null; closer: ")" | "`" }> = [];
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCmd = (): void => {
    endWord();
    if (words.length > 0) cmds.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? "";
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    const top = subst[subst.length - 1];
    if (ch === "`" && top?.closer === "`") {
      endCmd();
      quote = subst.pop()?.restore ?? null;
      continue;
    }
    if ((ch === "$" && src[i + 1] === "(") || ch === "`") {
      subst.push({
        restore: quote === '"' ? '"' : null,
        closer: ch === "`" ? "`" : ")",
      });
      endCmd();
      quote = null;
      if (ch === "$") i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && src[i + 1] === "\n") i++;
      else if (ch === "\\" && i + 1 < src.length) word += src[++i] ?? "";
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    // A backslash-newline is a line continuation: the shell removes both characters.
    if (ch === "\\" && src[i + 1] === "\n") {
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) {
      word += src[++i] ?? "";
      inWord = true;
      continue;
    }
    if (ch === ")" && top?.closer === ")") {
      endCmd();
      quote = subst.pop()?.restore ?? null;
      continue;
    }
    const separatorAmp = ch === "&" && !isRedirectAmp(src, i);
    if (ch === "\n" || ch === ";" || ch === "|" || separatorAmp || ch === "(" || ch === ")") {
      endCmd();
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endCmd();
  return cmds;
}

/** A word that sets the vipune text: `-t`, `-tVALUE`, `--text`, `--text=VALUE`. */
function isTextFlag(w: string): boolean {
  if (w === "--text" || w.startsWith("--text=")) return true;
  return w.startsWith("-t") && !w.startsWith("--");
}

/** What `unwrap` found: the command's words, or (for `env -S`) the payload and the words after it. */
interface Unwrapped {
  argv: string[];
  split?: string[];
}

/** Drop leading redirections (and their targets), which may sit before the command name. */
function skipRedirects(words: string[]): string[] {
  let rest = words;
  while (rest.length > 0 && REDIRECT.test(rest[0] ?? "")) {
    rest = rest.slice(REDIRECT_OPERATOR_ONLY.test(rest[0] ?? "") ? 2 : 1);
  }
  return rest;
}

/** Strip `VAR=value` prefixes and the WRAPPERS, with their options. */
function unwrap(argv: readonly string[]): Unwrapped {
  let rest = [...argv];
  for (;;) {
    rest = skipRedirects(rest);
    if (rest.length > 0 && (ASSIGNMENT.test(rest[0] ?? "") || SHELL_KEYWORDS.has(rest[0] ?? ""))) {
      rest = rest.slice(1);
      continue;
    }
    const wrapper = path.basename(rest[0] ?? "");
    if (rest.length === 0 || !WRAPPERS.has(wrapper)) return { argv: rest };
    rest = skipRedirects(rest.slice(1));
    const argOptions = OPTION_ARGS.get(wrapper) ?? new Set<string>();
    while (rest.length > 0 && (rest[0]?.startsWith("-") || ASSIGNMENT.test(rest[0] ?? ""))) {
      const opt = rest[0] ?? "";
      const split = wrapper === "env" ? ENV_SPLIT.exec(opt) : null;
      if (split) {
        // `-S STRING` takes the next word; `-SSTRING` carries its value inline.
        const inline = split[1] ?? "";
        const takesNext = inline === "";
        const value = takesNext ? (rest[1] ?? "") : inline;
        return { argv: [], split: [value, ...rest.slice(takesNext ? 2 : 1)] };
      }
      rest = skipRedirects(rest.slice(argOptions.has(opt) ? 2 : 1));
    }
    // `timeout DURATION COMMAND`: one positional word precedes the command.
    if (wrapper === "timeout" || wrapper === "gtimeout") rest = skipRedirects(rest).slice(1);
  }
}

/**
 * The verdict on one vipune invocation. `verb` is a destructive subcommand the
 * guard refuses; `unresolved` is a verb word that is not a literal known subcommand
 * (a glob, brace, expansion, or unknown word). No verdict means the call is allowed.
 */
export type MemoryWriteVerdict =
  | { kind: "verb"; verb: "delete" | "prune" | "update -t" }
  | { kind: "unresolved" };

/** vipune global options that take a separate value word (`-p x`, `--db-path /tmp/x`). */
const VIPUNE_VALUE_OPTIONS = new Set(["-p", "--project", "--db-path"]);

/**
 * Every vipune subcommand (`vipune --help`, vipune 0.15.0). The verb must be one of
 * these literal words. A glob (`d?lete`, `del*`), a brace list, an expansion, or an
 * unknown word is not a literal member, so it is refused as unresolved.
 */
const KNOWN_VERBS = new Set([
  "validate",
  "add",
  "search",
  "get",
  "list",
  "delete",
  "update",
  "doctor",
  "import",
  "reindex",
  "export",
  "promote",
  "prune",
  "backup",
  "project",
  "hook",
  "version",
  "mcp",
  "help",
]);

/**
 * The destructive verb, if any, at `argv[i]`: `delete`, `prune`, or `update` carrying a
 * text flag. Anything else, including a glob or brace word, is not destructive here.
 */
function refusedVerb(argv: readonly string[], i: number): MemoryWriteVerdict | undefined {
  const verb = argv[i] ?? "";
  if (verb === "delete" || verb === "prune") return { kind: "verb", verb };
  if (verb === "update" && argv.slice(i + 1).some(isTextFlag)) {
    return { kind: "verb", verb: "update -t" };
  }
  return undefined;
}

/**
 * The verdict for the vipune invocation whose binary word sits at `argv[k]`.
 *
 * Position decides how strict the read is. When vipune IS the command (`k === 0`),
 * it skips `--`, dash-options and the value of the global value options; the first
 * remaining word is the verb, which must be a literal known subcommand, so anything
 * else is unresolved. No verb word (a bare `vipune`, `vipune --help`) is allowed.
 *
 * Off the command position (`grep vipune -e delete .`, `busybox vipune delete 1`) only
 * the word immediately after vipune is read, with no option skipping, and only a
 * literal destructive verb refuses. Any other word there is a search term or a path,
 * not an invocation, so it is allowed; that is why `unbuffer vipune {delete,x} 1`
 * passes (the brace list is not read at that position).
 */
function vipuneVerdict(argv: readonly string[], k: number): MemoryWriteVerdict | undefined {
  if (k > 0) return refusedVerb(argv, k + 1);
  let i = k + 1;
  while (i < argv.length) {
    const w = argv[i] ?? "";
    if (w === "--") {
      i++;
      break;
    }
    if (!w.startsWith("-")) break;
    i += VIPUNE_VALUE_OPTIONS.has(w) ? 2 : 1;
  }
  if (i >= argv.length) return undefined;
  const refused = refusedVerb(argv, i);
  if (refused !== undefined) return refused;
  return KNOWN_VERBS.has(argv[i] ?? "") ? undefined : { kind: "unresolved" };
}

/** The verdict for a `bash -c`, `eval`, `script -c` or `find -exec` body, if the command has one. */
function nestedVerdict(
  argv: readonly string[],
  head: string,
  depth: number,
): MemoryWriteVerdict | undefined {
  if (head === "eval") return memoryWriteVerdictOf(argv.slice(1).join(" "), depth + 1);
  if (SHELLS.has(head) || head === "script") {
    const c = argv.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    const body = c >= 0 ? argv[c + 1] : undefined;
    return body === undefined ? undefined : memoryWriteVerdictOf(body, depth + 1);
  }
  if (head === "find") {
    // `find … -exec CMD … ;` runs CMD once per match, so CMD is judged like any other command.
    for (let i = 0; i < argv.length; i++) {
      if (!FIND_EXEC.has(argv[i] ?? "")) continue;
      const verdict = destructiveArgv(execBody(argv, i + 1), depth + 1);
      if (verdict !== undefined) return verdict;
    }
  }
  return undefined;
}

/**
 * The verdict for one simple command. Nested bodies are judged first; then every
 * word whose basename is `vipune` is read as an invocation, wherever it sits (after
 * a wrapper the list does not name, after `xargs`, as an argument). Only the
 * command word is read strictly; off that position only the next word is read
 * (see vipuneVerdict).
 */
function destructiveArgv(words: readonly string[], depth: number): MemoryWriteVerdict | undefined {
  const { argv, split } = unwrap(words);
  if (split !== undefined) {
    // `env -S` re-splits its payload as a command line; words after it are appended to that line.
    const [payload = "", ...tail] = split;
    return memoryWriteVerdictOf([payload, ...tail.map(quoteWord)].join(" "), depth + 1);
  }
  // A single word holding a whole command (`watch 'vipune delete 1'`) is re-parsed as one.
  if (argv.length === 1 && /\s/.test(argv[0] ?? ""))
    return memoryWriteVerdictOf(argv[0] ?? "", depth + 1);
  const nested = nestedVerdict(argv, path.basename(argv[0] ?? ""), depth);
  if (nested !== undefined) return nested;
  for (let k = 0; k < argv.length; k++) {
    if (path.basename(argv[k] ?? "") !== "vipune") continue;
    const verdict = vipuneVerdict(argv, k);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
}

/** The words of a `find -exec` action starting at `start`, up to its `;` or `+` terminator. */
function execBody(argv: readonly string[], start: number): string[] {
  const end = argv.findIndex((w, i) => i >= start && (w === ";" || w === "+"));
  return argv.slice(start, end < 0 ? undefined : end);
}

/**
 * The verdict for a bash command: the first simple command that runs a refused vipune
 * verb or a vipune verb the guard cannot read, or undefined when every vipune
 * invocation is allowed.
 */
export function memoryWriteVerdictOf(command: string, depth = 0): MemoryWriteVerdict | undefined {
  if (depth > MAX_DEPTH) return command.includes("vipune") ? { kind: "unresolved" } : undefined;
  for (const words of simpleCommands(command)) {
    const verdict = destructiveArgv(words, depth);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
}

/**
 * True when the command must be refused as a memory write (see memoryWriteVerdictOf).
 * The allowlist matcher uses this boolean; the guard uses the verdict for its trace label.
 */
export function isDestructiveWrite(command: string, depth = 0): boolean {
  return memoryWriteVerdictOf(command, depth) !== undefined;
}
