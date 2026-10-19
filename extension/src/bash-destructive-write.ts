/**
 * bash-destructive-write — the pure predicate that says whether a bash command
 * rewrites a memory row's text (`vipune update <id> -t "…"`) (#1666).
 *
 * `vipune update` with a text flag replaces a row's content in place, with no
 * lineage and no undo. This module reads a command the way a shell would for the
 * common shapes and answers one question: does any simple command in it reach the
 * vipune binary with a text flag? It has no Pi imports on purpose: the Pi hook
 * that refuses the call lives in memory-write-guard.ts, and the allowlist matcher
 * (bash-command-parser.ts) imports this predicate too, so the one rule has one
 * owner without the matcher pulling in the extension API.
 *
 * Shapes read: quotes, `VAR=value` prefixes, the wrappers in WRAPPERS (with
 * their option arguments), `bash -c` and `eval` bodies, subshells, `$(…)`, and
 * backticks. A guardrail against accidental rewrites, not a security boundary.
 */

import path from "node:path";

/** How deep `bash -c` / `eval` bodies are followed before the predicate gives up. */
const MAX_DEPTH = 4;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * Process wrappers the predicate sees through. `timeout` also takes one DURATION
 * word before the command.
 */
const WRAPPERS = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "sudo",
  "timeout",
  "xargs",
  "nice",
  "stdbuf",
  "time",
  "setsid",
]);
/**
 * Wrapper options that consume the following word, per wrapper (`env -u NAME`,
 * `sudo -u USER`, `nice -n N`, `stdbuf -o MODE`, `time -f FORMAT`).
 */
const OPTION_ARGS = new Map<string, ReadonlySet<string>>([
  ["env", new Set(["-u", "-C"])],
  ["exec", new Set(["-a"])],
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-p", "-r", "-t", "-U"])],
  ["timeout", new Set(["-s", "-k"])],
  ["xargs", new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"])],
  ["nice", new Set(["-n"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["time", new Set(["-f", "-o"])],
]);
/** `env -S STRING`, `-SSTRING`, `--split-string STRING`, `--split-string=STRING`. */
const ENV_SPLIT = /^(?:-S|--split-string=?)(.*)$/;
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
      else if (ch === "\\" && i + 1 < src.length) word += src[++i] ?? "";
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
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
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
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

/** Strip `VAR=value` prefixes and the WRAPPERS, with their options. */
function unwrap(argv: readonly string[]): Unwrapped {
  let rest = [...argv];
  for (;;) {
    if (rest.length > 0 && ASSIGNMENT.test(rest[0] ?? "")) {
      rest = rest.slice(1);
      continue;
    }
    const wrapper = path.basename(rest[0] ?? "");
    if (rest.length === 0 || !WRAPPERS.has(wrapper)) return { argv: rest };
    rest = rest.slice(1);
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
      rest = rest.slice(argOptions.has(opt) ? 2 : 1);
    }
    // `timeout DURATION COMMAND`: one positional word precedes the command.
    if (wrapper === "timeout") rest = rest.slice(1);
  }
}

function isDestructiveArgv(words: readonly string[], depth: number): boolean {
  const { argv, split } = unwrap(words);
  if (split !== undefined) {
    // `env -S` re-splits its payload as a command line; words after it are appended to that line.
    const [payload = "", ...tail] = split;
    return isDestructiveWrite([payload, ...tail.map(quoteWord)].join(" "), depth + 1);
  }
  const head = path.basename(argv[0] ?? "");
  if (head === "eval") return isDestructiveWrite(argv.slice(1).join(" "), depth + 1);
  if (SHELLS.has(head)) {
    const c = argv.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    const body = c >= 0 ? argv[c + 1] : undefined;
    return body !== undefined && isDestructiveWrite(body, depth + 1);
  }
  if (head !== "vipune" || argv[1] !== "update") return false;
  return argv.slice(2).some(isTextFlag);
}

/** True when a simple command in `command` rewrites a memory row's text. */
export function isDestructiveWrite(command: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return command.includes("vipune");
  return simpleCommands(command).some((words) => isDestructiveArgv(words, depth));
}
