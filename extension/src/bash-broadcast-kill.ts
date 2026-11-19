/**
 * bash-broadcast-kill — the pure predicate that says whether a bash command signals
 * every process of the uid, or a process group the guard cannot read (#2381).
 *
 * The field shape, three times in two days: a review child probing a target project's
 * process-group kill fed it `1` as a stand-in pid. `killpg(1, sig)` is `kill(-1, sig)`
 * on Linux — the signal to every process the uid may signal, not to init's group — and
 * each probe terminated the operator's terminal server, the user manager, every sibling
 * agent on the host and the driver that dispatched the child. Pid 1 and pid -1 are the
 * two values a probe reaches for when it wants "a pid that is not mine", and both are
 * the whole uid.
 *
 * Three readings, in order:
 *   - a `kill` word whose TARGET (after the signal option) is `-1` — any signal
 *     spelling, with or without `--`, behind any wrapper the sibling scanner strips,
 *     inside a `bash -c` / `eval` / `env -S` body or a `find -exec` action — is `all`;
 *     a target that is negative but not a literal number (`-$PGID`) is `unresolved`,
 *     refused for the same reason the memory guard refuses a verb it cannot read; a
 *     `killall5` is `all`;
 *   - a `pkill` / `killall` carrying a user scope (`-u`, `-U`, `--uid`, `--euid`,
 *     `--user`, or a lower-case option cluster holding `u`) is `user`;
 *   - a command that runs an interpreter (`python`, `node`, `bun`, `perl`, `ruby`, …)
 *     is also read as text for `kill(-1, …)`, `kill(-1)`, `killpg(1, …)`, `kill(SIG, -1)`
 *     and perl's `kill SIG => -1`, which is how a `-c` body or a heredoc carries the call.
 *
 * Shapes read are the memory guard's: quotes, `VAR=value` prefixes, wrappers, `bash -c`
 * and `eval` bodies, `env -S`, subshells, `$(…)` and backticks, all through
 * `simpleCommands` / `unwrap` (bash-destructive-write.ts), so one lexer owns the words.
 * A guardrail against a child's own bad judgement, not a security boundary: a script
 * file run by path, or a kill assembled at run time inside an interpreter, is outside
 * it. No Pi imports on purpose; the hook that refuses lives in broadcast-kill-guard.ts.
 */

import path from "node:path";
import { simpleCommands, unwrap } from "./bash-destructive-write.ts";

/** How deep `bash -c` / `eval` / `env -S` bodies are followed before the predicate gives up. */
const MAX_DEPTH = 4;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** The command words that are a signal sender. Read at any position of a simple command. */
const KILL_WORDS = new Set(["kill", "pkill", "killall", "killall5"]);
/** `kill` options that take the signal as the next word. */
const KILL_SIGNAL_VALUE_OPTIONS = new Set(["-s", "-n", "--signal"]);
/** A command whose argument text can carry a kill call: the `-c` body or a heredoc. */
const INTERPRETERS =
  /^(?:python[0-9.]*|pypy[0-9]*|node|nodejs|bun|deno|perl|ruby|php|tsx|ts-node)$/;
/** pkill / killall user scopes. A signal name holding a `U` (`-HUP`, `-USR1`) is not one. */
const USER_SCOPE_LONG = /^--(?:uid|euid|user)(?:=|$)/;
const USER_SCOPE_SHORT = /^-(?:u\S*|U|[a-z]*u[a-z]*|[a-z]+U\S*)$/;
/** The interpreter call forms, each paired with the label the refusal is traced under. */
const INTERPRETER_CALLS: ReadonlyArray<[RegExp, string]> = [
  [/\bkill\s*\(\s*-\s*1\s*[,)]/, "kill(-1"],
  [/\bkillpg\s*\(\s*1\s*[,)]/, "killpg(1"],
  [/\bkill\s*\(\s*(?:"[^"]*"|'[^']*'|:\w+|\w+)\s*,\s*-\s*1\s*[,)]/, "kill(SIG, -1"],
  [/\bkill\s+(?:-?[\w.:]+|'[^']*'|"[^"]*")\s*(?:,|=>)\s*-1\b/, "kill SIG => -1"],
];

/** Shell-quote one word, so it re-tokenises as the same word. */
const quoteWord = (w: string): string => `'${w.replace(/'/g, "'\\''")}'`;

/**
 * The verdict on a command. `all` signals every process of the uid; `user` is a
 * pkill/killall scoped by user; `unresolved` is a negative `kill` target the guard cannot
 * read. `via` is a fixed label for the trace line — never text from the command.
 */
export type BroadcastKillVerdict =
  | { kind: "all"; via: string }
  | { kind: "user"; via: string }
  | { kind: "unresolved"; via: string };

/**
 * The verdict for a `kill` argv. The first dash word is the signal (`-TERM`, `-9`,
 * `-1` as SIGHUP); `-s`/`-n`/`--signal` take the next word; after `--` every word is a
 * target. A target of `-1` is the whole uid; a negative target that is not a literal
 * number cannot be read and is refused as such; a literal negative group (`-1234`) and
 * a pid are allowed. `-l`/`-L` list signals and send nothing.
 */
function killVerdict(argv: readonly string[]): BroadcastKillVerdict | undefined {
  let signalSeen = false;
  let targetsOnly = false;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i] ?? "";
    if (!targetsOnly) {
      if (w === "--") {
        targetsOnly = true;
        continue;
      }
      if (
        w === "-l" ||
        w === "-L" ||
        w === "--list" ||
        w.startsWith("--list=") ||
        w === "--table"
      ) {
        return undefined;
      }
      if (KILL_SIGNAL_VALUE_OPTIONS.has(w)) {
        signalSeen = true;
        i++;
        continue;
      }
      if (w.startsWith("--signal=")) {
        signalSeen = true;
        continue;
      }
      if (!signalSeen && w.startsWith("-")) {
        signalSeen = true;
        continue;
      }
    }
    if (w === "-1") return { kind: "all", via: "kill -1" };
    if (w.startsWith("-") && !/^-\d+$/.test(w)) {
      return { kind: "unresolved", via: "negative kill target" };
    }
  }
  return undefined;
}

/** The verdict for a `pkill` / `killall` argv: refused when any option scopes it by user. */
function userScopedVerdict(
  argv: readonly string[],
  tool: string,
): BroadcastKillVerdict | undefined {
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i] ?? "";
    if (w === "--") break;
    if (USER_SCOPE_LONG.test(w) || USER_SCOPE_SHORT.test(w)) {
      return { kind: "user", via: `${tool} -u` };
    }
  }
  return undefined;
}

