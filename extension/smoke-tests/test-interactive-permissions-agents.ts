#!/usr/bin/env bun
/**
 * Smoke test for interactive permissions (issue #52), split out of
 * test-interactive-permissions.ts (#171, AGENTS.md §12 file-size limit):
 *   - nested bash-subcommand allowlist recursion (#76)
 *   - real agents.json load-at-runtime regression guards (#83/#85)
 *   - persistDecisions: .pi/ + decisions.json creation, file permissions
 *     (0700/0600), atomic-write .tmp cleanup, 501-entry eviction
 *
 * No Pi children spawned.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  decisionKey,
  loadAgentsJson,
  persistDecisions,
  resolveAgentsJsonPath,
  resolveToolPermission,
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

console.log("=== test-interactive-permissions-agents summary ===\n");

// Temp directory for testing
const tmpDir = path.join(process.cwd(), "test-tmp-permissions-agents");
const piDir = path.join(tmpDir, ".pi");
const decisionsPath = path.join(piDir, "decisions.json");
const originalCwd = process.cwd();

// Cleanup before tests
if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true, force: true });
}
mkdirSync(tmpDir, { recursive: true });

// === #76: nested bash subcommand allowlist recursion ===
// agents.json shape: { agent: { default: { permission: { bash: { ... } } } } }.
// resolveToolPermission must consult the nested allowlist for bash tool calls.
const defaultAgentsConfig = {
  default: {
    permission: {
      bash: {
        "*": "deny",
        "vipune *": "allow",
        "vipune add *": "allow",
        "oo git status*": "allow",
        "echo*": "allow",
      },
      read: "allow",
    },
  },
};
const emptyConfig = {};
assert(
  resolveToolPermission(
    "bash",
    "default",
    emptyConfig,
    emptyConfig,
    defaultAgentsConfig,
    "vipune add 'anything goes here'",
  ) === "allow",
  "nested allowlist: vipune add * matches quoted-arg command",
);
assert(
  resolveToolPermission(
    "bash",
    "default",
    emptyConfig,
    emptyConfig,
    defaultAgentsConfig,
    "vipune search foo bar",
  ) === "allow",
  "nested allowlist: broader vipune * matches when no narrower rule applies",
);
assert(
  resolveToolPermission(
    "bash",
    "default",
    emptyConfig,
    emptyConfig,
    defaultAgentsConfig,
    "oo git status --short",
  ) === "allow",
  "nested allowlist: legacy 'pattern*' form (no space) still matches",
);
assert(
  resolveToolPermission(
    "bash",
    "default",
    emptyConfig,
    emptyConfig,
    defaultAgentsConfig,
    "rm -rf /tmp/foo",
  ) === "deny",
  "nested allowlist: catch-all '*' deny applies when no specific rule matches",
);
assert(
  resolveToolPermission(
    "bash",
    "default",
    emptyConfig,
    emptyConfig,
    defaultAgentsConfig,
    "vipune add foo && rm bar",
  ) === "ask",
  "nested allowlist: injection-vector command falls through to ask — the user reads the full chain and decides (#188+). Cache wildcard expansion still refuses to wildcard these; 'Allow always' stores only the exact-hash key, so a different chain re-prompts.",
);
assert(
  resolveToolPermission("read", "default", emptyConfig, emptyConfig, defaultAgentsConfig) ===
    "allow",
  "non-bash top-level lookup still works (read = allow)",
);
// Longest-prefix-wins: `vipune add *` should beat `vipune *` for vipune add.
const longestPrefixConfig = {
  default: {
    permission: {
      bash: {
        "vipune *": "deny",
        "vipune add *": "allow",
      },
    },
  },
};
assert(
  resolveToolPermission(
    "bash",
    "default",
    emptyConfig,
    emptyConfig,
    longestPrefixConfig,
    "vipune add foo",
  ) === "allow",
  "nested allowlist: longest-prefix wins (specific rule beats broader)",
);

// === #83 regression guard — agents.json must actually load at runtime ===
// Bug history: from PR #53 (2026-05-26) through PR #81 (2026-05-28),
// loadAgentsJson resolved agentsPath with one ".." too many ("../../.." from
// extension/src/), landing in the parent of the repo where no agents.json
// exists. readFileSync threw, the catch returned {}, and every tool call
// fell through to "ask". Symptom on the user side: every command prompts
// even when agents.json declares it auto-allowed.
//
// Stub-based tests in this file didn't catch it because they construct the
// agents config inline. This assertion exercises the real file-loading
// path and would have caught the regression.
const resolvedAgentsPath = resolveAgentsJsonPath();
assert(
  path.basename(resolvedAgentsPath) === "agents.json",
  `resolveAgentsJsonPath() resolves to agents.json at checkout root (got: ${resolvedAgentsPath})`,
);
assert(
  existsSync(resolvedAgentsPath),
  `resolved agents.json actually exists on disk (got: ${resolvedAgentsPath})`,
);
const liveAgents = loadAgentsJson();
const liveRoleNames = Object.keys(liveAgents);
assert(
  liveRoleNames.length >= 5,
  `loadAgentsJson() returns the role config (got ${liveRoleNames.length} roles: ${liveRoleNames.join(", ")})`,
);
// #104 removed the "default" role from agents.json — parent Pi sessions now
// resolve to "project-manager" directly via the permission-guard fallback
// (permission-guard.ts:771 `process.env.PI_ENSEMBLE_ROLE ?? "project-manager"`).
// Tests that used to assert `liveAgents.default` now assert against PM.
assert(
  liveAgents["project-manager"] !== undefined,
  "loadAgentsJson() returns the 'project-manager' role used by top-level Pi sessions (default → project-manager per #104)",
);
const livePmBash = (
  liveAgents["project-manager"]?.permission as { bash?: Record<string, unknown> } | undefined
)?.bash;
assert(
  typeof livePmBash === "object" && livePmBash !== null,
  "project-manager role's permission.bash is the nested allowlist (not a string verdict)",
);
assert(
  Object.keys(livePmBash ?? {}).length >= 10,
  `project-manager role's bash allowlist has multiple patterns (got ${Object.keys(livePmBash ?? {}).length})`,
);
// End-to-end: with the real config loaded, common bash commands declared in
// agents.json should resolve to "allow" without ever touching the cache.
// PM has bare `git status*` not `oo git status*` per the bare-vs-oo doctrine
// (bare for content-need / short output; oo for verbose-wrap). Subagent
// roles like developer/ops carry the oo-wrapped variant.
assert(
  resolveToolPermission(
    "bash",
    "project-manager",
    emptyConfig,
    emptyConfig,
    liveAgents,
    "git status",
  ) === "allow",
  "real agents.json: bare 'git status' resolves to allow for PM via nested allowlist",
);
assert(
  resolveToolPermission(
    "bash",
    "project-manager",
    emptyConfig,
    emptyConfig,
    liveAgents,
    'vipune add "anything"',
  ) === "allow",
  "real agents.json: quoted-arg vipune add resolves to allow via nested allowlist",
);

// === #85 regression guard — pi-ensemble's own dispatch tools must always be ===
// === granted for the top-level session, otherwise the PM can't orchestrate. ===
// Bug history: PR #50 removed the BUILTIN_TOOLS runtime bypass. agents.json
// needed to be updated to grant pi-ensemble's own dispatch tools, but it
// wasn't. The gap was hidden by PR #53's path-resolution bug (#83), which
// prevented agents.json from loading at all. Once #84 fixed the loader,
// every /work invocation broke because dispatch_parallel / dispatch_lens_review
// got denied.
const dispatchTools = [
  "dispatch_specialist",
  "dispatch_parallel",
  "dispatch_lens_review",
  "dispatch_status",
  "dispatch_kill",
  "adversarial_loop",
];
// #104 removed "default" role; project-manager is the only top-level role now.
for (const tool of dispatchTools) {
  assert(
    resolveToolPermission(tool, "project-manager", emptyConfig, emptyConfig, liveAgents) ===
      "allow",
    `real agents.json: project-manager role grants ${tool}`,
  );
}

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
    assert("tool:500" in parsed, "Newest entry present after evict");
    // Oldest (lowest index number) should be evicted
    assert(!("tool:0" in parsed), "Oldest entry evicted");
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

console.log("\n=== test-interactive-permissions-agents summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);
