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
import { isToolAllowedForRole, resolveToolPermission } from "../src/permission-guard.js";

let exitCode = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

let agentsConfig: Record<
  string,
  {
    permission?: Record<string, string | Record<string, string>>;
  }
>;
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

// Test 5: project-manager role allows read (was "default" pre-#104 — same
// semantics; default merged into project-manager)
const readAllowedForPM = isToolAllowedForRole("read", "project-manager", agentsConfig);
assert(readAllowedForPM, "Issue #50: read is allowed for project-manager role");

// Test 6: project-manager denies write
const writeDeniedForPM = isToolAllowedForRole("write", "project-manager", agentsConfig);
assert(!writeDeniedForPM, "Issue #50: write is denied for project-manager role");

// Test 7: All roles have explicit builtin tool grants (no bypass).
// Issue #104: removed "default" role — only 6 roles remain.
for (const role of [
  "project-manager",
  "developer",
  "ops",
  "code-review-specialist",
  "explore",
  "adversarial-developer",
]) {
  const readAllowed = isToolAllowedForRole("read", role, agentsConfig);
  assert(readAllowed, `Issue #50: read is explicitly allowed for ${role} (no bypass)`);
}

// Test 7b: querying the removed "default" role returns false (deny-by-default
// for unknown roles). This is the visible behaviour change from #104 — if any
// caller still passes role="default", it fails closed.
const defaultRoleRemoved = isToolAllowedForRole("read", "default", agentsConfig);
assert(!defaultRoleRemoved, "Issue #104: default role removed → unknown-role queries return false");

// Test 8: Wildcard patterns work correctly (live agents.json — was meadow* pre-codebase-memory-mcp).
// PM has `"parallel-search*": "deny"`; verify the wildcard matches an arbitrary suffix.
// We assert on resolveToolPermission (not isToolAllowedForRole) so we can distinguish
// "wildcard hit and returned deny" from "no rule matched and defaulted to ask/deny".
const parallelSearchVerdict = resolveToolPermission(
  "parallel-search_some_new_tool",
  "project-manager",
  {},
  {},
  agentsConfig,
);
assert(
  parallelSearchVerdict === "deny",
  "Issue #50: wildcard pattern works (parallel-search* matches arbitrary suffix for PM, resolves to deny)",
);

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
const unknownToolDeniedForDev = isToolAllowedForRole(
  "unknown_tool_12345",
  "developer",
  agentsConfig,
);
assert(!unknownToolDeniedForDev, "Issue #50: unknown tool denied for developer (deny-by-default)");

// === Issue #51 tests: three-layer resolution ===

const emptyProject: {
  roles: Record<string, { permission?: Record<string, "allow" | "deny" | "ask"> }>;
} = { roles: {} };
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
        test_specific: "allow",
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
        layered_exact: "deny",
      },
    },
  },
};
const globalTest: typeof emptyProject = {
  roles: {
    developer: {
      permission: {
        "layered_*": "allow",
        layered_global_only: "allow",
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

// === Issue #96 tests: PM bare git allowlist ===
// Short-output git reads should be allowed bare; oo-wrapped equivalents are
// no longer redundantly granted (single source of truth per command).

const bareGitAllowed = [
  "git status",
  "git status --short",
  "git branch --show-current",
  "git worktree list",
  "git rev-parse HEAD",
  "git merge-base main HEAD",
  "git remote -v",
  "git tag --list",
  "git config --get user.email",
];
for (const command of bareGitAllowed) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(v === "allow", `Issue #96: bare \`${command}\` is allowed for project-manager`);
}

// Verbose-output git commands still require oo wrapper
const ooGitAllowed = [
  "oo git log --oneline -10",
  "oo git diff HEAD~1",
  "oo git show HEAD",
  "oo git shortlog -sn",
  "oo git rev-list --count HEAD",
  "oo git for-each-ref refs/heads",
];
for (const command of ooGitAllowed) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(v === "allow", `Issue #96: \`${command}\` is allowed for project-manager`);
}

// Now-redundant oo-wrapped variants of short commands are NOT in the allowlist
// (forces the bare canonical pattern). Bash catch-all migrated from `deny`
// to `ask` (closing #169's gap on the nested bash block) — these prompt the
// user rather than hard-denying. The bare canonical form is still the
// recommended idiom; the prompt is the safety net for novel inputs.
const ooGitAsked = [
  "oo git status",
  "oo git branch --show-current",
  "oo git worktree list",
  "oo git rev-parse HEAD",
];
for (const command of ooGitAsked) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #96: \`${command}\` prompts the user for project-manager (use bare form to skip prompt)`,
  );
}

