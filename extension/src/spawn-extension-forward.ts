/**
 * Extension auto-forward for spawned specialists — re-injects the parent
 * Pi's installed extensions (and an optional user-pinned one) into children
 * launched with `--no-extensions`, so provider/auth setup (e.g.
 * `pi-claude-auth`) and MCP bridges keep working without env-var wiring.
 *
 * Filesystem/env-only: no ExtensionAPI coupling. Split out of spawn.ts
 * (#171); consumed by `spawnSpecialist`.
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionPackageJson } from "./pi-event-shapes.ts";
import { trace } from "./trace.ts";

export function applyUserExtension(childArgs: string[], role: string): void {
  const userExt = process.env.PI_ENSEMBLE_USER_EXTENSION;
  if (!userExt) return;
  const isNpmRef = userExt.startsWith("npm:");
  const isAbsPath = userExt.startsWith("/") || userExt.startsWith("~");
  if (!isNpmRef && !isAbsPath) {
    const msg = `pi-ensemble: PI_ENSEMBLE_USER_EXTENSION='${userExt}' rejected (must start with 'npm:' or be an absolute path) — MCP extension will NOT be loaded`;
    console.warn(msg);
    trace(`spawn[${role}]: ${msg}`);
  } else {
    childArgs.push("--extension", userExt);
    trace(`spawn[${role}]: --extension ${userExt}`);
  }
}

// pi-ensemble's own package name. Used by discoverInstalledExtensions to skip
// forwarding ourselves into subagents — otherwise a subagent could call
// dispatch_specialist and recursively spawn another subagent.
const PI_ENSEMBLE_PACKAGE_NAME = "@randomm/pi-ensemble";

/**
 * Resolve the absolute path to pi-ensemble's extension directory for the
 * subagent permission-guard forward. Walks up from this module file
 * (`extension/src/spawn-extension-forward.ts`) to the `extension/` dir, then
 * realpathSyncs to follow the install symlink (`~/.pi/agent/extensions/pi-
 * ensemble` is a symlink to the repo's `extension/` directory). Returns
 * undefined if the path can't be resolved — caller falls through to
 * "subagent has no forwarded guard" cleanly.
 */
export function piEnsembleExtensionPath(): string | undefined {
  try {
    const here = new URL(import.meta.url).pathname; // .../extension/src/spawn-extension-forward.ts
    const extensionDir = path.resolve(path.dirname(here), "..");
    return realpathSync(extensionDir);
  } catch (err) {
    trace(`spawn: piEnsembleExtensionPath resolution failed: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Scan `~/.pi/agent/extensions/` (or `$PI_AGENT_DIR/extensions`) for installed
 * Pi extensions and return absolute paths suitable for `--extension <path>`.
 *
 * Subagents launch with `--no-extensions`, which suppresses every installed
 * extension. That breaks anything that depends on extension-injected provider
 * config — most importantly `pi-claude-auth`, which adds the Claude Code
 * identity headers Anthropic now enforces server-side. Auto-forwarding lets
 * subagents inherit the same provider/auth setup the main agent has.
 *
 * Rules:
 *  - Skip if `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1` (global opt-out).
 *  - Skip entries without a readable `package.json`.
 *  - Skip entries whose `package.json` has no `pi.extensions` manifest (not
 *    a Pi extension — e.g. stray directories, half-installed packages).
 *  - Skip pi-ensemble itself by package name (prevents recursive spawn).
 *  - Resolve through `realpathSync` because `~/.pi/agent/extensions/<name>`
 *    is typically a symlink to the source checkout.
 */
export function discoverInstalledExtensions(role: string): string[] {
  if (process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD === "1") {
    trace(
      `spawn[${role}]: extension auto-forward disabled via PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD`,
    );
    return [];
  }

  const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const extensionsDir = path.join(piAgentDir, "extensions");

  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return [];
  }

  const forwarded: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(extensionsDir, entry);
    const pkgPath = path.join(entryPath, "package.json");

    let pkg: ExtensionPackageJson;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as ExtensionPackageJson;
    } catch {
      continue;
    }

    if (!pkg.pi?.extensions || pkg.pi.extensions.length === 0) continue;
    if (pkg.name === PI_ENSEMBLE_PACKAGE_NAME) continue;

    let resolved: string;
    try {
      resolved = realpathSync(entryPath);
    } catch {
      resolved = entryPath;
    }
    forwarded.push(resolved);
    trace(`spawn[${role}]: auto-forward --extension ${resolved} (${pkg.name ?? entry})`);
  }
  return forwarded;
}
