/**
 * pi-ensemble permission interceptor — owns the `tool_call` hook that
 * decides allow/deny/ask for every tool the parent agent invokes.
 *
 * Two concerns live here today (refactor tracker: #171 — bash-command
 * parsing moved to bash-command-parser.ts, the decision cache moved to
 * permission-decision-cache.ts, and 3-layer config loading moved to
 * permission-config.ts):
 *
 *   1. Permission resolution — `resolveToolPermission` and
 *      `lookupPermission`. Tool-name wildcards: exact match → longest
 *      prefix → `"*"` catch-all (#168). Bash subcommands use the same
 *      specificity rule via `matchBashSubcommand` (bash-command-parser.ts).
 *
 *   2. Orchestration — `registerPermissionGuard` hooks `tool_call`,
 *      prompts the user via `ctx.ui.select` when verdict is "ask" and a
 *      UI exists, hard-denies "ask" in headless mode. This is the only
 *      cluster that touches Pi's `ExtensionAPI` surface (`pi.on(...)`,
 *      `ctx.ui.select`, `ctx.hasUI`).
 *
 * Headless safety: `"ask"` verdicts hard-deny when `!ctx.hasUI`, so
 * automation never silently approves anything. Bash commands with
 * injection vectors hard-deny at the matcher level — they never reach
 * the prompt.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  extractCommandPrefix,
  matchBashSubcommand,
  tokenizeForPrefix,
} from "./bash-command-parser.ts";
import { registerIssueCreationGuard } from "./issue-creation-guard.ts";
import type { BrokerDeps, PermissionRequest } from "./permission-broker.ts";
import {
  findProjectConfigPath,
  loadAgentsJson,
  loadGlobalConfig,
  loadProjectConfig,
  resolveAgentsJsonPath,
} from "./permission-config.ts";
import type { PermVerdict, RoleConfig } from "./permission-config.ts";
import {
  MAX_CACHED_DECISIONS,
  bashPatternMatches,
  decisionKey,
  evictOldest,
  getBashAlwaysPromptLabel,
  getBashAlwaysScope,
  getBashDecisionCacheKey,
  loadPersistedDecisions,
  lookupCachedBrokerDecision,
  lookupCachedToolDecision,
  persistCachedBrokerDecision,
  persistDecisions,
} from "./permission-decision-cache.ts";
import { registerSubagentGuard } from "./permission-subagent-guard.ts";
import { ROLE_NAMES } from "./roles.js";
import { trace } from "./trace.js";

// Re-export the public surface that used to live directly in this file —
// callers (spawn.ts, index.ts, smoke tests) import these from
// "./permission-guard.ts" and must keep working unchanged.
export type { PermVerdict, RoleConfig };
export { findProjectConfigPath, loadAgentsJson, resolveAgentsJsonPath };
export { extractCommandPrefix, tokenizeForPrefix };
export {
  bashPatternMatches,
  decisionKey,
  getBashAlwaysPromptLabel,
  getBashAlwaysScope,
  getBashDecisionCacheKey,
  persistDecisions,
};

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
  // so tool-level and bash-subcommand patterns behave the same way.
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

// Captured by registerPermissionGuard for the broker — set when the parent
// Pi session starts; null in subagent mode (subagents never broker for anyone).
// Use `makeBrokerDeps()` from outside this file to get the typed deps wrapper
// that closes over `decisions` + `parentCtx` + persistDecisions.
// biome-ignore lint/suspicious/noExplicitAny: ExtensionCommandContext is the runtime ctx Pi passes to event handlers; not exported as a type from the public API.
let parentCtx: any = null;
let brokerDepsFactory: (() => BrokerDeps) | null = null;

/**
 * Trust mode — pi-ensemble does NOT enforce per-call permissions when there's
 * no boundary worth enforcing. Three cases:
 *
 *   1. Sandbox (PI_ENSEMBLE_SANDBOX_MODE=1) — container fence isolates; we
 *      already trust the container, not the per-call gate.
 *   2. Interactive host (hasUI=true, no strict opt-in) — the parent runs as
 *      the user's own UID with the user's own credentials. Per-call prompts
 *      provide ZERO meaningful protection (the agent already has full FS /
 *      network / credential access) but emit ~30 prompts/minute, training
 *      users to rubber-stamp and degrading attention on prompts that DO
 *      matter. Honest answer: trust the agent or don't run it.
 *   3. Headless (no UI) — STAYS strict. No human present to consent, so
 *      `ask` verdicts hard-deny. CI/cron contexts where the agent runs
 *      without a person in the loop are genuinely adversarial threat
 *      surfaces; the deny is meaningful.
 *
 * Opt-in escape hatch: PI_ENSEMBLE_STRICT_PERMISSIONS=1 restores the legacy
 * ask-flow for users who actively want it back in interactive host mode.
 */
export function isInTrustMode(hasUI: boolean): boolean {
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") return true;
  if (process.env.PI_ENSEMBLE_TRUST_MODE === "1") return true;
  if (process.env.PI_ENSEMBLE_STRICT_PERMISSIONS === "1") return false;
  return hasUI;
}

/**
 * Read parent's trust-mode status for spawn.ts. parentCtx is captured at
 * session_start; if it's missing (very early spawn), assume strict to fail
 * safe — the subagent will then use the broker fallback, which is correct.
 */
export function isParentInTrustMode(): boolean {
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") return true;
  if (process.env.PI_ENSEMBLE_STRICT_PERMISSIONS === "1") return false;
  return parentCtx?.hasUI === true;
}

