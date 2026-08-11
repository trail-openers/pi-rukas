/**
 * Bash command parsing helpers used by the permission guard: quote-stripping,
 * command-prefix extraction (for "Allow always (cmd *)" scopes), and
 * subcommand-allowlist matching. Split out of permission-guard.ts (#171) to
 * stay under the module-size guideline (AGENTS.md §12) — this cluster is pure
 * string/token parsing with no Pi API and no filesystem I/O.
 */

import { trace } from "./trace.js";

// Chars that indicate command injection / chaining in a bash *command*. If a
// command contains any of these OUTSIDE quoted segments, we refuse to extract
// a wildcard scope and we refuse to match it against any cached wildcard
// pattern — the prefix matcher cannot reason about what `&&`, `$(...)`, or
// backticks will actually run.
//
// IMPORTANT: this regex is applied to the OUTPUT of stripQuotedSegments(), not
// to the raw command. `vipune add "lorem && ipsum"` extracts to `vipune add `
// after quote-stripping and passes the test cleanly — bash never interprets
// `&&` inside a quoted argument as a separator, so it isn't an injection
// vector there. See issue #108.
export const BASH_COMMAND_INJECTION_CHARS = /[`$;&|<>\n]/;

// Strip single- and double-quoted segments from a shell command, returning the
// portion that bash would interpret as command structure (operators, paths,
// flag names, etc.). Used to apply BASH_COMMAND_INJECTION_CHARS only against
// the "executable" portion, so quoted arguments containing `&&`, `|`, `;`,
// etc. don't trip the injection-vector check (issue #108).
//
// Edge case: an unterminated quote is a syntactic error in bash. We return
// the ORIGINAL full command in that case — fail closed; the injection-vector
// test will then see whatever's inside the unterminated quote and reject if
// it contains operators. Defense in depth against an agent emitting malformed
// quoting to slip operators past the check.
//
// Out of scope: command substitution `$(...)` / backticks — these stay in
// the output of stripping and remain caught by the injection-vector regex
// (correctly: `$(curl evil)` is a real injection vector even if visually
// "inside" a string).
export function stripQuotedSegments(command: string): string {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      // Single quotes: bash treats everything inside as literal — no
      // variable expansion, no command substitution, no escape sequences.
      // Strip the whole quoted run.
      i++;
      let foundClose = false;
      while (i < n) {
        if (command[i] === "'") {
          foundClose = true;
          i++;
          break;
        }
        i++;
      }
      if (!foundClose) {
        trace(
          "permission-guard: stripQuotedSegments: unterminated single quote — returning raw command for fail-closed injection check",
        );
        return command;
      }
    } else if (ch === '"') {
      // Double quotes: most operators (`&`, `|`, `;`, `<`, `>`, newline) are
      // literal inside, BUT bash still interprets `$` (variable + command
      // substitution) and `` ` `` (command substitution) and `\` (escape).
      // Keep `$` and `` ` `` in the output so the injection-vector check sees
      // them — they're real injection vectors regardless of being "inside"
      // the quotes.
      i++;
      let foundClose = false;
      while (i < n) {
        if (command[i] === "\\" && i + 1 < n) {
          // Backslash escape — next char is literal, skip both.
          i += 2;
          continue;
        }
        if (command[i] === '"') {
          foundClose = true;
          i++;
          break;
        }
        if (command[i] === "$" || command[i] === "`") {
          result += command[i] ?? "";
        }
        // Other chars are literal inside double quotes — strip them.
        i++;
      }
      if (!foundClose) {
        trace(
          "permission-guard: stripQuotedSegments: unterminated double quote — returning raw command for fail-closed injection check",
        );
        return command;
      }
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

// Process-wrapper tokens to skip when extracting a command prefix.
// `timeout 30 npm test` should extract to `npm test`, not `timeout`.
// Matches Claude Code's documented strip set.
const COMMAND_WRAPPERS = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
  "exec",
  "env",
]);

// Multi-subcommand CLI tools: take 2 tokens (e.g. `git commit`, `npm test`).
// These are tools where the first token alone is too broad to be a useful
// "Allow always" scope — `git *` would also allow `git push --force`.
// `oo` is included because it wraps other tools; extractCommandPrefix detects
// that case and recurses into the inner tool's prefix.
const MULTI_SUBCOMMAND_TOOLS = new Set([
  "git",
  "gh",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "go",
  "bun",
  "bunx",
  "vipune",
  "docker",
  "pi",
  "ctx7",
  "kubectl",
  "oo",
]);

// Three-token run-style invocations where the third token is the script name
// the user actually cares about granting (`npm run lint`, not `npm run *`).
const TRIPLE_LEVEL_PAIRS = new Set(["npm run", "pnpm run", "yarn run", "bun run", "cargo run"]);

