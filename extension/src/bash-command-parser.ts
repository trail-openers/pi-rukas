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

// Escape a single pattern token for use inside a RegExp literal.
function escapeRegexToken(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns true if the pattern has at least one standalone `*` token in a
// non-trailing position. Patterns with a mid `*` are routed through the
// regex branch; trailing `*`/` *` branches only apply to patterns without a mid `*`.
function hasMidWildcard(pattern: string): boolean {
  const tokens = pattern.split(" ");
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "*") return true;
  }
  return false;
}

// Build a RegExp for a pattern containing `*` tokens. Standalone mid `*`
// tokens become `\S+` (one whitespace-free arg); a trailing `*` on the last
// token becomes `.*` (loose prefix). Returns null if no `*` tokens at all.
function midWildcardPattern(pattern: string): RegExp | null {
  const tokens = pattern.split(" ");
  let hasAny = false;
  for (const t of tokens) {
    if (t === "*" || t.endsWith("*")) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return null;
  const last = tokens.length - 1;
  const parts = tokens.map((t, i) => {
    if (t === "*") return "\\S+";
    if (i === last && t.endsWith("*")) {
      const stem = t.slice(0, -1);
      return stem ? `${escapeRegexToken(stem)}.*` : ".*";
    }
    return escapeRegexToken(t);
  });
  return new RegExp(`^${parts.join("\\s+")}$`);
}

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

// Git invocation prefix used by the working-tree predicates below: an
// optional `oo` wrapper, `git`, optional `-C <path>`, then whitespace. The
// predicates SCAN for this (not anchor it) so chained shapes
// (`cd x && git …`) and `git -C <path> …` are all caught.
const GIT = "(?:^|[;&|]|\\s)(?:oo\\s+)?git(?:\\s+-C\\s+\\S+)*\\s+";

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
// (e.g. agents.json's `permission.bash`). Returns the verdict from the longest
// matching pattern, or the catch-all `*` if present. Null if no entry matches.
//
// Pattern semantics: "pattern *" is a word-boundary prefix; "pattern*" (no
// space) is a loose prefix; a bare pattern is an exact match. A STANDALONE `*`
// token in the middle (surrounded by spaces, not trailing — e.g. `git -C *`)
// matches exactly ONE whitespace-free argument (`\S+`). Most specific wins.
// Refuses to match commands with injection vectors outside quoted segments.
/**
 * `vipune update` carrying new content — refused for every role, unconditionally.
 * The allowlist is prefix-based and cannot express "allow `--status` but not
 * `--text`", so this refusal sits ahead of the allowlist and holds regardless.
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
  // Injection vectors outside quoted segments → null (the caller prompts).
  if (BASH_COMMAND_INJECTION_CHARS.test(stripQuotedSegments(command))) return null;
  if (isDestructiveMemoryWrite(command)) return "deny";
  // Match on the stripped form so a quoted path with a space (`git -C "a b"`)
  // is seen as a single token and rejected by `\S+`.
  const stripped = stripQuotedSegments(command);
  const patterns = Object.entries(allowlist)
    .filter(([k]) => k !== "*")
    .sort(([a], [b]) => b.length - a.length);
  for (const [pattern, verdict] of patterns) {
    if (typeof verdict !== "string") continue;
    const hasMid = hasMidWildcard(pattern);
    if (!hasMid && pattern.endsWith(" *")) {
      const prefix = pattern.slice(0, -2);
      if (stripped === prefix || stripped.startsWith(`${prefix} `)) return verdict;
    } else if (!hasMid && pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (stripped.startsWith(prefix)) return verdict;
    } else if (stripped === pattern) {
      return verdict;
    } else {
      // Mid `*` support (#891): standalone `*` tokens become `\S+`; a
      // trailing `*` on the last token becomes `.*` (loose prefix).
      const regex = midWildcardPattern(pattern);
      if (regex?.test(stripped)) return verdict;
    }
  }
  const catchall = allowlist["*"];
  return typeof catchall === "string" ? catchall : null;
}

/**
 * Does this command discard uncommitted work in the working tree?
 *
 * Scans the whole string (not just the leading verb) so compound commands
 * and `git -C <path>` forms are caught. Quoted segments are stripped first.
 * Deliberately conservative: a false positive is cheap, a false negative
 * destroys work. NOT included: `git stash`, `git reset` without `--hard`,
 * plain `git checkout <branch>`.
 */
export function discardsUncommittedWork(command: string): string | undefined {
  // Compound commands are the norm (`cd x && git checkout .`), and `git -C
  // <path>` moves the target elsewhere, so scan the whole string rather than
  // parsing a single leading verb. Quoted segments are stripped first, so a
  // command that merely MENTIONS one of these inside a message is not blocked.
  const c = stripQuotedSegments(command);
  const hit = (verb: string): string | undefined => new RegExp(GIT + verb).exec(c)?.[0]?.trim();
  return (
    // `git checkout .` / `-- <path>` / `-f` restores tracked files from the
    // index or a commit, destroying edits. `-b`/`-B` create a branch instead.
    hit("checkout\\s+(?!-{1,2}[bB]\\b)(--\\s|-f\\b|--force\\b|\\.(?:\\s|$))") ??
    // `git restore <path>` exists only to discard. `--staged` ALONE merely
    // unstages, which loses nothing.
    hit("restore\\s+(?!--staged(?:\\s|$))") ??
    // Only --hard/--merge/--keep touch the working tree.
    hit("reset\\s+(?:--hard|--merge|--keep)\\b") ??
    // `git clean -f` deletes untracked files outright — including whole new
    // files a developer just wrote.
    hit("clean\\s+[^;&|]*(?:-[a-zA-Z]*f|--force)")
  );
}

/**
 * Does this command run an INTERACTIVE git command that can hang an agent
 * child waiting on an editor or a terminal prompt?
 *
 * `git rebase -i` and bare `git commit` (without `-m`) each park the child
 * until the inactivity watchdog kills it. The env-var layer in spawn.ts
 * childEnv is the primary defense; this predicate is the catch ahead of it.
 */
export function rejectsInteractiveGit(command: string): string | undefined {
  const c = stripQuotedSegments(command);
  // `git rebase -i …` / `git rebase --interactive …`: catch the flag in the
  // invocation's own argument span (up to the next shell operator).
  const rebaseSpan = new RegExp(`${GIT}rebase(?:[\\s;&|]|$)[^;&|]*`).exec(c);
  if (rebaseSpan?.[0]) {
    const span = rebaseSpan[0];
    if (/\s-i\b/.test(` ${span}`) || /\s--interactive\b/.test(` ${span}`)) return span.trim();
  }
  // Bare `git commit` (or with options) that carries no message on the line:
  // if `-m` / `--message` / `--no-edit` / `-am` appear in the span the editor
  // never opens.
  const commitSpan = new RegExp(`${GIT}commit(?:[\\s;&|]|$)[^;&|]*`).exec(c);
  if (commitSpan?.[0]) {
    if (!/-m\b|--message\b|--no-edit\b|-am\b/.test(commitSpan[0])) return commitSpan[0].trim();
  }
  return undefined;
}

/**
 * Does this command create a forge issue (or a REST POST that does)?
 *
 * Forge-agnostic (#611). Catches `gh issue create`, `glab issue create`,
 * `gh api repos/{o}/{r}/issues` (blocked unless `--method GET`), and
 * `glab api /projects/{id}/issues` (blocked only when explicitly posting).
 * Quoted segments are stripped first.
 */
export function createsIssue(command: string): string | undefined {
  const c = stripQuotedSegments(command);
  const FORGE = "(?:^|[;&|]|\\s)(?:oo\\s+)?(?:gh|glab)\\s+";
  const issueCreate = new RegExp(`${FORGE}issue\\s+create(?:\\s|$)`).exec(c);
  if (issueCreate?.[0]) return issueCreate[0].trim();
  // REST door, gh: `gh api` on the issues COLLECTION (`repos/{o}/{r}/issues`).
  // gh api defaults to POST when body fields (`-f`) are present. A trailing
  // segment (specific issue) or an explicit `--method GET` makes it a read.
  const ghApiMatch = new RegExp(`${FORGE}api\\s+(repos/[^\\s]+)`).exec(c);
  const ghEndpoint = ghApiMatch?.[1] ?? "";
  if (ghApiMatch && /\/issues(?:[?&?#\s]|$)/.test(ghEndpoint)) {
    const rest = c.slice(ghApiMatch.index);
    if (!/\s(?:--method|-X)\s+GET\b/.test(rest)) return (ghApiMatch?.[0] ?? "").trim();
  }
  // REST door, glab: `glab api` on the issues COLLECTION
  // (`/projects/{id}/issues`). glab api does NOT default to POST the way gh
  // api does, so this door is method-aware: blocked only when the command
  // EXPLICITLY posts. An unqualified call, or an explicit `--method`/`-X GET`,
  // is a read.
  const glabApiMatch = new RegExp(`${FORGE}api\\s+(/projects/[^\\s]+)/issues(?:[?#\\s]|$)`).exec(c);
  if (glabApiMatch?.[0] !== undefined) {
    const rest = c.slice(glabApiMatch.index);
    const explicitGet = /\s(?:--method|-X)\s+GET\b/.test(rest);
    const posts =
      /\s(?:-X|-f|-F)\s+POST\b/.test(rest) ||
      /\s--method\s+POST\b/.test(rest) ||
      /\s(?:-f|-F|--field)(?:=|\s)/.test(rest);
    if (!explicitGet && posts) return glabApiMatch[0].trim();
  }
  return undefined;
}
