#!/usr/bin/env bun
/**
 * Smoke test for permission-guard tool_call interceptor.
 *
 * Tests the three-layer config resolution without spawning Pi children.
 * Verifies:
 *   - Builtin tools are no longer bypassed (issue #50)
 *   - Three-layer resolution: project > global > agents.json > deny (issue #51)
 *   - Explicit builtin tool grants per role (issue #50)
 *   - Default role when PI_ENSEMBLE_ROLE is unset (issue #50)
 *   - Wildcard patterns work correctly
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isToolAllowedForRole,
  resolveToolPermission,
  BUILTIN_TOOLS,
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

let agentsConfig: Record<string, {
  permission?: Record<string, string | Record<string, string>>;
}>;
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

// === Issue #50 tests ===

// Test 1: isToolAllowedForRole("edit", "ops") returns false
const editDeniedForOps = isToolAllowedForRole("edit", "ops", agentsConfig);
assert(!editDeniedForOps, "Issue #50: edit is denied for ops role");

// Test 2: isToolAllowedForRole("edit", "developer") returns true
const editAllowedForDev = isToolAllowedForRole("edit", "developer", agentsConfig);
assert(editAllowedForDev, "Issue #50: edit is allowed for developer role");

// Test 3: isToolAllowedForRole("read", "adversarial-developer") returns true
const readAllowedForAdv = isToolAllowedForRole("read", "adversarial-developer", agentsConfig);
assert(readAllowedForAdv, "Issue #50: read is allowed for adversarial-developer role");

// Test 4: isToolAllowedForRole("write", "adversarial-developer") returns false
const writeDeniedForAdv = isToolAllowedForRole("write", "adversarial-developer", agentsConfig);
assert(!writeDeniedForAdv, "Issue #50: write is denied for adversarial-developer role");

// Test 5: Default role has explicit permissions
const readAllowedForDefault = isToolAllowedForRole("read", "default", agentsConfig);
assert(readAllowedForDefault, "Issue #50: read is allowed for default role");

// Test 6: Default role denies write
const writeDeniedForDefault = isToolAllowedForRole("write", "default", agentsConfig);
assert(!writeDeniedForDefault, "Issue #50: write is denied for default role");

// Test 7: All roles have explicit builtin tool grants (no bypass)
for (const role of ["project-manager", "developer", "ops", "code-review-specialist", "explore", "adversarial-developer", "default"]) {
  const readAllowed = isToolAllowedForRole("read", role, agentsConfig);
  assert(readAllowed, `Issue #50: read is explicitly allowed for ${role} (no bypass)`);
}

// Test 8: Wildcard patterns work correctly
const meadowAllowedForOps = isToolAllowedForRole("meadow_command", "ops", agentsConfig);
assert(meadowAllowedForOps, "Issue #50: wildcard pattern works (meadow* matches meadow_command for ops)");

// Test 9: Explicit deny overrides wildcard (parallel-search_* denied for ops)
const parallelSearchDeniedForOps = isToolAllowedForRole(
  "parallel-search_web_search_preview",
  "ops",
  agentsConfig,
);
assert(
  !parallelSearchDeniedForOps,
  "Issue #50: explicit deny blocks parallel-search_web_search_preview for ops",
);

// Test 10: Tool not mentioned is denied (deny-by-default)
const unknownToolDeniedForDev = isToolAllowedForRole("unknown_tool_12345", "developer", agentsConfig);
assert(
  !unknownToolDeniedForDev,
  "Issue #50: unknown tool denied for developer (deny-by-default)",
);

// === Issue #51 tests: three-layer resolution ===

const emptyProject: { roles: Record<string, { permission?: Record<string, "allow" | "deny" | "ask"> }> } = { roles: {} };
const emptyGlobal: typeof emptyProject = { roles: {} };

// Test 11: Project config overrides agents.json
const projectOverride: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        unknown_tool_12345: "allow", // Override deny-by-default
      },
    },
  },
};
const verdict11 = resolveToolPermission(
  "unknown_tool_12345",
  "developer",
  projectOverride.roles,
  emptyGlobal.roles,
  agentsConfig,
);
assert(verdict11 === "allow", "Issue #51: project config overrides agents.json (allow)");

const projectDenyOverride: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        edit: "deny", // Override agents.json allow
      },
    },
  },
};
const verdict11b = resolveToolPermission(
  "edit",
  "developer",
  projectDenyOverride.roles,
  emptyGlobal.roles,
  agentsConfig,
);
assert(verdict11b === "deny", "Issue #51: project config overrides agents.json (deny)");

// Test 12: Global config applies when no project entry
const globalConfig: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        another_unknown_tool: "allow",
      },
    },
  },
};
const verdict12 = resolveToolPermission(
  "another_unknown_tool",
  "developer",
  emptyProject.roles,
  globalConfig.roles,
  agentsConfig,
);
assert(verdict12 === "allow", "Issue #51: global config applies when no project entry");

// Test 13: agents.json applies when no global or project entry
const verdict13 = resolveToolPermission(
  "read",
  "developer",
  emptyProject.roles,
  emptyGlobal.roles,
  agentsConfig,
);
assert(verdict13 === "allow", "Issue #51: agents.json applies when no global or project entry");

// Test 14: Missing config files handled silently (empty objects)
const verdict14 = resolveToolPermission(
  "read",
  "developer",
  {}, // Missing project config
  {}, // Missing global config
  agentsConfig,
);
assert(verdict14 === "allow", "Issue #51: missing config files handled silently");

// Test 15: Wildcard patterns in project config
const projectWildcard: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        "test_*": "allow",
      },
    },
  },
};
const verdict15 = resolveToolPermission(
  "test_foo_bar",
  "developer",
  projectWildcard.roles,
  emptyGlobal.roles,
  agentsConfig,
);
assert(verdict15 === "allow", "Issue #51: wildcard pattern in project config works");

// Test 16: Exact match takes precedence over wildcard in same layer
const projectOrder: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        "test_*": "deny",
        "test_specific": "allow",
      },
    },
  },
};
const verdict16a = resolveToolPermission(
  "test_specific",
  "developer",
  projectOrder.roles,
  emptyGlobal.roles,
  agentsConfig,
);
assert(verdict16a === "allow", "Issue #51: exact match in project config overrides wildcard");

const verdict16b = resolveToolPermission(
  "test_other",
  "developer",
  projectOrder.roles,
  emptyGlobal.roles,
  agentsConfig,
);
assert(verdict16b === "deny", "Issue #51: wildcard in project config catches non-exact matches");

// Test 17: Project exact match, then project wildcard, then global exact, then global wildcard
const layeredTest: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        "layered_*": "deny",
        "layered_exact": "deny",
      },
    },
  },
};
const globalTest: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        "layered_*": "allow",
        "layered_global_only": "allow",
      },
    },
  },
};
const verdict17a = resolveToolPermission(
  "layered_exact",
  "developer",
  layeredTest.roles,
  globalTest.roles,
  agentsConfig,
);
assert(verdict17a === "deny", "Issue #51: project exact match beats project wildcard");

const verdict17b = resolveToolPermission(
  "layered_other",
  "developer",
  layeredTest.roles,
  globalTest.roles,
  agentsConfig,
);
assert(verdict17b === "deny", "Issue #51: project wildcard beats global exact/wildcard");

const verdict17c = resolveToolPermission(
  "layered_global_only",
  "developer",
  emptyProject.roles,
  globalTest.roles,
  agentsConfig,
);
assert(verdict17c === "allow", "Issue #51: global exact/wildcard beats agents.json");

console.log("\n=== test-permission-guard summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);