import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROLE_NAMES } from "./roles.js";
import { trace } from "./trace.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Built-in Pi tool names — never block these
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

function loadAgentsJson(): Record<
  string,
  { permission?: Record<string, string | Record<string, string>> }
> {
  const agentsPath = path.resolve(__dirname, "../../..", "agents.json");
  try {
    const raw = readFileSync(agentsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.agent ?? {};
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to load agents.json (${err}) — all non-builtin tools will be blocked`;
    console.warn(msg);
    trace(msg);
    return {};
  }
}

function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export function isToolAllowedForRole(
  toolName: string,
  role: string,
  agentsConfig: Record<string, { permission?: Record<string, string | Record<string, string>> }>,
): boolean {
  if (BUILTIN_TOOLS.has(toolName)) return true;
  const roleConfig = agentsConfig[role];
  if (!roleConfig?.permission) return false; // no config = deny non-builtins
  for (const [pattern, verdict] of Object.entries(roleConfig.permission)) {
    // Skip nested objects (like 'bash') at this level
    if (typeof verdict === "object") continue;
    if (matchesPattern(pattern, toolName)) return verdict === "allow"; // "ask" treated as deny for subagents
  }
  return false; // not mentioned = deny (deny-by-default)
}

export function registerPermissionGuard(pi: ExtensionAPI): void {
  const role = process.env.PI_ENSEMBLE_ROLE;
  if (!role) {
    trace("permission-guard: no PI_ENSEMBLE_ROLE set, skipping");
    return;
  }
  if (!(ROLE_NAMES as readonly string[]).includes(role)) {
    trace(`permission-guard: unknown role '${role}', blocking all non-builtin tools`);
    pi.on("tool_call", (event) => {
      if (!BUILTIN_TOOLS.has(event.toolName)) {
        trace(`permission-guard: BLOCKED ${event.toolName} (unknown role '${role}')`);
        return { block: true, reason: `Unknown role '${role}' — all non-builtin tools blocked` };
      }
    });
    return;
  }
  const agentsConfig = loadAgentsJson();
  trace(`permission-guard: active for role=${role}`);

  pi.on("tool_call", (event) => {
    const allowed = isToolAllowedForRole(event.toolName, role, agentsConfig);
    if (!allowed) {
      trace(`permission-guard: BLOCKED ${event.toolName} for role=${role}`);
      return {
        block: true,
        reason: `Tool '${event.toolName}' is not permitted for role '${role}'`,
      };
    }
  });
}
