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

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  existsSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import {
  decisionKey,
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

// Test 6: persistDecisions creates .pi/ directory
const decisions = new Map<string, { allowed: boolean; timestamp: string }>();
decisions.set("bash:ls", { allowed: true, timestamp: "2024-01-01T00:00:00Z" });

const originalCwd = process.cwd();
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