/**
 * Returns the BrokerDeps closure for spawn.ts to wire a per-spawn permission
 * broker against. Returns null when called from a subagent process (where
 * registerSubagentGuard ran instead of the parent guard) or before the
 * parent session has started. Decisions cache + persistence write-through +
 * UI prompts all reuse the parent guard's existing state.
 */
export function makeBrokerDeps(): BrokerDeps | null {
  return brokerDepsFactory ? brokerDepsFactory() : null;
}

export function registerPermissionGuard(pi: ExtensionAPI): void {
  // Mode-independent issue-creation guard: registered BEFORE the sandbox
  // short-circuit, the subagent-mode firewall, and the trust-mode bypass in
  // the tool_call handler — following the registerDestructiveGitGuard
  // precedent (permission-subagent-guard.ts). A hook placed after any of
  // those would, in practice, never run: sandbox mode short-circuits this
  // entire function and trust mode (the default on an interactive host)
  // short-circuits the handler itself. Direct `gh issue create` (and the
  // `gh api` POST-to-issues-collection second door) is gated behind
  // start_plan_driver (#598); the driver files via direct execp and never
  // passes through this hook.
  registerIssueCreationGuard(pi);

  // Sandbox-mode short-circuit (PR #197). Inside the Docker sandbox (set by
  // the `pi-ensemble` wrapper / .devcontainer.json) the container fence IS
  // the trust boundary. No per-call prompts, no broker, no overlay loading.
  // The parent Pi session has no UI gating, the user types in the TUI
  // directly. agents.json entries become inert at runtime (still rendered
  // into prompts for documentation; just not enforced).
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") {
    trace("permission-guard: PI_ENSEMBLE_SANDBOX_MODE=1 — bypassing all tool gating");
    return;
  }

  // Subagent-mode firewall: when spawn.ts forwards pi-ensemble into a subagent
  // it also sets PI_ENSEMBLE_SUBAGENT_MODE=1. The subagent's pi-ensemble load
  // should ONLY register the permission-guard (no dispatch tools, no slash
  // commands) — index.ts handles the registration firewall; here we install a
  // minimal tool_call handler that escalates `ask` verdicts to the parent
  // over a Unix socket (per-spawn path in PI_ENSEMBLE_PERM_SOCKET).
  if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1") {
    registerSubagentGuard(pi);
    return;
  }
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
  pi.on("session_start", async (_event, ctx) => {
    // Capture ctx for the subagent-permission broker — the broker fires user
    // prompts asynchronously (when a subagent escalates an "ask"), so it can't
    // get ctx via an event parameter the way the tool_call handler does.
    parentCtx = ctx;
    const decisionsPath = path.join(process.cwd(), ".pi", "decisions.json");
    loadPersistedDecisions(decisionsPath, decisions);
  });

  trace(`permission-guard: active for role=${role}`);

  // Expose the broker-deps factory now that the closure is built. spawn.ts
  // calls makeBrokerDeps() per spawn to get this wrapper, then starts a
  // permission-broker against it. The subagent's permission-guard escalates
  // `ask` verdicts over the per-spawn socket; the broker calls into here to
  // reuse the SAME decisions cache + persistDecisions write-through + UI
  // prompts that the parent's tool_call handler uses.
  brokerDepsFactory = () => ({
    cachedLookup(req: PermissionRequest): boolean | undefined {
      return lookupCachedBrokerDecision(decisions, req);
    },
    persistDecision(req: PermissionRequest, allowed: boolean): void {
      persistCachedBrokerDecision(decisions, req, allowed);
    },
    async promptUser(
      req: PermissionRequest,
    ): Promise<{ allowed: boolean; scope: "once" | "always" }> {
      if (!parentCtx || !parentCtx.hasUI) {
        throw new Error("headless: no parent UI to prompt against");
      }
      const argsPreview =
        req.toolName === "bash" && req.bashCommand
          ? req.bashCommand.slice(0, 60)
          : `(${req.toolName})`;
      const message = `pi-ensemble [${req.role}] (subagent): ${req.toolName} ${argsPreview}`;
      const promptOptions =
        req.toolName === "bash"
          ? [
              "Allow once",
              getBashAlwaysPromptLabel("Allow always", req.bashCommand ?? ""),
              "Deny once",
              getBashAlwaysPromptLabel("Deny always", req.bashCommand ?? ""),
            ]
          : ["Allow once", "Allow always", "Deny once", "Deny always"];
      const choice = await parentCtx.ui.select(message, promptOptions);
      if (!choice) throw new Error("user cancelled");
      const allowed = choice === "Allow once" || choice.startsWith("Allow always");
      const scope: "once" | "always" =
        choice.startsWith("Allow always") || choice.startsWith("Deny always") ? "always" : "once";
      return { allowed, scope };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      // Trust-mode short-circuit (see isInTrustMode for rationale). Interactive
      // host + sandbox both bypass; headless + strict-opt-in fall through to
      // the legacy verdict / prompt flow.
      if (isInTrustMode(ctx.hasUI === true)) return;
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

      // Check cached decisions — exact match, then bash pattern ("always")
      // matches, then non-bash tool-name-level cache.
      const cachedResult = lookupCachedToolDecision(
        decisions,
        event.toolName,
        command,
        event.input,
      );
      if (cachedResult) {
        if (cachedResult.allowed) return;
        return { block: true, reason: cachedResult.reason };
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
