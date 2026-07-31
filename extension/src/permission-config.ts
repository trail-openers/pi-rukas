/**
 * Three-layer permission config loading for the permission guard:
 * `$PWD/.pi/permissions.json` (project) → `~/.pi/agent/permissions.json`
 * (host-global) → shipped `agents.json` (baseline). First match wins in
 * permission-guard.ts's resolution order; this module only owns reading and
 * parsing the three files. Split out of permission-guard.ts (#171) to stay
 * under the module-size guideline (AGENTS.md §12) — filesystem I/O only, no
 * Pi API surface.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { trace } from "./trace.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Type definitions
export type PermVerdict = "allow" | "deny" | "ask";
type PermPattern = Record<string, PermVerdict | Record<string, PermVerdict>>;
export type RoleConfig = Record<string, { permission?: PermPattern }>;

const MAX_CONFIG_FILE_SIZE = 1 * 1024 * 1024; // 1MB

// Resolve the path to the repo's agents.json regardless of how the extension
// was loaded. The standard install symlinks ~/.pi/agent/extensions/pi-ensemble
// at the repo's `extension/` directory, so `import.meta.url` may be either
// the real file path or the symlink path depending on the Node/jiti symlink
// policy. realpathSync collapses the difference; `../..` then walks from
// `extension/src/` up to the repo root.
//
// PI_ENSEMBLE_DIR (if set) is an explicit override for users with unusual
// install layouts — useful in tests too.
export function resolveAgentsJsonPath(): string {
  const override = process.env.PI_ENSEMBLE_DIR;
  if (override) return path.resolve(override, "agents.json");
  try {
    const realDir = realpathSync(__dirname);
    return path.resolve(realDir, "..", "..", "agents.json");
  } catch {
    return path.resolve(__dirname, "..", "..", "agents.json");
  }
}

// agents.json ships with the repo, so ENOENT is unexpected and should warn.
// In contrast, project/global config ENOENT is silent (user may not have created them).
export function loadAgentsJson(): Record<
  string,
  { permission?: Record<string, string | Record<string, string>> }
> {
  const agentsPath = resolveAgentsJsonPath();
  try {
    const raw = readFileSync(agentsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as {
      agent?: Record<string, { permission?: Record<string, string | Record<string, string>> }>;
    };
    return obj.agent ?? {};
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to load agents.json from ${agentsPath} (${err}) — non-builtin tools will require interactive approval (or be blocked in headless mode)`;
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

// Walk up from `process.cwd()` looking for `.pi/permissions.json`. Mirrors
// git's `.git` ancestor search so a project overlay placed at the repo root
// applies inside worktree subdirectories too — which matters when subagents
// are spawned with `cwd = <repo>/.worktrees/<branch>` (PR #192 onward).
// Stops at the user's home directory: we never read a permissions overlay
// from outside the user's projects (no `/Users/.pi/permissions.json` or
// `/.pi/permissions.json` poisoning).
export function findProjectConfigPath(startDir?: string): string | null {
  const home = os.homedir();
  let dir = startDir ?? process.cwd();
  while (true) {
    const candidate = path.join(dir, ".pi", "permissions.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit FS root
    if (dir === home) return null; // do not search above $HOME
    dir = parent;
  }
}

export function loadProjectConfig(): RoleConfig {
  const configPath = findProjectConfigPath();
  if (!configPath) return {};
  try {
    // Resolve symlinks before reading
    const resolvedPath = realpathSync(configPath);
    return loadConfigFile(resolvedPath, "project");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") {
        // Missing file is normal — silent (existsSync race; very unlikely)
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

export function loadGlobalConfig(): RoleConfig {
  const configPath = path.join(os.homedir(), ".pi", "agent", "permissions.json");
  return loadConfigFile(configPath, "global");
}
