#!/usr/bin/env bun
/**
 * Smoke test for interactive permissions (issue #52): decisionKey format,
 * extractCommandPrefix (incl. #78 wrapper-stripping smarts), quoted-argument
 * wildcard-scope normalization, and the registerPermissionGuard session_start
 * cache-cleanup round-trip. No Pi children spawned.
 *
 * agents.json-loading regressions (#83/#85) and persistDecisions/eviction/
 * file-permission tests live in test-interactive-permissions-agents.ts
 * (#171, AGENTS.md §12 file-size split).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  bashPatternMatches,
  decisionKey,
  extractCommandPrefix,
  getBashAlwaysPromptLabel,
  getBashAlwaysScope,
  getBashDecisionCacheKey,
  registerPermissionGuard,
} from "../src/permission-guard.js";

let exitCode = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

console.log("=== test-interactive-permissions summary ===\n");

// Temp directory for testing
const tmpDir = path.join(process.cwd(), "test-tmp-permissions");
const piDir = path.join(tmpDir, ".pi");
const decisionsPath = path.join(piDir, "decisions.json");

// Cleanup before tests
if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true, force: true });
}
mkdirSync(tmpDir, { recursive: true });

// === Tests ===

// Test 1: decisionKey generates correct format
const key1 = decisionKey("bash", { command: "ls -la" });
const expectedKey1 = `bash:{"command":"ls -la"}`;
assert(key1 === expectedKey1, "decisionKey generates tool:args format");

const key2 = decisionKey("read", { path: "/tmp/file.txt" });
const expectedKey2 = `read:{"path":"/tmp/file.txt"}`;
assert(key2 === expectedKey2, "decisionKey handles different tools");

// Test 3: decisionKey truncates args to 200 chars
const longArgs = { x: "a".repeat(300) };
const key3 = decisionKey("test", longArgs);
assert(key3.length < 220, "decisionKey truncates long args to 200 chars"); // "test:" + 200 chars

// Test 4: decisionKey handles undefined args
const key4 = decisionKey("test", undefined);
const expectedKey4 = "test:{}";
assert(key4 === expectedKey4, "decisionKey handles undefined args");

// Test 5: decisionKey handles null args
const key5 = decisionKey("test", null);
const expectedKey5 = "test:{}";
assert(key5 === expectedKey5, "decisionKey handles null args");

// === extractCommandPrefix tests ===

// Test: extractCommandPrefix("oo gh pr diff 53") returns "oo gh pr"
const prefix1 = extractCommandPrefix("oo gh pr diff 53");
assert(prefix1 === "oo gh pr", "extractCommandPrefix extracts oo gh pr from 'oo gh pr diff 53'");

// Test: extractCommandPrefix("git status --porcelain") returns "git status"
const prefix2 = extractCommandPrefix("git status --porcelain");
assert(prefix2 === "git status", "extractCommandPrefix extracts git status from 'git status --porcelain'");

// Test: extractCommandPrefix("ls -la /tmp") returns "ls"
const prefix3 = extractCommandPrefix("ls -la /tmp");
assert(prefix3 === "ls", "extractCommandPrefix extracts ls from 'ls -la /tmp'");

// Test: extractCommandPrefix("echo hello") returns "echo" (echo is not a
// multi-subcommand CLI, so the prefix is single-token).
const prefix4 = extractCommandPrefix("echo hello");
assert(prefix4 === "echo", "extractCommandPrefix returns single-token prefix for non-multi-subcommand CLIs");

// Test: extractCommandPrefix("") returns "bash" (fallback)
const prefix5 = extractCommandPrefix("");
assert(prefix5 === "bash", "extractCommandPrefix returns 'bash' for empty string");

// Quoted-argument commands now produce wildcard scopes. This is the whole
// point of the post-#75 redesign: quote characters in arguments are not
// injection vectors and should not defeat the "Allow always" cache.
const quotedCommand = 'vipune search "key';
const globCommand = "ls *.ts";
const cpGlobCommand = "cp src/* dist/";
const longQuotedA = `${quotedCommand} ${"a".repeat(60)}`;
const longQuotedB = `${quotedCommand} ${"b".repeat(60)}`;
const blankCommand = "   ";
const safeCommand = "git status --porcelain";
// Commands containing real injection vectors still refuse wildcard scope.
const injectionCommand = "vipune search foo && rm bar";

assert(
  getBashAlwaysScope(quotedCommand) === "vipune search",
  "quoted argument extracts wildcard scope (vipune search)",
);
assert(getBashAlwaysScope(globCommand) === "ls", "glob in argument extracts wildcard scope (ls)");
assert(
  getBashAlwaysScope(cpGlobCommand) === "cp",
  "asterisk in argument extracts wildcard scope (cp)",
);
assert(
  getBashAlwaysScope(injectionCommand) === null,
  "injection-vector command refuses wildcard scope",
);
assert(getBashAlwaysScope(blankCommand) === null, "blank bash command refuses wildcard scope");
assert(
  getBashAlwaysScope(safeCommand) === "git status",
  "safe bash command normalizes to prefix scope",
);
assert(
  getBashAlwaysPromptLabel("Allow always", quotedCommand) === "Allow always (vipune search *)",
  "quoted-arg command renders normalized wildcard label",
);
assert(
  getBashAlwaysPromptLabel("Deny always", globCommand) === "Deny always (ls *)",
  "glob-arg command renders normalized wildcard label",
);
assert(
  getBashAlwaysPromptLabel("Allow always", injectionCommand) === "Allow always",
  "injection-vector command renders bare label (no scope)",
);
assert(
  getBashAlwaysPromptLabel("Allow always", safeCommand) === "Allow always (git status *)",
  "safe bash command renders normalized wildcard label",
);
const quotedKey = getBashDecisionCacheKey(quotedCommand, { command: quotedCommand });
const globKey = getBashDecisionCacheKey(globCommand, { command: globCommand });
const injectionKey = getBashDecisionCacheKey(injectionCommand, { command: injectionCommand });
const blankKey = getBashDecisionCacheKey(blankCommand, { command: blankCommand });
assert(quotedKey === "bash:vipune search *", "quoted-arg command persists wildcard key");
assert(globKey === "bash:ls *", "glob-arg command persists wildcard key");
assert(injectionKey.startsWith("bash:exact:"), "injection-vector command falls back to exact-hash key");
assert(blankKey.startsWith("bash:exact:"), "blank bash command falls back to exact-hash key");
assert(
  getBashDecisionCacheKey(safeCommand, { command: safeCommand }) === "bash:git status *",
  "safe bash command persists wildcard key",
);
assert(
  bashPatternMatches("git status --porcelain", "git status"),
  "boundary-safe wildcard matches command with suffix",
);
assert(
  !bashPatternMatches("git status --porcelain; rm -rf /", "git status"),
  "boundary-safe wildcard rejects compound shell commands",
);
assert(!bashPatternMatches("git statusx", "git status"), "boundary-safe wildcard rejects glued suffix");
assert(
  !bashPatternMatches("git status --porcelain", "git statusx"),
  "boundary-safe wildcard rejects mismatched prefix",
);
assert(
  getBashDecisionCacheKey(longQuotedA, { command: longQuotedA }) ===
    getBashDecisionCacheKey(longQuotedB, { command: longQuotedB }),
  "long quoted variants share the same wildcard key (the whole point of the redesign)",
);

const originalCwd = process.cwd();
// Mixed fixture exercises all known shapes the session_start cleanup must
// handle. After load, only the entries marked KEEP should remain.
const mixedDecisionFixture = {
  // DROP: malformed pattern (quote in prefix; isSafeBashPatternKey rejects).
  "bash:vipune search \"key *": { allowed: true, timestamp: "2024-01-01T00:00:00Z" },
  // DROP: old-format full-input bash key (JSON.stringify input shape).
  'bash:{"command":"some old command"}': {
    allowed: true,
    timestamp: "2024-01-01T00:00:10Z",
  },
  // DROP: old-format full-input non-bash key.
  'dispatch_specialist:{"cwd":"/some/path","prompt":"do a thing"}': {
    allowed: true,
    timestamp: "2024-01-01T00:00:20Z",
  },
  // DROP: stale tool name (pair_watch removed in #65/#70).
  pair_watch: { allowed: true, timestamp: "2024-01-01T00:00:30Z" },
  // KEEP: clean wildcard pattern.
  "bash:git status *": { allowed: true, timestamp: "2024-01-01T00:01:00Z" },
  // KEEP: clean wildcard pattern (verifies quoted-arg case is recovered).
  "bash:vipune search *": { allowed: true, timestamp: "2024-01-01T00:01:10Z" },
  // KEEP: tool-name-level non-bash grant (verifies the round-trip bug fix).
  dispatch_specialist: { allowed: true, timestamp: "2024-01-01T00:01:20Z" },
};

mkdirSync(piDir, { recursive: true, mode: 0o700 });
writeFileSync(decisionsPath, JSON.stringify(mixedDecisionFixture, null, 2));
assert(existsSync(decisionsPath), "cached JSON fixture written for load-time validation");

const registeredHandlers = new Map<string, (() => Promise<void> | void)[]>();
const fakePi = {
  on(event: string, handler: () => Promise<void> | void) {
    const handlers = registeredHandlers.get(event) ?? [];
    handlers.push(handler);
    registeredHandlers.set(event, handlers);
  },
} as unknown as { on: (event: string, handler: () => Promise<void> | void) => void };

try {
  process.chdir(tmpDir);
  registerPermissionGuard(fakePi);
  const sessionStartHandler = registeredHandlers.get("session_start")?.[0];
  await sessionStartHandler?.();
  const toolCallHandler = registeredHandlers.get("tool_call")?.[0];

  // Clean wildcard pattern + quoted argument: should allow without prompting,
  // because `bash:vipune search *` is in the cache and `vipune search "anything"`
  // extracts to that prefix at match time. This is THE bug from #75 — verify
  // it's gone.
  const quotedAllowed = await toolCallHandler?.(
    { toolName: "bash", input: { command: 'vipune search "different text"' } },
    { hasUI: false },
  );
  assert(
    quotedAllowed === undefined,
    "quoted-arg command matches cached wildcard pattern (the #75 fix)",
  );

  // Clean wildcard pattern matches its own command space.
  const safeAllowed = await toolCallHandler?.(
    { toolName: "bash", input: { command: safeCommand } },
    { hasUI: false },
  );
  assert(safeAllowed === undefined, "safe cached wildcard entry allows matching command");

  // Tool-name-level grant survives the round-trip and matches future calls
  // regardless of input shape.
  const toolLevelAllowed = await toolCallHandler?.(
    { toolName: "dispatch_specialist", input: { cwd: "/different", prompt: "new task" } },
    { hasUI: false },
  );
  assert(
    toolLevelAllowed === undefined,
    "tool-name-level grant for dispatch_specialist matches any input (round-trip works)",
  );

  // Stale tool name `pair_watch` was dropped on load — a fresh call to it
  // should fall through to ask/deny rather than hit the dropped cache entry.
  // (We can't easily assert the drop directly without exposing internals;
  // instead, verify the in-memory decisions file no longer contains it.)
  const reloaded = JSON.parse(readFileSync(decisionsPath, "utf8"));
  assert(reloaded.pair_watch === undefined, "stale pair_watch entry purged from cache file");
  assert(
    reloaded['bash:{"command":"some old command"}'] === undefined,
    "old-format full-input bash entry purged from cache file",
  );
  assert(
    reloaded['dispatch_specialist:{"cwd":"/some/path","prompt":"do a thing"}'] === undefined,
    "old-format full-input non-bash entry purged from cache file",
  );
  assert(
    reloaded['bash:vipune search "key *'] === undefined,
    "malformed wildcard entry purged from cache file",
  );
  assert(reloaded.dispatch_specialist !== undefined, "tool-name grant retained in cache file");
  assert(
    reloaded["bash:vipune search *"] !== undefined,
    "clean wildcard pattern retained in cache file",
  );
} catch (err) {
  assert(false, `registerPermissionGuard failed to load cached JSON fixture: ${err}`);
} finally {
  process.chdir(originalCwd);
}

const blankFixture = { bash: { command: "   " } };
assert(
  getBashDecisionCacheKey("   ", blankFixture) === blankKey,
  "blank command reuses the exact bash cache key",
);

// Security: command separators stop prefix extraction
assert(extractCommandPrefix("git; rm -rf /") === "git", "extractCommandPrefix stops at semicolon");
assert(extractCommandPrefix("echo $(whoami)") === "echo", "extractCommandPrefix stops at $()");
assert(extractCommandPrefix("echo `whoami`") === "echo", "extractCommandPrefix stops at backtick");
assert(extractCommandPrefix("cmd1 && cmd2") === "cmd1", "extractCommandPrefix stops at &&");
assert(extractCommandPrefix("cmd1 || cmd2") === "cmd1", "extractCommandPrefix stops at ||");

// === #78: smarter extractCommandPrefix ===
// Wrapper-strip + multi-subcommand handling + oo-recursion + triple-level.
assert(
  extractCommandPrefix('vipune add "lorem ipsum dolor"') === "vipune add",
  "quoted argument transparent; vipune is multi-subcommand → 2 tokens",
);
assert(
  extractCommandPrefix('git commit -m "long message"') === "git commit",
  "git commit -m 'msg' → git commit",
);
assert(extractCommandPrefix("timeout 30 npm test") === "npm test", "timeout wrapper stripped");
assert(extractCommandPrefix("nice -n 10 cargo build") === "cargo build", "nice -n N wrapper stripped");
assert(
  extractCommandPrefix("nohup ./long-running") === "bash",
  "nohup wrapper stripped; path token has no extractable prefix → fallback to 'bash'",
);
assert(
  extractCommandPrefix("nohup npm test") === "npm test",
  "nohup wrapper stripped; inner multi-subcommand tool extracted",
);
assert(
  extractCommandPrefix("GOEXPERIMENT=synctest go test ./...") === "go test",
  "env-var assignment stripped",
);
assert(
  extractCommandPrefix("npm run lint -- 'x'") === "npm run lint",
  "triple-level run-style → 3 tokens",
);
assert(
  extractCommandPrefix("cargo run --release") === "cargo run",
  "cargo run with no script falls back to 2 tokens (no third clean token)",
);
assert(
  extractCommandPrefix("oo git status --short") === "oo git status",
  "oo recurses into inner tool (git → 2 tokens) → 3 total",
);
assert(
  extractCommandPrefix("oo gh issue view 63") === "oo gh issue",
  "oo gh issue view → oo gh issue (3 tokens)",
);
assert(
  extractCommandPrefix("myrandomtool foo bar baz") === "myrandomtool",
  "unknown CLI returns single-token prefix only",
);

// Cleanup
if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log("\n=== test-interactive-permissions summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);
