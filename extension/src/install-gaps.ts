/**
 * install-gaps — name what a gallery install of pi-rukas leaves undone.
 *
 * `./install.sh` checks pi against the version floor, registers
 * codebase-memory-mcp in mcp.json, writes the provider retry defaults and
 * puts the `pi-rukas` wrapper on PATH. `pi install npm:@trail-openers/pi-rukas`
 * only loads the extension and skills, so on a host that never ran the
 * installer each of those can be missing while the session looks healthy.
 * This module names each missing piece with its fix instead of editing the
 * operator's config: those files are theirs, and a warning cannot corrupt one.
 *
 * The floor is read from install-preflight.sh, its single source, which the
 * package ships for that reason. A sandbox session is skipped: its image was
 * built by install.sh, and its settings belong to the container.
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isVersionOlder, probePiVersion } from "./pi-version-probe.ts";
import { agentDir } from "./provider-env.ts";
import { trace } from "./trace.ts";

export type InstallGapName = "pi-version" | "mcp" | "retries" | "wrapper";

export interface InstallGap {
  name: InstallGapName;
  warning: string;
}

export interface InstallFacts {
  /** The running pi's version; null when the probe could not tell. */
  piVersion: string | null;
  /** install-preflight.sh's source; null when unreadable. */
  preflight: string | null;
  /** Pi's parsed settings.json; undefined when absent or unparseable. */
  settings: unknown;
  /** The user and project mcp.json, parsed. */
  mcpConfigs: unknown[];
  wrapperOnPath: boolean;
}

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Judge the gathered facts. Pure, so each gap is directly testable. */
export function judgeInstallGaps(f: InstallFacts): InstallGap[] {
  const gaps: InstallGap[] = [];
  const floor = f.preflight?.match(/^MIN_PI_VERSION=(\S+)$/m)?.[1];
  if (!floor) {
    gaps.push({
      name: "pi-version",
      warning:
        "install-preflight.sh is missing or declares no floor, so the pi version is unchecked",
    });
  } else if (f.piVersion && isVersionOlder(f.piVersion, floor)) {
    const cmd = f.preflight
      ?.match(/^PI_UPGRADE_CMD="(.+)"$/m)?.[1]
      ?.replace(/\$\{MIN_PI_VERSION\}/, floor);
    gaps.push({
      name: "pi-version",
      warning: `pi ${f.piVersion} is below the pi-rukas minimum ${floor}${cmd ? `; upgrade with: ${cmd}` : ""}`,
    });
  }
  const servers = (c: unknown) => (c as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (!f.mcpConfigs.some((c) => servers(c)?.codebase_memory !== undefined)) {
    gaps.push({
      name: "mcp",
      warning:
        "codebase_memory is not registered in mcp.json, so the mcp__codebase_memory__* code-search tools are unavailable",
    });
  }
  const retry = (f.settings as { retry?: { provider?: { maxRetries?: unknown } } })?.retry;
  if (retry?.provider?.maxRetries === undefined) {
    gaps.push({
      name: "retries",
      warning:
        "retry.provider.maxRetries is not set in settings.json, so Pi does not retry a failed provider request",
    });
  }
  if (!f.wrapperOnPath) {
    gaps.push({
      name: "wrapper",
      warning:
        "the pi-rukas wrapper is not on PATH, so sandbox mode and pi-rukas-headless are unavailable",
    });
  }
  return gaps;
}

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, "utf8").catch(() => null);
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Gather this host's facts and judge them. Never throws; empty in a sandbox. */
export async function installGaps(cwd = process.cwd()): Promise<InstallGap[]> {
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") return [];
  const dir = agentDir();
  const [probe, preflight, settings, userMcp, projectMcp] = await Promise.all([
    probePiVersion(),
    readText(path.join(PACKAGE_ROOT, "install-preflight.sh")),
    readJson(path.join(dir, "settings.json")),
    readJson(path.join(dir, "mcp.json")),
    readJson(path.join(cwd, ".pi", "mcp.json")),
  ]);
  const wrapperOnPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((d) => d !== "" && existsSync(path.join(d, "pi-rukas")));
  return judgeInstallGaps({
    piVersion: probe.version,
    preflight,
    settings,
    mcpConfigs: [userMcp, projectMcp],
    wrapperOnPath,
  });
}

/** Operator-facing lines, shared by the startup warning and /ensemble-debug. */
export function formatInstallGaps(gaps: readonly InstallGap[]): string[] {
  return [
    "pi-rukas setup is incomplete:",
    ...gaps.map((g) => `  ${g.name}: ${g.warning}`),
    "  fix: docs/configuration.md → Installing from the Pi package gallery",
  ];
}

let warned = false;

/**
 * Warn once per process about the gaps that degrade a host-mode session. The
 * wrapper is left to /ensemble-debug: host mode is complete without it, so a
 * per-session notice would only nag an operator who chose host mode.
 */
export function warnInstallGapsOnce(ctx: ExtensionContext): void {
  if (warned) return;
  warned = true;
  void installGaps()
    .then((gaps) => {
      const degrading = gaps.filter((g) => g.name !== "wrapper");
      if (degrading.length === 0) return;
      const text = formatInstallGaps(degrading).join("\n");
      trace(text);
      ctx.ui.notify(text, "warning");
    })
    .catch((err: unknown) => trace(`install-gaps: ${String(err)}`));
}
