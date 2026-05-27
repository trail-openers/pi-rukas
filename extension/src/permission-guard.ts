import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROLE_NAMES } from "./roles.js";
import { trace } from "./trace.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Type definitions
export type PermVerdict = "allow" | "deny" | "ask";
type PermPattern = Record<string, PermVerdict | Record<string, PermVerdict>>;
export type RoleConfig = Record<string, { permission?: PermPattern }>;

// Constants
const DECISION_KEY_MAX_ARGS = 200;
const DECISION_KEY_MAX_LENGTH = 250;
const MAX_CACHED_DECISIONS = 500;
const MAX_CONFIG_FILE_SIZE = 1 * 1024 * 1024; // 1MB

// Helper: evict oldest entries from a decisions map
function evictOldest(map: Map<string, { allowed: boolean; timestamp: string }>, max: number): void {
  if (map.size <= max) return;
  const sorted = [...map.entries()].sort((a, b) => b[1].timestamp.localeCompare(a[1].timestamp));
  map.clear();
  for (const [k, v] of sorted.slice(0, max)) map.set(k, v);
}

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

// Helper: lookup a tool in permission entries, exact match first then wildcard
// Permission entries: string verdicts or nested objects (e.g. bash subcommands)
function lookupPermission(
  entries: Record<string, string | Record<string, string>>,
  toolName: string,
): string | null {
  // Check exact match first
  const exactMatch = entries[toolName];
  if (exactMatch !== undefined && typeof exactMatch === "string") {
    return exactMatch;
  }

  // Check wildcard match
  for (const [pattern, verdict] of Object.entries(entries)) {
    if (typeof verdict !== "string") continue; // Skip nested objects
    if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) {
      return verdict;
    }
  }

  return null;
}

// agents.json ships with the repo, so ENOENT is unexpected and should warn.
// In contrast, project/global config ENOENT is silent (user may not have created them).
function loadAgentsJson(): Record<
  string,
  { permission?: Record<string, string | Record<string, string>> }
