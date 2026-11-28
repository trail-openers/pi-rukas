/**
 * Extension auto-forward for spawned specialists — re-injects the parent
 * Pi's installed extensions (and an optional user-pinned one) into children
 * launched with `--no-extensions`, so provider/auth setup (e.g.
 * `pi-claude-auth`) and MCP bridges keep working without env-var wiring.
 * Two sources: the `<agent dir>/extensions/` scan, and the packages the user
 * `settings.json` declares (`pi install npm:…` / `git:…`), which Pi installs
 * under its own npm/git directories where the scan never looks. The agent dir
 * is Pi's own (`PI_CODING_AGENT_DIR`, `provider-env.ts` `agentDir`).
 *
 * No ExtensionAPI coupling: the scan is filesystem/env-only, and the package
 * side borrows the running Pi's exported package manager. Split out of
 * spawn.ts (#171); consumed by `spawnSpecialist`.
 *
 * pi-lens reaches only the developer role, with its own file rewrites off —
 * see PI_LENS_PACKAGE_NAME.
 *
 * Note: this module deliberately does NOT read mcp.json or interact with
 * Pi's native MCP subsystem. Children get MCP through the `-e builtin:mcp`
 * flag (see spawn-support.ts childArgsBase()) — no extension forwarding
 * needed. That is why discoverInstalledExtensions skips pi-mcp-adapter:
 * the adapter is the legacy bridge that would conflict with the built-in.
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import type { ExtensionPackageJson } from "./pi-event-shapes.ts";
import { agentDir } from "./provider-env.ts";
import { trace, traceWarn } from "./trace.ts";

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

// pi-lens rewrites files on its own (autoformat, autofix) and runs tests on
// write, through the filesystem rather than a tool call, so neither
// `--exclude-tools` nor the write fence sees it. It is forwarded to the
// developer alone, the role that writes code, and there with those three off
// (its CLI flags outrank a project `.pi-lens.json`): the developer keeps the
// LSP diagnostics and navigation, its diff stays what it wrote, and the verify
// step runs the checks.
const PI_LENS_PACKAGE_NAME = "pi-lens";
const PI_LENS_ROLE = "developer";
const PI_LENS_CHILD_FLAGS = ["--no-autoformat", "--no-autofix", "--no-tests"];

/** A forwarded extension entry and the package it belongs to. */
export interface ForwardedExtension {
  path: string;
  name: string | undefined;
}

const isSkippedPackage = (name: string | undefined, role: string) =>
  name === PI_ENSEMBLE_PACKAGE_NAME ||
  name === PI_MCP_ADAPTER_PACKAGE_NAME ||
  (name === PI_LENS_PACKAGE_NAME && role !== PI_LENS_ROLE);

/** Child argv for the forwarded extensions, plus pi-lens's flags when it is among them. */
export function extensionForwardArgs(forwarded: readonly ForwardedExtension[]): string[] {
  const args = forwarded.flatMap((ext) => ["--extension", ext.path]);
  if (forwarded.some((ext) => ext.name === PI_LENS_PACKAGE_NAME)) args.push(...PI_LENS_CHILD_FLAGS);
  return args;
}

function forwardDisabled(role: string): boolean {
  if (process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD !== "1") return false;
  trace(
    `spawn[${role}]: extension auto-forward disabled via PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD`,
  );
  return true;
}

function readPackageJson(dir: string | undefined): ExtensionPackageJson | undefined {
  if (!dir) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as ExtensionPackageJson;
  } catch {
    return undefined;
  }
}

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
 * Scan `<agent dir>/extensions/` for installed Pi extensions and return
 * absolute paths suitable for `--extension <path>`.
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
 *  - Skip pi-lens for every role but the developer (PI_LENS_PACKAGE_NAME).
 *  - Resolve through `realpathSync` because `~/.pi/agent/extensions/<name>`
 *    is typically a symlink to the source checkout.
 */
export function discoverInstalledExtensions(role: string): ForwardedExtension[] {
  if (forwardDisabled(role)) return [];
  const extensionsDir = path.join(agentDir(), "extensions");

  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return [];
  }

  const forwarded: ForwardedExtension[] = [];
  for (const entry of entries) {
    const entryPath = path.join(extensionsDir, entry);
    const pkg = readPackageJson(entryPath);
    if (!pkg?.pi?.extensions || pkg.pi.extensions.length === 0) continue;
    if (isSkippedPackage(pkg.name, role)) continue;

    let resolved: string;
    try {
      resolved = realpathSync(entryPath);
    } catch {
      resolved = entryPath;
    }
    forwarded.push({ path: resolved, name: pkg.name });
    trace(`spawn[${role}]: auto-forward --extension ${resolved} (${pkg.name ?? entry})`);
  }
  return forwarded;
}

/**
 * Extension entry files of the packages declared in the user `settings.json`,
 * resolved by the running Pi's own package manager so install locations, the
 * `pi` manifest, conventional directories and per-package resource filters
 * follow Pi's rules rather than a copy of them. Async because that API is.
 *
 *  - A source that is not installed is skipped, never installed: a spawn must
 *    not run npm or git.
 *  - Only `origin: "package"` resources count; the scan above owns
 *    `extensions/`, and project `.pi/settings.json` packages are not read.
 *  - pi-rukas, pi-mcp-adapter and (off the developer) pi-lens are skipped by
 *    package name, as in the scan.
 *  - A Pi without this API forwards nothing and says so: the child then lacks
 *    the package's provider setup, which must not be silent.
 */
export async function discoverPackageExtensions(role: string): Promise<ForwardedExtension[]> {
  if (forwardDisabled(role)) return [];
  const dir = agentDir();
  let settings: { packages?: PackageSource[]; npmCommand?: string[] };
  try {
    // Pi strips a leading BOM before parsing settings.json, so this must too.
    const text = readFileSync(path.join(dir, "settings.json"), "utf8").replace(/^\uFEFF/, "");
    settings = JSON.parse(text);
  } catch {
    return [];
  }
  if (!settings.packages?.length) return [];
  try {
    const { DefaultPackageManager, SettingsManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const settingsManager = SettingsManager.inMemory({
      packages: settings.packages,
      npmCommand: settings.npmCommand,
    });
    const pm = new DefaultPackageManager({ cwd: dir, agentDir: dir, settingsManager });
    const { extensions } = await pm.resolve(async () => "skip");
    const forwarded = extensions
      .filter((r) => r.enabled && r.metadata.origin === "package")
      .map((r) => ({ path: r.path, name: readPackageJson(r.metadata.packageRoot)?.name }))
      .filter((ext) => !isSkippedPackage(ext.name, role));
    for (const { path: p } of forwarded) {
      trace(`spawn[${role}]: auto-forward --extension ${p} (package)`);
    }
    return forwarded;
  } catch (err) {
    traceWarn(`spawn[${role}]: settings.json packages not forwarded: ${(err as Error).message}`);
    return [];
  }
}
