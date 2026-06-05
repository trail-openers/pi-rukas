/**
 * pi-ensemble permission interceptor — owns the `tool_call` hook that
 * decides allow/deny/ask for every tool the parent agent invokes.
 *
 * Five concerns live here today (refactor tracker: #171):
 *
 *   1. Bash-command parsing — quote-stripping, prefix extraction, injection-
 *      vector detection. Used to compute "Allow always (cmd *)" scopes and
 *      to refuse caching for injection-bearing commands.
 *
 *   2. Three-layer config resolution — $PWD/.pi/permissions.json (project)
 *      → ~/.pi/agent/permissions.json (host-global) → shipped agents.json
 *      (baseline). First match wins, project beats host beats baseline.
 *
 *   3. Decision cache — Map<key, {allowed, timestamp}> persisted to
 *      $PWD/.pi/decisions.json. Exact bash commands hash to a sha256 key;
 *      wildcard-able commands key on `bash:<prefix> *`. Bounded by
 *      MAX_CACHED_DECISIONS with insertion-order eviction.
 *
 *   4. Permission resolution — `resolveToolPermission` and
 *      `lookupPermission`. Tool-name wildcards: exact match → longest
 *      prefix → `"*"` catch-all (#168). Bash subcommands use the same
 *      specificity rule via `matchBashSubcommand`.
 *
 *   5. Orchestration — `registerPermissionGuard` hooks `tool_call`,
 *      prompts the user via `ctx.ui.select` when verdict is "ask" and a
 *      UI exists, hard-denies "ask" in headless mode.
 *
 * Headless safety: `"ask"` verdicts hard-deny when `!ctx.hasUI`, so
 * automation never silently approves anything. Bash commands with
 * injection vectors hard-deny at the matcher level — they never reach
 * the prompt.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROLE_NAMES } from "./roles.js";
import { trace } from "./trace.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Type definitions
export type PermVerdict = "allow" | "deny" | "ask";
type PermPattern = Record<string, PermVerdict | Record<string, PermVerdict>>;
export type RoleConfig = Record<string, { permission?: PermPattern }>;

// Constants
const DECISION_KEY_MAX_ARGS = 200;
const DECISION_KEY_MAX_LENGTH = 250;
const MAX_CACHED_DECISIONS = 500;
const MAX_CONFIG_FILE_SIZE = 1 * 1024 * 1024; // 1MB

// Pattern key constants for bash command prefix caching
const BASH_PATTERN_PREFIX = "bash:";
const PATTERN_SUFFIX = " *";
// Chars that should NEVER appear in a stored bash *pattern prefix*. A prefix
// like `vipune add` is safe; one like `vipune "add` or `vipune *` is not — at
// match time it would either fail to compare correctly or could match unexpected
// commands. Used by isSafeBashPatternPrefix to gate what we save to disk.
const BASH_PATTERN_UNSAFE_CHARS = /['"`*?\[\]{}|&;<>$]/;
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
const BASH_COMMAND_INJECTION_CHARS = /[`$;&|<>\n]/;

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
function stripQuotedSegments(command: string): string {
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

// Pattern key helpers
function buildPatternKey(prefix: string): string {
  return `${BASH_PATTERN_PREFIX}${prefix}${PATTERN_SUFFIX}`;
}
function isPatternKey(key: string): boolean {
  return key.startsWith(BASH_PATTERN_PREFIX) && key.endsWith(PATTERN_SUFFIX);
}
function extractPatternPrefix(key: string): string {
  return key.slice(BASH_PATTERN_PREFIX.length, -PATTERN_SUFFIX.length);
}

function isSafeBashPatternPrefix(prefix: string): boolean {
  return prefix.length > 0 && !BASH_PATTERN_UNSAFE_CHARS.test(prefix);
}

export function getBashAlwaysScope(command: string): string | null {
  if (command.trim().length === 0) return null;
  // Commands with injection vectors (`&&`, `$(...)`, backticks, redirects, etc.)
  // OUTSIDE quoted segments can't be safely wildcarded — what we'd cache as
  // `cmd *` would also match benign invocations that contain the same
  // injection at runtime. Quoted content is exempt (see stripQuotedSegments).
  if (BASH_COMMAND_INJECTION_CHARS.test(stripQuotedSegments(command))) return null;
  const prefix = extractCommandPrefix(command);
  if (!isSafeBashPatternPrefix(prefix)) return null;
  return prefix;
}

export function getBashAlwaysPromptLabel(
  action: "Allow always" | "Deny always",
  command: string,
): string {
  const scope = getBashAlwaysScope(command);
  return scope ? `${action} (${scope} *)` : action;
}

function buildExactBashDecisionKey(command: string): string {
  const digest = createHash("sha256").update(command, "utf8").digest("hex");
  return `${BASH_PATTERN_PREFIX}exact:${digest}`;
}

export function bashPatternMatches(command: string, scope: string): boolean {
  if (!isSafeBashPatternPrefix(scope)) return false;
  // Even if the prefix matches, refuse to honour a wildcard for commands that
  // contain injection vectors OUTSIDE quoted segments. Runtime mirror of the
  // check in getBashAlwaysScope — `$(...)` outside quotes can't be auto-
  // approved by any wildcard, only by explicit "Allow once" decision.
  if (BASH_COMMAND_INJECTION_CHARS.test(stripQuotedSegments(command))) return false;
  const matchesPrefix =
    command.startsWith(scope) && (command.length === scope.length || command[scope.length] === " ");
  if (!matchesPrefix) return false;
  return extractCommandPrefix(command) === scope;
}

function isSafeBashPatternKey(key: string): boolean {
  if (!isPatternKey(key)) return false;
  return isSafeBashPatternPrefix(extractPatternPrefix(key));
}

export function getBashDecisionCacheKey(command: string, input: unknown): string {
  const scope = getBashAlwaysScope(command);
  return scope ? buildPatternKey(scope) : buildExactBashDecisionKey(command);
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

// Helper: evict oldest entries from a decisions map
function evictOldest(map: Map<string, { allowed: boolean; timestamp: string }>, max: number): void {
  if (map.size <= max) return;
  const sorted = [...map.entries()].sort((a, b) => b[1].timestamp.localeCompare(a[1].timestamp));
  map.clear();
  for (const [k, v] of sorted.slice(0, max)) map.set(k, v);
}

// Tool names that have been removed from pi-ensemble but may still appear in
// older `.pi/decisions.json` files. Loading them is harmless but they bloat
// the cache and confuse `/runs`-style introspection. Add a tool here when it
// is removed; entries here are cleaned out of the cache on session_start.
const STALE_TOOL_NAMES = new Set(["pair_watch"]);

// Decision keys we accept come in three shapes (see save sites):
//   1. `bash:<prefix> *`         — bash wildcard pattern (from "Allow always")
//   2. `bash:exact:<sha256>`     — bash exact-command hash (injection-vector
//                                  commands that the user "Allow always"-ed)
//   3. `<toolname>`              — non-bash tool-level grant (no ":" at all)
//
// Anything else came from an earlier version of the code that keyed decisions
// on a JSON.stringify(input). Those entries are tied to a literal input string
// and will never match a future invocation — drop them.
type DecisionKeyShape =
  | "bash-pattern"
  | "bash-exact"
  | "tool-level"
  | "old-format-full-input"
  | "unsafe-pattern"
  | "stale-tool"
  | "invalid";

function classifyDecisionKey(key: string): DecisionKeyShape {
  if (key.length === 0) return "invalid";
  if (key.startsWith(BASH_PATTERN_PREFIX)) {
    if (key.startsWith(`${BASH_PATTERN_PREFIX}exact:`)) return "bash-exact";
    if (isPatternKey(key)) {
      return isSafeBashPatternKey(key) ? "bash-pattern" : "unsafe-pattern";
    }
    // Starts with `bash:` but neither `exact:` nor ends with ` *` → must be the
    // old `bash:{"command":"..."}` JSON-input shape.
    return "old-format-full-input";
  }
  if (!key.includes(":")) {
    // Tool-name level (e.g. `dispatch_specialist`). Reject if the tool no
    // longer exists.
    if (STALE_TOOL_NAMES.has(key)) return "stale-tool";
    // Reject obviously malformed entries (whitespace, control chars, etc.).
    if (!/^[A-Za-z0-9_.\-]+$/.test(key)) return "invalid";
    return "tool-level";
  }
  // Has ":" but doesn't start with "bash:" → old-format `<toolname>:{...}` shape.
  const prefix = key.slice(0, key.indexOf(":"));
  if (STALE_TOOL_NAMES.has(prefix)) return "stale-tool";
  return "old-format-full-input";
}

// Built-in Pi tool names — never block these
// Exported for tests and documentation — no longer used as runtime bypass
export const BUILTIN_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "multiedit",
  "rg",
  "list",
  "webfetch",
  "websearch",
  "skill",
  "todowrite",
  "task",
  "cancel_task",
  "list_tasks",
  "check_task",
  "question",
]);

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
function matchBashSubcommand(command: string, allowlist: Record<string, string>): string | null {
  // Commands containing injection vectors OUTSIDE quoted segments (`&&`, `|`,
  // `>`, `$(...)`, backticks, etc.) can never be matched safely — any future
  // wildcard would also let `cmd && rm -rf /` through. Return "deny" directly
  // rather than null so the role-level catch-all (now `*: ask` since #168)
  // cannot accidentally turn these into a prompt the user might approve.
  // Pre-#168 the role-level catch-all was `*: deny`, which masked this
  // distinction; flipping to `*: ask` requires the bash matcher to enforce
  // injection-vector deny itself.
  if (BASH_COMMAND_INJECTION_CHARS.test(stripQuotedSegments(command))) return "deny";
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

// Helper: lookup a tool in permission entries, exact match first then wildcard.
// Permission entries: string verdicts or nested objects (bash subcommand
// allowlists). When the tool is `bash` and a concrete command is supplied,
// the nested allowlist (if any) is consulted before the top-level fallback.
function lookupPermission(
  entries: Record<string, string | Record<string, string>>,
  toolName: string,
  bashCommand?: string,
): string | null {
  // Bash nested-allowlist lookup: agents.json may declare bash as an object
  // whose keys are command-prefix patterns. Without this branch the nested
  // allowlist was previously unreachable — the loop below skipped it because
  // its value is an object, not a string verdict.
  if (toolName === "bash" && bashCommand !== undefined) {
    const bashEntry = entries.bash;
    if (bashEntry && typeof bashEntry === "object") {
      const verdict = matchBashSubcommand(bashCommand, bashEntry as Record<string, string>);
      if (verdict !== null) return verdict;
      // Nested allowlist had no match and no catch-all — fall through to the
      // top-level lookup, which will skip the object entry and return null.
    }
  }

  // Check exact match first
  const exactMatch = entries[toolName];
  if (exactMatch !== undefined && typeof exactMatch === "string") {
    return exactMatch;
  }

  // Check wildcard matches, longest prefix wins, "*" catch-all checked last.
  // Without the sort + catch-all-last semantics, an entry like `{"*": "deny",
  // "mcp*": "ask"}` would always return "deny" on the first iteration because
  // `*` matches every tool — so no specific role-level wildcard could ever
  // override the catch-all. Mirrors matchBashSubcommand's specificity rule
  // (line 458) so tool-level and bash-subcommand patterns behave the same way.
  const patterns = Object.entries(entries)
    .filter(
      ([pattern, verdict]) =>
        typeof verdict === "string" && pattern !== "*" && pattern.endsWith("*"),
    )
    .sort(([a], [b]) => b.length - a.length);
  for (const [pattern, verdict] of patterns) {
    if (toolName.startsWith(pattern.slice(0, -1))) {
      return verdict as string;
    }
  }
  const catchall = entries["*"];
  return typeof catchall === "string" ? catchall : null;
}

// Resolve the path to the repo's agents.json regardless of how the extension
// was loaded. The standard install symlinks ~/.pi/agent/extensions/pi-ensemble
// at the repo's `extension/` directory, so `import.meta.url` may be either
// the real file path or the symlink path depending on the Node/jiti symlink
// policy. realpathSync collapses the difference; `../..` then walks from
// `extension/src/` up to the repo root.
//
// PI_ENSEMBLE_DIR (if set) is an explicit override for users with unusual
// install layouts — useful in tests too.
export function resolveAgentsJsonPath(): string {
  const override = process.env.PI_ENSEMBLE_DIR;
  if (override) return path.resolve(override, "agents.json");
  try {
    const realDir = realpathSync(__dirname);
    return path.resolve(realDir, "..", "..", "agents.json");
  } catch {
    return path.resolve(__dirname, "..", "..", "agents.json");
  }
}

// agents.json ships with the repo, so ENOENT is unexpected and should warn.
// In contrast, project/global config ENOENT is silent (user may not have created them).
export function loadAgentsJson(): Record<
  string,
  { permission?: Record<string, string | Record<string, string>> }
> {
  const agentsPath = resolveAgentsJsonPath();
  try {
    const raw = readFileSync(agentsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as {
      agent?: Record<string, { permission?: Record<string, string | Record<string, string>> }>;
    };
    return obj.agent ?? {};
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to load agents.json from ${agentsPath} (${err}) — non-builtin tools will require interactive approval (or be blocked in headless mode)`;
    console.warn(msg);
    trace(msg);
    return {};
  }
}

function loadConfigFile(configPath: string, label: string): RoleConfig {
  try {
    const raw = readFileSync(configPath, "utf8");

    // Enforce max file size to prevent DoS
    if (raw.length > MAX_CONFIG_FILE_SIZE) {
      const msg = `pi-ensemble permission-guard: ${label} config exceeds ${MAX_CONFIG_FILE_SIZE} bytes, skipping`;
      console.warn(msg);
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const rolesObj = parsed as { roles?: RoleConfig };
    return rolesObj.roles ?? {};
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") {
        // Missing file is normal — silent
        return {};
      }
      if (code === "EACCES" || code === "EPERM") {
        const msg = `pi-ensemble permission-guard: cannot read ${label} config (${err})`;
        console.warn(msg);
        return {};
      }
    }
    if (err instanceof SyntaxError) {
      const msg = `pi-ensemble permission-guard: ${label} config is not valid JSON (${err.message})`;
      console.warn(msg);
      return {};
    }
    // Other errors: trace for debugging
    trace(`pi-ensemble permission-guard: error loading ${label} config (${err})`);
    return {};
  }
}

function loadProjectConfig(): RoleConfig {
  const configPath = path.join(process.cwd(), ".pi", "permissions.json");
  try {
    // Resolve symlinks before reading
    const resolvedPath = require("node:fs").realpathSync(configPath);
    return loadConfigFile(resolvedPath, "project");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") {
        // Missing file is normal — silent
        return {};
      }
      if (code === "EACCES" || code === "EPERM") {
        const msg = `pi-ensemble permission-guard: cannot read project config (${err})`;
        console.warn(msg);
        return {};
      }
    }
    trace(`pi-ensemble permission-guard: error loading project config (${err})`);
    return {};
  }
}

function loadGlobalConfig(): RoleConfig {
  const configPath = path.join(os.homedir(), ".pi", "agent", "permissions.json");
  return loadConfigFile(configPath, "global");
}

export function resolveToolPermission(
  toolName: string,
  role: string,
  project: RoleConfig,
  global: RoleConfig,
  agents: Record<string, { permission?: Record<string, string | Record<string, string>> }>,
  bashCommand?: string,
): PermVerdict {
  // Helper to check a single config
  const checkConfig = (config: RoleConfig): PermVerdict | null => {
    const roleConfig = config[role];
    if (!roleConfig?.permission) return null;

    // Use shared helper: exact match first, then wildcard
    const verdict = lookupPermission(roleConfig.permission, toolName, bashCommand);
    if (verdict !== null) {
      if (verdict === "allow" || verdict === "deny" || verdict === "ask") {
        return verdict satisfies PermVerdict;
      }
      trace(`permission-guard: invalid verdict '${verdict}' in config, treating as deny`);
      return "deny";
    }
    return null;
  };

  // Layer 1: Project config (exact then wildcard)
  const projectResult = checkConfig(project);
  if (projectResult) return projectResult;

  // Layer 2: Global config (exact then wildcard)
  const globalResult = checkConfig(global);
  if (globalResult) return globalResult;

  // Layer 3: agents.json (reuse lookup helper)
  const agentsRoleConfig = agents[role];
  if (agentsRoleConfig?.permission) {
    const verdict = lookupPermission(agentsRoleConfig.permission, toolName, bashCommand);
    if (verdict !== null) {
      if (verdict === "allow" || verdict === "deny" || verdict === "ask") {
        return verdict;
      }
      // Invalid verdict: treat as deny and log
      trace(
        `pi-ensemble permission-guard: invalid verdict '${verdict}' for tool ${toolName}, treating as deny`,
      );
      return "deny";
    }
  }

  return "ask"; // No explicit rule → prompt in UI, deny in headless
}

export function isToolAllowedForRole(
  toolName: string,
  role: string,
  agentsConfig: Record<string, { permission?: Record<string, string | Record<string, string>> }>,
): boolean {
  const roleConfig = agentsConfig[role];
  if (!roleConfig?.permission) return false; // no config = deny

  // Use shared helper: exact match first, then wildcard
  const verdict = lookupPermission(roleConfig.permission, toolName);
  if (verdict !== null) {
    // "ask" treated as deny for subagents
    return verdict === "allow";
  }

  return false; // not mentioned = deny (deny-by-default)
}

export function decisionKey(toolName: string, args: unknown): string {
  try {
    return `${toolName}:${JSON.stringify(args ?? {}).slice(0, DECISION_KEY_MAX_ARGS)}`;
  } catch (err) {
    trace(`permission-guard: JSON.stringify args failed (${err}), falling back to type-only`);
  }
  try {
    return `${toolName}:${JSON.stringify({ type: typeof args }).slice(0, DECISION_KEY_MAX_ARGS)}`;
  } catch (err) {
    trace(`permission-guard: JSON.stringify fallback failed (${err}), using generic key`);
  }
  return `${toolName}:unknown`;
  // NOTE: This serializes entire args before truncating. Acceptable for typical tool args (<1KB).
  // Do NOT add custom replacer — over-engineering for this use case.
}

export function persistDecisions(
  decisionsMap: Map<string, { allowed: boolean; timestamp: string }>,
): void {
  const piDir = path.join(process.cwd(), ".pi");
  const decisionsPath = path.join(piDir, "decisions.json");
  const tmpPath = `${decisionsPath}.tmp`;

  try {
    // Ensure .pi/ exists with secure permissions in one call
    mkdirSync(piDir, { recursive: true, mode: 0o700 });

    // Evict oldest entries if over limit
    evictOldest(decisionsMap, MAX_CACHED_DECISIONS);

    // NOTE: writeFileSync blocks the event loop. Acceptable for now: decision writes are
    // <50KB and happen only on "always" choices (not every tool call). Do NOT refactor to async.
    const obj = Object.fromEntries(decisionsMap.entries());
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
    renameSync(tmpPath, decisionsPath);

    // Belt-and-braces chmod: log failure instead of silent catch
    try {
      chmodSync(decisionsPath, 0o600);
    } catch (err) {
      trace(
        `pi-ensemble permission-guard: chmod ${decisionsPath} failed (${err}) — file may have incorrect permissions`,
      );
    }
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to persist decisions (${err})`;
    console.warn(msg);
    trace(msg);

    // Clean up .tmp file if it exists (best-effort)
    try {
      // Use dynamic require to avoid importing fs at top level
      const fs = require("node:fs");
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Cleanup failure is acceptable — .tmp will be ignored next write
    }

    // Return without crashing
    return;
  }
}

export function registerPermissionGuard(pi: ExtensionAPI): void {
  // Parent Pi sessions don't set PI_ENSEMBLE_ROLE — only spawn.ts sets it for
  // subagent child processes (spec.role). In pi-ensemble's design the parent
  // process IS the orchestrator (project-manager), so resolve to that role at
  // the permission layer when no explicit role is set. There is no separate
  // "default" role anymore (issue #104) — the doctrine layer already aliased
  // default → project-manager via roles.ts, and the permission layer now does
  // the same so the parent process gets exactly the permissions its doctrine
  // prescribes.
  const role = process.env.PI_ENSEMBLE_ROLE ?? "project-manager";
  trace(
    `permission-guard: registering for role '${role}' (PI_ENSEMBLE_ROLE=${process.env.PI_ENSEMBLE_ROLE ?? "<unset>"})`,
  );
  const agentsConfig = loadAgentsJson();
  const projectConfig = loadProjectConfig();
  const globalConfig = loadGlobalConfig();

  // NOTE: Configs are loaded once per session by design. Restart Pi to pick up config changes.
  // Hot-reload adds complexity and race conditions and is out of scope for this PR.
  // Cache invalidation is also out of scope.

  // In-memory decisions cache
  const decisions = new Map<string, { allowed: boolean; timestamp: string }>();

  // Load decisions on session_start
  pi.on("session_start", async () => {
    const decisionsPath = path.join(process.cwd(), ".pi", "decisions.json");
    try {
      const raw = readFileSync(decisionsPath, "utf8");
      const parsed = JSON.parse(raw);
      let loaded = 0;
      let droppedMalformed = 0;
      let droppedStale = 0;
      let droppedOldFormat = 0;
      for (const [key, val] of Object.entries(parsed)) {
        if (key.length > DECISION_KEY_MAX_LENGTH) {
          trace(
            `pi-ensemble permission-guard: skipping over-length decision key: ${key.slice(0, 50)}...`,
          );
          droppedMalformed++;
          continue;
        }
        const shape = classifyDecisionKey(key);
        if (shape === "stale-tool") {
          trace(`pi-ensemble permission-guard: dropping stale tool decision: ${key}`);
          droppedStale++;
          continue;
        }
        if (shape === "old-format-full-input") {
          // Old-format full-input keys (`bash:{"command":"..."}`, `dispatch_specialist:{"cwd":...}`)
          // are tied to a literal input string. They never match a future
          // invocation that differs by a single character — dead weight that
          // bloats the cache without providing matches.
          trace(`pi-ensemble permission-guard: dropping old-format decision: ${key.slice(0, 50)}`);
          droppedOldFormat++;
          continue;
        }
        if (shape === "unsafe-pattern") {
          trace(
            `pi-ensemble permission-guard: skipping unsafe bash wildcard decision key: ${key.slice(0, 50)}...`,
          );
          droppedMalformed++;
          continue;
        }
        if (shape === "invalid") {
          trace(`pi-ensemble permission-guard: skipping invalid decision key: ${key.slice(0, 50)}`);
          droppedMalformed++;
          continue;
        }
        // Validate entry shape BEFORE casting
        if (val === null || typeof val !== "object") {
          trace(`permission-guard: skipping malformed decision for key: ${key.slice(0, 50)}`);
          droppedMalformed++;
          continue;
        }
        const entry = val as Record<string, unknown>;
        if (
          typeof entry.allowed !== "boolean" ||
          typeof entry.timestamp !== "string" ||
          entry.timestamp.length > 50
        ) {
          trace(`permission-guard: skipping malformed decision for key: ${key.slice(0, 50)}`);
          droppedMalformed++;
          continue;
        }
        decisions.set(key, { allowed: entry.allowed, timestamp: entry.timestamp });
        loaded++;
      }
      const dropped = droppedMalformed + droppedStale + droppedOldFormat;
      if (dropped > 0) {
        // Persist the cleaned cache so the next session sees a tidy file and
        // we don't repeatedly re-evaluate the same stale entries.
        persistDecisions(decisions);
        console.info(
          `pi-ensemble permission-guard: loaded ${loaded} decisions; dropped ${dropped} (` +
            `${droppedMalformed} malformed, ${droppedOldFormat} old-format, ${droppedStale} stale-tool)`,
        );
      } else {
        trace(`permission-guard: loaded ${loaded} cached decisions`);
      }
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: string }).code;
        if (code === "ENOENT") {
          // Missing file is normal on first run — silent
          return;
        }
        if (code === "EACCES") {
          const msg = `pi-ensemble permission-guard: cannot read decisions file (${err})`;
          console.warn(msg);
          return;
        }
      }
      if (err instanceof SyntaxError) {
        const msg = `pi-ensemble permission-guard: decisions file is not valid JSON (${err.message})`;
        console.warn(msg);
        return;
      }
      // Other errors: trace for debugging
      trace(`pi-ensemble permission-guard: error loading decisions (${err})`);
    }
  });

  trace(`permission-guard: active for role=${role}`);

  pi.on("tool_call", async (event, ctx) => {
    try {
      const command =
        event.toolName === "bash" ? ((event.input as { command?: string })?.command ?? "") : "";
      const verdict = resolveToolPermission(
        event.toolName,
        role,
        projectConfig,
        globalConfig,
        agentsConfig,
        event.toolName === "bash" ? command : undefined,
      );

      if (verdict === "allow") return; // allowed

      const bashAlwaysScope = event.toolName === "bash" ? getBashAlwaysScope(command) : null;

      // Check cached decisions — exact match first
      const key =
        event.toolName === "bash" && bashAlwaysScope === null
          ? buildExactBashDecisionKey(command)
          : decisionKey(event.toolName, event.input);
      const cached = decisions.get(key);
      if (cached !== undefined) {
        if (cached.allowed) return; // cached allow
        return {
          block: true,
          reason: `Tool '${event.toolName}' denied (cached decision)`,
        };
      }

      // Then check pattern matches (for bash "always" decisions)
      if (event.toolName === "bash") {
        for (const [patternKey, decision] of decisions) {
          if (!isSafeBashPatternKey(patternKey)) continue;
          const prefix = extractPatternPrefix(patternKey);
          if (bashPatternMatches(command, prefix)) {
            if (decision.allowed) return; // cached pattern allow
            return {
              block: true,
              reason: `Tool 'bash' denied (cached pattern: ${prefix} *)`,
            };
          }
        }
      }

      // For non-bash, also check tool-name-level decisions
      if (event.toolName !== "bash") {
        const toolLevelCached = decisions.get(event.toolName);
        if (toolLevelCached !== undefined) {
          if (toolLevelCached.allowed) return;
          return {
            block: true,
            reason: `Tool '${event.toolName}' denied (cached decision)`,
          };
        }
      }

      // For deny verdict (not ask), block immediately. Note: this is the
      // configured-deny path — verdict came from agents.json / project /
      // global config. We do NOT re-run the bash injection-vector check
      // here because matchBashSubcommand already enforces it (returns
      // "deny" for any bash command with `&&`, `|`, `$(...)`, redirects,
      // etc. outside quoted segments). Configured deny entries are
      // source-of-truth by design — if an operator wrote `"foo": "deny"`
      // they meant it regardless of how foo's input is shaped.
      if (verdict === "deny") {
        trace(`permission-guard: BLOCKED ${event.toolName} for role=${role} (verdict=deny)`);
        return {
          block: true,
          reason: `Tool '${event.toolName}' is not permitted for role '${role}'`,
        };
      }

      // verdict === "ask": prompt if UI, deny if headless
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Tool '${event.toolName}' requires approval (no UI available)`,
        };
      }

      // Prompt the user
      let argsPreview: string;
      try {
        argsPreview = JSON.stringify(event.input ?? {}).slice(0, 60);
      } catch {
        argsPreview = "[args]";
      }
      const message = `pi-ensemble [${role}]: ${event.toolName} ${argsPreview}`;

      let promptOptions: string[];
      if (event.toolName === "bash") {
        promptOptions = [
          "Allow once",
          getBashAlwaysPromptLabel("Allow always", command),
          "Deny once",
          getBashAlwaysPromptLabel("Deny always", command),
        ];
      } else {
        promptOptions = ["Allow once", "Allow always", "Deny once", "Deny always"];
      }

      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(message, promptOptions);
      } catch (err) {
        trace(`pi-ensemble permission-guard: ctx.ui.select failed for ${event.toolName} (${err})`);
        return { block: true, reason: `Tool '${event.toolName}' denied (UI error)` };
      }

      if (!choice) {
        return {
          block: true,
          reason: `Tool '${event.toolName}' denied (user cancelled)`,
        };
      }

      const allowed = choice === "Allow once" || choice.startsWith("Allow always");

      if (choice.startsWith("Allow always") || choice.startsWith("Deny always")) {
        const cacheKey =
          event.toolName === "bash"
            ? getBashDecisionCacheKey(command, event.input)
            : event.toolName;
        decisions.set(cacheKey, { allowed, timestamp: new Date().toISOString() });
        // Evict oldest entries if over limit
        evictOldest(decisions, MAX_CACHED_DECISIONS);
        persistDecisions(decisions);
      }

      if (!allowed) {
        return { block: true, reason: `Tool '${event.toolName}' denied by user` };
      }
    } catch (err) {
      // Unexpected error: deny and log
      trace(`permission-guard: internal error handling tool call (${err})`);
      return { block: true, reason: "Tool denied due to internal error" };
    }
  });
}
