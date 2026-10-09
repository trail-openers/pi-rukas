/**
 * Extension auto-forward for spawned specialists — re-injects the parent
 * Pi's installed extensions (and an optional user-pinned one) into children
 * launched with `--no-extensions`, so provider/auth setup (e.g.
 * `pi-claude-auth`) and MCP bridges keep working without env-var wiring.
 *
 * Filesystem/env-only: no ExtensionAPI coupling. Split out of spawn.ts
 * (#171); consumed by `spawnSpecialist`.
 *
 * Note: this module deliberately does NOT read mcp.json or interact with
 * Pi's native MCP subsystem. Children get MCP through the `-e builtin:mcp`
 * flag (see spawn-support.ts childArgsBase()) — no extension forwarding
 * needed. That is why discoverInstalledExtensions skips pi-mcp-adapter:
 * the adapter is the legacy bridge that would conflict with the built-in.
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
    const msg = `pi-rukas: PI_ENSEMBLE_USER_EXTENSION='${userExt}' rejected (must start with 'npm:' or be an absolute path) — MCP extension will NOT be loaded`;
    console.warn(msg);
    trace(`spawn[${role}]: ${msg}`);
  } else {
    childArgs.push("--extension", userExt);
    trace(`spawn[${role}]: --extension ${userExt}`);
  }
}

// pi-rukas's own package name. Used by discoverInstalledExtensions to skip
// forwarding ourselves into subagents — otherwise a subagent could call
// dispatch_specialist and recursively spawn another subagent.
const PI_ENSEMBLE_PACKAGE_NAME = "@trail-openers/pi-rukas";

// pi-mcp-adapter is an MCP bridge that registers the /mcp extension. On
// Pi 1.0.0, an installed extension that registers /mcp REPLACES the built-in
// MCP subsystem for the whole session (docs/mcp.md: "Pi then does not read
// mcp.json or connect its servers in a session"). Because the built-in MCP
// is what pi-rukas now uses (see spawn-support.ts childArgsBase()), the
// adapter is not only obsolete — it actively BREAKS native MCP. So
// discoverInstalledExtensions must skip it in every case (issue #959), even
// if a host has not yet re-run install.sh and the adapter lingers in
// ~/.pi/agent/extensions/.
const PI_MCP_ADAPTER_PACKAGE_NAME = "pi-mcp-adapter";

/**
 * Resolve the absolute path to pi-rukas's extension directory for the
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
 *  - Skip pi-rukas itself by package name (prevents recursive spawn).
 *  - Skip pi-mcp-adapter by package name (its /mcp registration replaces
 *    the built-in MCP, which would disable native MCP in every child —
 *    see the PI_MCP_ADAPTER_PACKAGE_NAME constant for the full rationale).
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
    if (pkg.name === PI_MCP_ADAPTER_PACKAGE_NAME) continue;

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
