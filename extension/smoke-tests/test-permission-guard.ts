#!/usr/bin/env bun
/**
 * Smoke test for permission-guard tool_call interceptor.
 *
 * Tests the pure functions from permission-guard.ts without spawning Pi children.
 * Verifies:
 *   - Built-in tools are always allowed
 *   - Tools allowed in agents.json for a role are permitted
 *   - Deny-by-default: tools not mentioned are denied
 *   - Tools explicitly denied for a role are blocked
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { isToolAllowedForRole, BUILTIN_TOOLS } from "../src/permission-guard.js";

let exitCode = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}


let agentsConfig: Record<string, { permission?: Record<string, string | Record<string, string>> }>;
try {
  const __filename = new URL(import.meta.url).pathname;
  const __dirname = path.dirname(__filename);
  const agentsPath = path.resolve(__dirname, "..", "..", "agents.json");
  const agentsRaw = readFileSync(agentsPath, "utf8");
  const agentsParsed = JSON.parse(agentsRaw);
  agentsConfig = agentsParsed.agent ?? {};
} catch (err) {
  assert(false, `Failed to load agents.json: ${err}`);
  process.exit(1);
}

console.log("=== test-permission-guard summary ===\n");

// Test 1: Built-in tools are always allowed regardless of role
for (const tool of BUILTIN_TOOLS) {
  const allowed = isToolAllowedForRole(tool, "project-manager", agentsConfig);
  assert(allowed, `Test 1: built-in tool '${tool}' allowed for project-manager`);
}

// Test 2: context7 (wildcard) - allowed for explore at top level
// In agents.json, explore role has "ctx7 *": "allow" under bash, but the permission guard
// checks top-level keys. At top level, explore has "vipune": "allow" at the top level.
const allowedForVipune = isToolAllowedForRole("vipune", "explore", agentsConfig);
assert(allowedForVipune, "Test 2: vipune allowed for explore role (top-level wildcard)");

// Test 3: An MCP tool NOT in agents.json for adversarial-developer → blocked (deny-by-default)
// adversarial-developer has no explicit allow for an unknown MCP tool like "mcp_unknown_tool"
const allowedUnknownMCP = isToolAllowedForRole(
  "mcp_unknown_tool",
  "adversarial-developer",
  agentsConfig,
);
assert(
  !allowedUnknownMCP,
  "Test 3: unknown MCP tool 'mcp_unknown_tool' BLOCKED for adversarial-developer (deny-by-default)",
);

// Test 4: A tool explicitly denied for a role → blocked
// ops role has "parallel-search_web_search_preview": "deny"
const deniedForOps = isToolAllowedForRole(
  "parallel-search_web_search_preview",
  "ops",
  agentsConfig,
);
assert(
  !deniedForOps,
  "Test 4: parallel-search_web_search_preview blocked for ops (explicitly denied)",
);

// Test 5: Tool explicitly allowed for a role → allowed
// ops role has "meadow*": "allow"
const allowedForOps = isToolAllowedForRole("meadow_command", "ops", agentsConfig);
assert(allowedForOps, "Test 5: meadow_command allowed for ops (explicitly allowed with wildcard)");

// Test 6: Wildcard patterns work correctly
// ops role has "meadow*": "allow" at the top level (not nested under bash)
// This should match "meadow_command" which starts with "meadow"
const allowedWildcard = isToolAllowedForRole("meadow_command", "explore", agentsConfig);
assert(allowedWildcard, "Test 6: wildcard pattern works (meadow* matches meadow_command)");

// Test 7: Role with no permission config → non-builtin tools blocked by default
// Create a mock role that doesn't exist in agents.json
const allowedForUnknownRole = isToolAllowedForRole("some_tool", "nonexistent_role", agentsConfig);
assert(!allowedForUnknownRole, "Test 7: non-builtin tool BLOCKED for role with no permission config");

console.log("\n=== test-permission-guard summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);