// Write/mutation bash now prompts the user instead of hard-denying. Defense
// in depth for true injection vectors (`&&`, `|`, `$()`, redirects) is still
// hard-deny via matchBashSubcommand's injection check — see chainedShouldDeny
// below.
const bashAsked = ["git push origin main", "git commit -m foo", "rm -rf /"];
for (const command of bashAsked) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(v === "ask", `Issue #96: \`${command}\` prompts the user for project-manager`);
}

// Issue #104: `default` role removed. Calling resolveToolPermission with
// role="default" finds no role config → falls through to "ask" (not "allow").
// Parent Pi sessions now resolve to project-manager directly via the
// permission-guard fallback.
for (const command of ["git status", "git branch", "oo git log"]) {
  const v = resolveToolPermission("bash", "default", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #104: \`${command}\` for removed role 'default' falls through to ask (got: ${v})`,
  );
}

// === Issue #99 tests: PM ticket lifecycle direct via gh ===
// Bare gh for ticket CRUD (oo wrapping breaks gh issue / gh api | jq usage).

const ghIssueAllowed = [
  "gh issue create -t 'foo' -b 'bar'",
  "gh issue list --limit 15",
  "gh issue list --state open --label bug",
  "gh issue view 123",
  "gh issue view 123 -R randomm/pi-ensemble",
  "gh issue edit 123 --add-label triaged",
  "gh issue close 123",
  "gh issue reopen 123",
  "gh issue comment 123 -b 'thx'",
  "gh search issues 'is:open author:janni'",
  "gh api repos/randomm/pi-ensemble/issues/123",
];
for (const command of ghIssueAllowed) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(v === "allow", `Issue #99: \`${command}\` is allowed for project-manager`);
}

// PR mutations + CI re-runs prompt the user (ops territory — PM shouldn't
// do these silently, but per the post-#169 catch-all migration the user
// is in the loop rather than hard-blocked).
const ghOpsAsked = [
  "gh pr create",
  "gh pr merge 42",
  "gh pr close 42",
  "gh pr edit 42",
  "gh run rerun 12345",
];
for (const command of ghOpsAsked) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #99: \`${command}\` prompts the user for project-manager (ops territory)`,
  );
}

// Ghost `issue` / `pr` / `ci` tool grants are gone — those tool names resolve
// to "ask" (no explicit rule) rather than "allow" (which would prove the ghost
// grant survived the cleanup).
for (const ghostTool of ["issue", "pr", "ci"]) {
  for (const role of ["project-manager", "developer", "ops", "code-review-specialist", "explore"]) {
    const v = resolveToolPermission(ghostTool, role, {}, {}, agentsConfig);
    assert(
      v !== "allow",
      `Issue #99: ghost \`${ghostTool}\` permission removed from ${role} role (current verdict: ${v})`,
    );
  }
}

// === Issue #102 tests: PM read-only PR / CI inspection ===
// /start step 4 now runs in PM directly instead of dispatching to ops.

const ghPrCiReadAllowed = [
  "gh pr list",
  "gh pr list --state open",
  "gh pr view 42",
  "gh run list --branch main --limit 3",
  "gh run view 12345",
  "gh run watch 12345",
];
for (const command of ghPrCiReadAllowed) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(v === "allow", `Issue #102: read-only \`${command}\` is allowed for project-manager`);
}

// PR / CI mutations prompt the user for PM — see ghOpsAsked above for the
// reasoning behind the catch-all `deny` → `ask` migration.
const ghPrCiMutationAsked = [
  "gh pr create -t foo -b bar",
  "gh pr merge 42",
  "gh pr close 42",
  "gh pr edit 42 --add-label triaged",
  "gh pr ready 42",
  "gh run rerun 12345",
];
for (const command of ghPrCiMutationAsked) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #102: PR/CI mutation \`${command}\` prompts the user for project-manager (ops territory)`,
  );
}

// Chained commands fall through to the role's catch-all (`*: ask` for PM,
// default "ask" for the others). The parent prompts the user with the full
// command visible — even if every chain segment is individually allow-listed
// we still ask because the chain shape itself could hide intent. The cache
// side refuses to wildcard injection-vector commands (see bashPatternMatches),
// so "Allow always" stores only the exact hash; a *different* chain reshapes
// and re-prompts. The user is the trust boundary, not the matcher (#188+).
const chainedShouldAsk = [
  "git status && git branch",
  "git status; git branch",
  "git status | head -5",
  "gh issue list | grep open",
  "cd /tmp && git status",
];
for (const command of chainedShouldAsk) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(v === "ask", `Issue #102+#188: chained \`${command}\` prompts the user (PM catch-all)`);
}

console.log("\n=== test-permission-guard summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);
