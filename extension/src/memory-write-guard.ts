/**
 * memory-write-guard — the mode-independent `tool_call` hook that refuses a
 * destructive vipune write inside a spawned child (#1666).
 *
 * `vipune update <id> -t "…"` replaces a row's content in place, with no lineage and no undo (the
 * id survives, so anything that cited the row now cites different text). The allowlist cannot express
 * "status yes, content no", and the verdict layer is not consulted by trust-mode
 * children, so before this hook a trust-mode /work child could rewrite a memory
 * row that the harness judges it against. The refusal therefore lives in the
 * shared mode-independent block (subagent-guard-guards.ts), which both child
 * entry points register ahead of every trust bypass.
 *
 * This is a guardrail against accidental rewrites, not a security boundary: a
 * determined command can still reach the vipune binary some other way. It reads
 * the command as a shell would for the common shapes — quotes, env prefixes,
 * `env` (incl. `-S`), `command`, `exec`, `nohup`, `sudo`, `timeout`, `xargs` wrappers, `bash -c` / `eval` bodies, subshells, `$(…)`,
 * backticks, and attached values (`-t"x"`, `-tx`, `--text=x`) — and checks every
 * simple command it finds, so a chained or nested `vipune update … -t` is refused
 * the same as a bare one.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

/** How deep `bash -c` / `eval` bodies are followed before the guard gives up. */
const MAX_DEPTH = 4;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Process wrappers the guard sees through. `timeout` also takes one DURATION word. */
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "sudo", "timeout", "xargs"]);
/** Wrapper options that consume the following word, per wrapper (`env -u NAME`, `sudo -u USER`). */
const OPTION_ARGS = new Map<string, ReadonlySet<string>>([
  ["env", new Set(["-u", "-C"])],
  ["exec", new Set(["-a"])],
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-p", "-r", "-t", "-U"])],
  ["timeout", new Set(["-s", "-k"])],
  ["xargs", new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"])],
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
 * closing `)` or backtick restores the quoting the substitution interrupted —
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

/** The command string of a bash tool call; anything that is not a string reads as empty. */
export function bashCommandOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

export function registerMemoryWriteGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    if (!isDestructiveWrite(bashCommandOf(event.input))) return;
    trace("memory-write-guard: BLOCKED destructive vipune update (replaces a memory row's text)");
    return {
      block: true,
      reason:
        "Refused: `vipune update … -t` replaces an existing memory row's text in place, with no lineage and no undo, so anything that cited that memory now cites different text. To correct a memory, store the corrected statement with `vipune add '<statement>' --supersedes <id>`, which keeps the original row.",
    };
  });
}