> {
  const agentsPath = path.resolve(__dirname, "../../..", "agents.json");
  try {
    const raw = readFileSync(agentsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as {
      agent?: Record<string, { permission?: Record<string, string | Record<string, string>> }>;
    };
    return obj.agent ?? {};
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to load agents.json (${err}) — non-builtin tools will require interactive approval (or be blocked in headless mode)`;
    console.warn(msg);
    trace(msg);
    return {};
  }
}

function loadConfigFile(configPath: string, label: string): RoleConfig {
  try {
    const raw = readFileSync(configPath, "utf8");

    // Enforce max file size to prevent DoS
    if (raw.length > MAX_CONFIG_FILE_SIZE) {
      const msg = `pi-ensemble permission-guard: ${label} config exceeds ${MAX_CONFIG_FILE_SIZE} bytes, skipping`;
      console.warn(msg);
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const rolesObj = parsed as { roles?: RoleConfig };
    return rolesObj.roles ?? {};
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") {
        // Missing file is normal — silent
        return {};
      }
      if (code === "EACCES" || code === "EPERM") {
        const msg = `pi-ensemble permission-guard: cannot read ${label} config (${err})`;
        console.warn(msg);
        return {};
      }
    }
    if (err instanceof SyntaxError) {
      const msg = `pi-ensemble permission-guard: ${label} config is not valid JSON (${err.message})`;
      console.warn(msg);
      return {};
    }
    // Other errors: trace for debugging
    trace(`pi-ensemble permission-guard: error loading ${label} config (${err})`);
    return {};
  }
}

function loadProjectConfig(): RoleConfig {
  const configPath = path.join(process.cwd(), ".pi", "permissions.json");
  try {
    // Resolve symlinks before reading
    const resolvedPath = require("node:fs").realpathSync(configPath);
    return loadConfigFile(resolvedPath, "project");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") {
        // Missing file is normal — silent
        return {};
      }
      if (code === "EACCES" || code === "EPERM") {
        const msg = `pi-ensemble permission-guard: cannot read project config (${err})`;
        console.warn(msg);
        return {};
      }
    }
    trace(`pi-ensemble permission-guard: error loading project config (${err})`);
    return {};
  }
}

function loadGlobalConfig(): RoleConfig {
  const configPath = path.join(os.homedir(), ".pi", "agent", "permissions.json");
  return loadConfigFile(configPath, "global");
}

export function resolveToolPermission(
  toolName: string,
  role: string,
  project: RoleConfig,
  global: RoleConfig,
  agents: Record<string, { permission?: Record<string, string | Record<string, string>> }>,
): PermVerdict {
  // Helper to check a single config
  const checkConfig = (config: RoleConfig): PermVerdict | null => {
    const roleConfig = config[role];
    if (!roleConfig?.permission) return null;

    // Use shared helper: exact match first, then wildcard
    const verdict = lookupPermission(roleConfig.permission, toolName);
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
    const verdict = lookupPermission(agentsRoleConfig.permission, toolName);
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

export function isToolAllowedForRole(
  toolName: string,
  role: string,
  agentsConfig: Record<string, { permission?: Record<string, string | Record<string, string>> }>,
): boolean {
  const roleConfig = agentsConfig[role];
  if (!roleConfig?.permission) return false; // no config = deny

  // Use shared helper: exact match first, then wildcard
  const verdict = lookupPermission(roleConfig.permission, toolName);
  if (verdict !== null) {
    // "ask" treated as deny for subagents
    return verdict === "allow";
  }

  return false; // not mentioned = deny (deny-by-default)
}

export function decisionKey(toolName: string, args: unknown): string {
  try {
    return `${toolName}:${JSON.stringify(args ?? {}).slice(0, DECISION_KEY_MAX_ARGS)}`;
  } catch (err) {
    trace(`permission-guard: JSON.stringify args failed (${err}), falling back to type-only`);
  }
  try {
    return `${toolName}:${JSON.stringify({ type: typeof args }).slice(0, DECISION_KEY_MAX_ARGS)}`;
  } catch (err) {
    trace(`permission-guard: JSON.stringify fallback failed (${err}), using generic key`);
  }
  return `${toolName}:unknown`;
  // NOTE: This serializes entire args before truncating. Acceptable for typical tool args (<1KB).
  // Do NOT add custom replacer — over-engineering for this use case.
}

export function persistDecisions(
  decisionsMap: Map<string, { allowed: boolean; timestamp: string }>,
): void {
  const piDir = path.join(process.cwd(), ".pi");
  const decisionsPath = path.join(piDir, "decisions.json");
  const tmpPath = `${decisionsPath}.tmp`;

  try {
    // Ensure .pi/ exists with secure permissions in one call
    mkdirSync(piDir, { recursive: true, mode: 0o700 });

    // Evict oldest entries if over limit
    evictOldest(decisionsMap, MAX_CACHED_DECISIONS);

    // NOTE: writeFileSync blocks the event loop. Acceptable for now: decision writes are
    // <50KB and happen only on "always" choices (not every tool call). Do NOT refactor to async.
    const obj = Object.fromEntries(decisionsMap.entries());
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
    renameSync(tmpPath, decisionsPath);

    // Belt-and-braces chmod: log failure instead of silent catch
    try {
      chmodSync(decisionsPath, 0o600);
    } catch (err) {
      trace(
        `pi-ensemble permission-guard: chmod ${decisionsPath} failed (${err}) — file may have incorrect permissions`,
      );
    }
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to persist decisions (${err})`;
    console.warn(msg);
    trace(msg);

    // Clean up .tmp file if it exists (best-effort)
    try {
      // Use dynamic require to avoid importing fs at top level
      const fs = require("node:fs");
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Cleanup failure is acceptable — .tmp will be ignored next write
    }

    // Return without crashing
    return;
  }
}

export function registerPermissionGuard(pi: ExtensionAPI): void {
  const role = process.env.PI_ENSEMBLE_ROLE ?? "default";
  const agentsConfig = loadAgentsJson();
  const projectConfig = loadProjectConfig();
  const globalConfig = loadGlobalConfig();

  // NOTE: Configs are loaded once per session by design. Restart Pi to pick up config changes.
  // Hot-reload adds complexity and race conditions and is out of scope for this PR.
  // Cache invalidation is also out of scope.

  // In-memory decisions cache
  const decisions = new Map<string, { allowed: boolean; timestamp: string }>();

  // Load decisions on session_start
  pi.on("session_start", async () => {
    const decisionsPath = path.join(process.cwd(), ".pi", "decisions.json");
    try {
      const raw = readFileSync(decisionsPath, "utf8");
      const parsed = JSON.parse(raw);
      let loaded = 0;
      for (const [key, val] of Object.entries(parsed)) {
        // Validate key format
        if (!key.includes(":") || key.length > DECISION_KEY_MAX_LENGTH) {
          trace(
            `pi-ensemble permission-guard: skipping invalid decision key: ${key.slice(0, 50)}...`,
          );
          continue;
        }
        // Validate entry shape BEFORE casting
        if (val === null || typeof val !== "object") {
          trace(`permission-guard: skipping malformed decision for key: ${key.slice(0, 50)}`);
          continue;
        }
        const entry = val as Record<string, unknown>;
        if (
          typeof entry.allowed !== "boolean" ||
          typeof entry.timestamp !== "string" ||
          entry.timestamp.length > 50
        ) {
          trace(`permission-guard: skipping malformed decision for key: ${key.slice(0, 50)}`);
          continue;
        }
        decisions.set(key, { allowed: entry.allowed, timestamp: entry.timestamp });
        loaded++;
      }
      trace(`permission-guard: loaded ${loaded} cached decisions`);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: string }).code;
        if (code === "ENOENT") {
          // Missing file is normal on first run — silent
          return;
        }
        if (code === "EACCES") {
          const msg = `pi-ensemble permission-guard: cannot read decisions file (${err})`;
          console.warn(msg);
          return;
        }
      }
      if (err instanceof SyntaxError) {
        const msg = `pi-ensemble permission-guard: decisions file is not valid JSON (${err.message})`;
        console.warn(msg);
        return;
      }
      // Other errors: trace for debugging
      trace(`pi-ensemble permission-guard: error loading decisions (${err})`);
    }
  });

  trace(`permission-guard: active for role=${role}`);

  pi.on("tool_call", async (event, ctx) => {
    try {
      const verdict = resolveToolPermission(
        event.toolName,
        role,
        projectConfig,
        globalConfig,
        agentsConfig,
      );

      if (verdict === "allow") return; // allowed

      // Check cached decisions first (for both deny and ask)
      const key = decisionKey(event.toolName, event.input);
      const cached = decisions.get(key);
      if (cached !== undefined) {
        if (cached.allowed) return; // cached allow
        return {
          block: true,
          reason: `Tool '${event.toolName}' denied (cached decision)`,
        };
      }

      // For deny verdict (not ask), block immediately
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

      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(message, [
          "Allow once",
          "Allow always",
          "Deny once",
          "Deny always",
        ]);
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

      const allowed = choice === "Allow once" || choice === "Allow always";

      if (choice === "Allow always" || choice === "Deny always") {
        decisions.set(key, { allowed, timestamp: new Date().toISOString() });
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
