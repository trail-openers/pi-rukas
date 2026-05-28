#!/usr/bin/env bun
/**
 * Smoke test for interactive permissions (issue #52).
 *
 * Tests the pure functions without spawning Pi children:
 *   - decisionKey generates correct format
 *   - persistDecisions writes to .pi/decisions.json (use a temp directory)
 *   - 501 decisions → oldest evicted, only 500 remain
 *   - File permissions: .pi/ at 0700, decisions.json at 0600
 *   - Atomic write: verify .tmp file is cleaned up
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  bashPatternMatches,
  decisionKey,
  extractCommandPrefix,
  getBashAlwaysPromptLabel,
  getBashAlwaysScope,
  getBashDecisionCacheKey,
  persistDecisions,
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

// Test: extractCommandPrefix("echo hello") returns "echo hello"
const prefix4 = extractCommandPrefix("echo hello");
assert(prefix4 === "echo hello", "extractCommandPrefix extracts full command from 'echo hello'");

// Test: extractCommandPrefix("") returns "bash" (fallback)
const prefix5 = extractCommandPrefix("");
assert(prefix5 === "bash", "extractCommandPrefix returns 'bash' for empty string");

// Unsafe bash scopes fall back to exact command caching
const unsafeQuotedCommand = 'vipune search "key';
const unsafeGlobCommand = "ls *.ts";
const unsafeCpCommand = "cp src/* dist/";
const unsafeLongCommandA = `${unsafeQuotedCommand} ${"a".repeat(260)}`;
const unsafeLongCommandB = `${unsafeQuotedCommand} ${"b".repeat(260)}`;
const blankCommand = "   ";
const safeCommand = "git status --porcelain";

assert(getBashAlwaysScope(unsafeQuotedCommand) === null, "unsafe quoted bash command falls back to exact caching");
assert(getBashAlwaysScope(unsafeGlobCommand) === null, "glob-heavy bash command falls back to exact caching");
assert(getBashAlwaysScope(unsafeCpCommand) === null, "asterisk-containing bash command falls back to exact caching");
assert(getBashAlwaysScope(blankCommand) === null, "blank bash command falls back to exact caching");
assert(getBashAlwaysScope(safeCommand) === "git status", "safe bash command normalizes to prefix scope");
assert(
  getBashAlwaysPromptLabel("Allow always", unsafeQuotedCommand) === "Allow always",
  "unsafe quoted bash command never renders malformed label",
);
assert(
  getBashAlwaysPromptLabel("Deny always", unsafeGlobCommand) === "Deny always",
  "glob-heavy bash command never renders malformed label",
);
assert(
  getBashAlwaysPromptLabel("Allow always", safeCommand) === "Allow always (git status *)",
  "safe bash command renders normalized wildcard label",
);
const unsafeQuotedKey = getBashDecisionCacheKey(unsafeQuotedCommand, { command: unsafeQuotedCommand });
const unsafeGlobKey = getBashDecisionCacheKey(unsafeGlobCommand, { command: unsafeGlobCommand });
const blankKey = getBashDecisionCacheKey(blankCommand, { command: blankCommand });
assert(unsafeQuotedKey.startsWith("bash:"), "unsafe quoted bash command uses a bash cache key");
assert(!unsafeQuotedKey.endsWith(" *"), "unsafe quoted bash command does not use wildcard scope");
assert(unsafeGlobKey.startsWith("bash:"), "glob-heavy bash command uses a bash cache key");
assert(!unsafeGlobKey.endsWith(" *"), "glob-heavy bash command does not use wildcard scope");
assert(blankKey.startsWith("bash:"), "blank bash command uses a bash cache key");
assert(!blankKey.endsWith(" *"), "blank bash command does not use wildcard scope");
assert(getBashDecisionCacheKey(safeCommand, { command: safeCommand }) === "bash:git status *", "safe bash command persists wildcard key");
assert(bashPatternMatches("git status --porcelain", "git status"), "boundary-safe wildcard matches command with suffix");
assert(!bashPatternMatches("git status --porcelain; rm -rf /", "git status"), "boundary-safe wildcard rejects compound shell commands");
assert(!bashPatternMatches("git statusx", "git status"), "boundary-safe wildcard rejects glued suffix");
assert(!bashPatternMatches("git status --porcelain", "git statusx"), "boundary-safe wildcard rejects mismatched prefix");
assert(
  getBashDecisionCacheKey(unsafeLongCommandA, { command: unsafeLongCommandA }) !==
    getBashDecisionCacheKey(unsafeLongCommandB, { command: unsafeLongCommandB }),
  "unsafe exact-cache keys remain unique for long commands",
);

const originalCwd = process.cwd();
const staleDecisionFixture = {
  "bash:vipune search \"key *": { allowed: true, timestamp: "2024-01-01T00:00:00Z" },
  [unsafeQuotedKey]: { allowed: true, timestamp: "2024-01-01T00:00:10Z" },
  [getBashDecisionCacheKey(unsafeLongCommandA, { command: unsafeLongCommandA })]: {
    allowed: true,
    timestamp: "2024-01-01T00:00:30Z",
  },
  "bash:git status *": { allowed: true, timestamp: "2024-01-01T00:01:00Z" },
};

mkdirSync(piDir, { recursive: true, mode: 0o700 });
writeFileSync(decisionsPath, JSON.stringify(staleDecisionFixture, null, 2));
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
  const unsafeResult = await toolCallHandler?.(
    { toolName: "bash", input: { command: unsafeQuotedCommand } },
    { hasUI: false },
  );
  assert(unsafeResult === undefined, "exact cached unsafe command is allowed after load");
  const malformedWildcardResult = await toolCallHandler?.(
    { toolName: "bash", input: { command: `${unsafeQuotedCommand} extra` } },
    { hasUI: false },
  );
  assert(
    malformedWildcardResult && typeof malformedWildcardResult === "object" && "block" in malformedWildcardResult,
    "malformed wildcard cache entry is skipped on load and does not allow a matching command",
  );
  const safeResult = await toolCallHandler?.(
    { toolName: "bash", input: { command: safeCommand } },
    { hasUI: false },
  );
  assert(safeResult === undefined, "safe cached wildcard entry still allows matching command");
} catch (err) {
  assert(false, `registerPermissionGuard failed to load cached JSON fixture: ${err}`);
} finally {
  process.chdir(originalCwd);
}

const blankFixture = { bash: { command: "   " } };
assert(getBashDecisionCacheKey("   ", blankFixture) === blankKey, "blank command reuses the exact bash cache key");

// Security: command separators stop prefix extraction
assert(extractCommandPrefix("git; rm -rf /") === "git", "extractCommandPrefix stops at semicolon");
assert(extractCommandPrefix("echo $(whoami)") === "echo", "extractCommandPrefix stops at $()");
assert(extractCommandPrefix("echo `whoami`") === "echo", "extractCommandPrefix stops at backtick");
assert(extractCommandPrefix("cmd1 && cmd2") === "cmd1", "extractCommandPrefix stops at &&");
assert(extractCommandPrefix("cmd1 || cmd2") === "cmd1", "extractCommandPrefix stops at ||");

// Test 6: persistDecisions creates .pi/ directory
const decisions = new Map<string, { allowed: boolean; timestamp: string }>();
decisions.set("bash:ls", { allowed: true, timestamp: "2024-01-01T00:00:00Z" });

try {
  process.chdir(tmpDir);
  persistDecisions(decisions);
  process.chdir(originalCwd);
} catch (err) {
  process.chdir(originalCwd);
  assert(false, `persistDecisions failed: ${err}`);
}

assert(existsSync(piDir), "persistDecisions creates .pi/ directory");

// Test 7: .pi/ directory has 0700 permissions
if (existsSync(piDir)) {
  const piStat = statSync(piDir);
  const piPerms = piStat.mode & 0o777;
  assert(piPerms === 0o700, ".pi/ directory has 0700 permissions");
} else {
  assert(false, ".pi/ directory does not exist for permission check");
}

// Test 8: decisions.json is created
assert(existsSync(decisionsPath), "persistDecisions creates decisions.json");

// Test 9: decisions.json has 0600 permissions
if (existsSync(decisionsPath)) {
  const fileStat = statSync(decisionsPath);
  const filePerms = fileStat.mode & 0o777;
  assert(filePerms === 0o600, "decisions.json has 0600 permissions");
} else {
  assert(false, "decisions.json does not exist for permission check");
}

// Test 10: decisions.json content is correct JSON
if (existsSync(decisionsPath)) {
  try {
    const raw = readFileSync(decisionsPath, "utf8");
    const parsed = JSON.parse(raw);
    assert(parsed["bash:ls"]?.allowed === true, "decisions.json contains correct data");
  } catch (err) {
    assert(false, `decisions.json is valid JSON: ${err}`);
  }
} else {
  assert(false, "decisions.json does not exist for content check");
}

// Test 11: .tmp file is cleaned up (atomic write)
const tmpPath = `${decisionsPath}.tmp`;
assert(!existsSync(tmpPath), "Atomic write cleans up .tmp file");

// Test 12: 501 decisions evicts oldest (only 500 remain)
const manyDecisions = new Map<string, { allowed: boolean; timestamp: string }>();
for (let i = 0; i < 501; i++) {
  manyDecisions.set(`tool:${i}`, {
    allowed: i % 2 === 0,
    timestamp: `2024-01-01T00:${String(i).padStart(2, "0")}:00Z`,
  });
}

try {
  process.chdir(tmpDir);
  persistDecisions(manyDecisions);
  process.chdir(originalCwd);
} catch (err) {
  process.chdir(originalCwd);
  assert(false, `persistDecisions with 501 entries failed: ${err}`);
}

if (existsSync(decisionsPath)) {
  try {
    const raw = readFileSync(decisionsPath, "utf8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed);
    assert(keys.length === 500, "Max 500 entries enforced (oldest evicted)");
    // Newest (highest index number) should be present
    assert(`tool:500` in parsed, "Newest entry present after evict");
    // Oldest (lowest index number) should be evicted
    assert(!(`tool:0` in parsed), "Oldest entry evicted");
  } catch (err) {
    assert(false, `Checking 501 decisions eviction failed: ${err}`);
  }
} else {
  assert(false, "decisions.json does not exist for eviction check");
}

// Test 13: Multiple decisions persist correctly
const multiDecisions = new Map<string, { allowed: boolean; timestamp: string }>();
multiDecisions.set("bash:ls", { allowed: true, timestamp: "2024-01-01T00:00:00Z" });
multiDecisions.set("read:file", { allowed: false, timestamp: "2024-01-01T00:01:00Z" });
multiDecisions.set("edit:other", { allowed: true, timestamp: "2024-01-01T00:02:00Z" });

try {
  process.chdir(tmpDir);
  persistDecisions(multiDecisions);
  process.chdir(originalCwd);
} catch (err) {
  process.chdir(originalCwd);
  assert(false, `persistDecisions with multiple entries failed: ${err}`);
}

if (existsSync(decisionsPath)) {
  try {
    const raw = readFileSync(decisionsPath, "utf8");
    const parsed = JSON.parse(raw);
    assert(Object.keys(parsed).length === 3, "Multiple decisions persist correctly");
    assert(parsed["bash:ls"]?.allowed === true, "bash:ls decision correct");
    assert(parsed["read:file"]?.allowed === false, "read:file decision correct");
    assert(parsed["edit:other"]?.allowed === true, "edit:other decision correct");
  } catch (err) {
    assert(false, `Checking multiple decisions failed: ${err}`);
  }
} else {
  assert(false, "decisions.json does not exist for multiple decisions check");
}

// Test 14: Empty Map creates empty decisions.json
const emptyDecisions = new Map<string, { allowed: boolean; timestamp: string }>();

try {
  process.chdir(tmpDir);
  persistDecisions(emptyDecisions);
  process.chdir(originalCwd);
} catch (err) {
  process.chdir(originalCwd);
  assert(false, `persistDecisions with empty map failed: ${err}`);
}

if (existsSync(decisionsPath)) {
  try {
    const raw = readFileSync(decisionsPath, "utf8");
    const parsed = JSON.parse(raw);
    assert(Object.keys(parsed).length === 0, "Empty Map creates empty decisions.json");
  } catch (err) {
    assert(false, `Checking empty decisions failed: ${err}`);
  }
} else {
  assert(false, "decisions.json does not exist for empty decisions check");
}

// Test 15: decisionKey with complex args
const complexArgs = {
  nested: { value: [1, 2, 3] },
  flag: true,
  str: "hello",
};
const key6 = decisionKey("complex", complexArgs);
assert(key6.startsWith("complex:"), "decisionKey handles complex nested args");
assert(key6.includes("nested"), "decisionKey includes nested data");

// Cleanup
if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log("\n=== test-interactive-permissions summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);