/** The verdict for the signal sender whose word sits at `argv[0]`. */
function senderVerdict(argv: readonly string[], word: string): BroadcastKillVerdict | undefined {
  if (word === "kill") return killVerdict(argv);
  if (word === "killall5") return { kind: "all", via: "killall5" };
  return userScopedVerdict(argv, word);
}

/**
 * The verdict for a `bash -c`, `eval` or `script -c` body, if the command has one. The
 * `depth >= MAX_DEPTH` gate here is what stops a nested body from being opened at all.
 */
function nestedVerdict(
  argv: readonly string[],
  head: string,
  depth: number,
): BroadcastKillVerdict | undefined {
  if (depth >= MAX_DEPTH) return undefined;
  if (head === "eval") return broadcastKillVerdictOf(argv.slice(1).join(" "), depth + 1);
  if (SHELLS.has(head) || head === "script") {
    const c = argv.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    const body = c >= 0 ? argv[c + 1] : undefined;
    return body === undefined ? undefined : broadcastKillVerdictOf(body, depth + 1);
  }
  return undefined;
}

/** What one simple command says: its verdict, and whether its command word is an interpreter. */
function judgeWords(
  words: readonly string[],
  depth: number,
): { verdict?: BroadcastKillVerdict; interpreter: boolean } {
  const { argv, split } = unwrap(words);
  if (split !== undefined) {
    // `env -S` re-splits its payload as a command line; words after it are appended to that line.
    const [payload = "", ...tail] = split;
    return {
      verdict: broadcastKillVerdictOf([payload, ...tail.map(quoteWord)].join(" "), depth + 1),
      interpreter: false,
    };
  }
  // A single word holding a whole command (`watch 'kill -TERM -1'`) is re-parsed as one.
  if (argv.length === 1 && /\s/.test(argv[0] ?? "")) {
    return { verdict: broadcastKillVerdictOf(argv[0] ?? "", depth + 1), interpreter: false };
  }
  const head = path.basename(argv[0] ?? "");
  const nested = nestedVerdict(argv, head, depth);
  if (nested !== undefined) return { verdict: nested, interpreter: false };
  for (let k = 0; k < argv.length; k++) {
    const word = path.basename(argv[k] ?? "");
    if (!KILL_WORDS.has(word)) continue;
    const verdict = senderVerdict(argv.slice(k), word);
    if (verdict !== undefined) return { verdict, interpreter: false };
  }
  return { interpreter: INTERPRETERS.test(head) };
}

/**
 * The verdict for a bash command: the first simple command that sends a uid-wide signal,
 * a user-scoped pkill/killall, or a negative kill target the guard cannot read; then, when
 * the command runs an interpreter, the first kill call its text carries. Undefined when
 * every signal the command sends is aimed at a pid or a literal group.
 */
export function broadcastKillVerdictOf(
  command: string,
  depth = 0,
): BroadcastKillVerdict | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let interpreter = false;
  for (const words of simpleCommands(command)) {
    const judged = judgeWords(words, depth);
    if (judged.verdict !== undefined) return judged.verdict;
    interpreter ||= judged.interpreter;
  }
  if (!interpreter) return undefined;
  for (const [pattern, via] of INTERPRETER_CALLS) {
    if (pattern.test(command)) return { kind: "all", via };
  }
  return undefined;
}

/** True when the command must be refused as a broadcast kill (see broadcastKillVerdictOf). */
export function isBroadcastKill(command: string): boolean {
  return broadcastKillVerdictOf(command) !== undefined;
}
