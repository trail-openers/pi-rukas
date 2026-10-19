/**
 * memory-write-guard — the mode-independent `tool_call` hook that refuses a
 * destructive vipune write inside a spawned child (#1666).
 *
 * `vipune update <id> -t "…"` replaces a row's content in place (see
 * bash-pattern-wildcard.ts for the measurement). The allowlist cannot express
 * "status yes, content no", and the verdict layer is not consulted by trust-mode
 * children, so before this hook a trust-mode /work child could rewrite a memory
 * row that the harness judges it against. The refusal therefore lives in the
 * shared mode-independent block (subagent-guard-guards.ts), which both child
 * entry points register ahead of every trust bypass.
 *
 * This is a guardrail against accidental rewrites, not a security boundary: a
 * determined command can still reach the vipune binary some other way. It reads
 * the command as a shell would for the common shapes — quotes, env prefixes,
 * `env`/`command`/`exec` wrappers, `bash -c` / `eval` bodies, subshells, `$(…)`,
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
const WRAPPERS = new Set(["env", "command", "exec"]);
/** Wrapper options that consume the following word (`env -u NAME`, `exec -a NAME`). */
const WRAPPER_ARG_OPTIONS = new Set(["-u", "-C", "-S", "-a"]);
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

/** Strip `VAR=value` prefixes and `env`/`command`/`exec` wrappers, with their options. */
function unwrap(argv: readonly string[]): string[] {
  let rest = [...argv];
  for (;;) {
    if (rest.length > 0 && ASSIGNMENT.test(rest[0] ?? "")) {
      rest = rest.slice(1);
      continue;
    }
    if (rest.length === 0 || !WRAPPERS.has(path.basename(rest[0] ?? ""))) return rest;
    rest = rest.slice(1);
    while (rest.length > 0 && (rest[0]?.startsWith("-") || ASSIGNMENT.test(rest[0] ?? ""))) {
      rest = rest.slice(WRAPPER_ARG_OPTIONS.has(rest[0] ?? "") ? 2 : 1);
    }
  }
}

function isDestructiveArgv(words: readonly string[], depth: number): boolean {
  const argv = unwrap(words);
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