// Chars that mark a token as "not part of the command prefix". Anything outside
// [A-Za-z0-9_.-=] terminates prefix collection — paths (`/tmp/foo`), globs
// (`*.ts`), env-var values past `=`, etc.
const NON_PREFIX_TOKEN = /[^A-Za-z0-9_.\-=]/;
// Chars that, when found inside a token, mean the *next* shell command starts
// here (compound/redirect). Distinct from BASH_COMMAND_INJECTION_CHARS because
// we use this to find the head of the *current* command — `git;` should yield
// `git`, not get filtered as junk. Backtick and `$` would also start an inline
// substitution; treat them the same.
const PREFIX_TERMINATOR = /[`$;&|<>]/;

// Shell-quote-aware tokeniser used only for prefix extraction. Treats quoted
// runs as a single sentinel token (we don't care about argument content for
// permission scope, only that there *is* an argument here). Does NOT attempt
// to be a full shell parser — anything beyond simple quoting (heredocs, brace
// expansion, etc.) falls through to the injection-vector check in
// getBashAlwaysScope and ends up uncached.
export function tokenizeForPrefix(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    while (i < n && /\s/.test(command[i] ?? "")) i++;
    if (i >= n) break;
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && command[i] !== quote) {
        if (command[i] === "\\" && i + 1 < n) i++;
        i++;
      }
      if (i < n) i++; // consume closing quote
      tokens.push("<arg>");
      continue;
    }
    const start = i;
    while (i < n && !/\s/.test(command[i] ?? "") && command[i] !== '"' && command[i] !== "'") {
      i++;
    }
    tokens.push(command.slice(start, i));
  }
  return tokens;
}

// Strip leading process-wrapper tokens and KEY=value env-var assignments.
// Returns the remaining tokens — the "real" command after unwrapping.
function stripLeadingWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    // KEY=value env-var assignment
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (!COMMAND_WRAPPERS.has(t)) break;
    i++;
    // Wrapper-specific positional arguments to skip
    if (t === "timeout" || t === "stdbuf") {
      const next = tokens[i] ?? "";
      if (/^\d+[smhd]?$/.test(next)) i++;
    } else if (t === "nice") {
      if ((tokens[i] ?? "") === "-n") {
        i++;
        const next = tokens[i] ?? "";
        if (/^-?\d+$/.test(next)) i++;
      }
    } else if (t === "env") {
      // `env KEY=VAL cmd` — KEY=VAL handled by the env-var loop above on next iteration.
    }
  }
  return tokens.slice(i);
}

// Collect the leading "command word" tokens. Stops at the first argument-like
// token: a quoted run (<arg>), a flag (-x), a path (/foo), an injection char
// (where the next command starts), or anything outside the prefix charset.
// When a token contains an injection char part-way through (`git;`), the part
// *before* the char is kept as the last prefix token.
function collectPrefixTokens(rawTokens: string[]): string[] {
  const out: string[] = [];
  for (const token of rawTokens) {
    if (token === "<arg>") break;
    if (token.startsWith("-")) break;
    const term = token.search(PREFIX_TERMINATOR);
    if (term !== -1) {
      const head = token.slice(0, term);
      if (head.length > 0 && !NON_PREFIX_TOKEN.test(head)) out.push(head);
      break;
    }
    if (NON_PREFIX_TOKEN.test(token)) break;
    out.push(token);
  }
  return out;
}

// Helper: extract command prefix from bash command for pattern caching.
// Strategy: tokenise (quote-aware), strip wrappers/env-vars, collect leading
// command-word tokens, then take 1-3 of them depending on whether the leading
// tool is in a known multi-subcommand family.
export function extractCommandPrefix(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "bash";
  const stripped = stripLeadingWrappers(tokenizeForPrefix(trimmed));
  const cleanTokens = collectPrefixTokens(stripped);
  if (cleanTokens.length === 0) {
    // Fallback: the first raw token if it survives the safe-token check.
    const first = stripped[0] ?? "";
    return NON_PREFIX_TOKEN.test(first) || PREFIX_TERMINATOR.test(first) || first === "<arg>"
      ? "bash"
      : first;
  }
  const t1 = cleanTokens[0] ?? "";
  if (cleanTokens.length === 1 || !MULTI_SUBCOMMAND_TOOLS.has(t1)) {
    return t1;
  }
  const t2 = cleanTokens[1] ?? "";
  if (t2 === "") return t1;
  // Recursive case: `oo <tool>` where the inner tool is itself multi-level.
  // Drives `oo git status` → `oo git status`, `oo gh issue view` → `oo gh issue`.
  if (t1 === "oo" && MULTI_SUBCOMMAND_TOOLS.has(t2)) {
    const innerPrefix = extractCommandPrefix(cleanTokens.slice(1).join(" "));
    return `oo ${innerPrefix}`;
  }
  // Three-token run-style invocations.
  if (TRIPLE_LEVEL_PAIRS.has(`${t1} ${t2}`) && cleanTokens.length >= 3) {
    const t3 = cleanTokens[2] ?? "";
    if (t3 !== "") return `${t1} ${t2} ${t3}`;
  }
  return `${t1} ${t2}`;
}

// Match a concrete bash command against a nested subcommand allowlist
// (e.g. agents.json's `permission.bash` { "vipune *": "allow", ... }).
// Returns the verdict from the longest matching pattern, or the catch-all "*"
// if present. Returns null if the allowlist has no matching entry.
//
// Pattern semantics:
//   - "pattern *" (trailing " *"): word-boundary prefix. `vipune *` matches
//     `vipune` and `vipune add foo` but not `vipuneish`.
//   - "pattern*"  (trailing "*" no space): loose prefix. `which*` matches
//     `whichever`. Matches the long-standing convention in agents.json.
//   - "pattern"    (no wildcard): exact match.
// Most specific pattern wins (longest prefix). Catch-all "*" is checked last.
//
// Refuses to match commands containing injection vectors OUTSIDE quoted
// segments — those must always reach the interactive prompt. Quoted content
// is transparent (see stripQuotedSegments and issue #108).
/**
 * `vipune update` carrying new content — refused for every role, unconditionally.
 *
 * Measured: `vipune update <id> -t "…"` REPLACES the row's content in place. One
 * row before, one row after; no new row, no `superseded_by` lineage, no undo. The
 * id survives, so anything that cited that memory now cites different text —
 * which makes it quieter than `delete`, and worse.
 *
 * The allowlist alone cannot express this. `matchBashSubcommand` is
 * prefix-based, so `"vipune update *"` grants every flag or none; there is no way
 * to permit `--status` (harmless promotion) while refusing `--text`. So the
 * refusal lives here, ahead of the allowlist, and holds even if a future edit
 * re-admits the verb.
 *
 * The harness repairs memory with `add --supersedes`, which preserves the
 * original row — the same reasoning as #406: an agent must not silently rewrite
 * the record it is judged against.
 */
export function isDestructiveMemoryWrite(command: string): boolean {
  const c = command.trim();
  if (!/^vipune\s+update\b/.test(c)) return false;
  return /(^|\s)(-t|--text)(\s|=|$)/.test(c);
}

export function matchBashSubcommand(
  command: string,
  allowlist: Record<string, string>,
): string | null {
  // Commands containing injection vectors OUTSIDE quoted segments (`&&`, `|`,
  // `>`, `$(...)`, backticks, etc.) can't be safely auto-approved by any
  // wildcard pattern. We return null here so the lookup falls through to the
  // role's `*: ask` catch-all (or, absent that, resolveToolPermission's
  // default "ask") — i.e. the parent prompts the user with the FULL command
  // text visible. The user is the trust boundary: they read the chain and
  // approve / deny once. LLM subagents naturally emit chains like
  // `cd $WORKTREE && git status`, and hard-denying without a prompt blocks
  // legitimate workflows (#188 follow-up; broke ops/developer subagent bash
  // for routine /work cycles).
  //
  // Defense in depth on the CACHE side stays intact: getBashAlwaysScope and
  // bashPatternMatches both refuse to wildcard a command with injection
  // vectors. "Allow always" on a chained command stores only an exact-hash
  // cache entry — any *different* chain shape will still re-prompt. So the
  // user can never approve `git X && rm -rf /` as a side-effect of having
  // ever approved `git status && git diff`.
  if (BASH_COMMAND_INJECTION_CHARS.test(stripQuotedSegments(command))) return null;
  if (isDestructiveMemoryWrite(command)) return "deny";
  // Sort patterns by length descending so the more specific entry wins.
  const patterns = Object.entries(allowlist)
    .filter(([k]) => k !== "*")
    .sort(([a], [b]) => b.length - a.length);
  for (const [pattern, verdict] of patterns) {
    if (typeof verdict !== "string") continue;
    if (pattern.endsWith(" *")) {
      const prefix = pattern.slice(0, -2);
      if (command === prefix || command.startsWith(`${prefix} `)) return verdict;
    } else if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (command.startsWith(prefix)) return verdict;
    } else if (command === pattern) {
      return verdict;
    }
  }
  const catchall = allowlist["*"];
  return typeof catchall === "string" ? catchall : null;
}
