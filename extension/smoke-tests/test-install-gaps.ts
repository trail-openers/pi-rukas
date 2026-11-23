#!/usr/bin/env bun
/**
 * A gallery install (`pi install npm:@trail-openers/pi-rukas`) skips every
 * config step install.sh runs. Each missing piece must surface as a named
 * gap with its fix, never as a silent degrade, and the version floor must
 * come from install-preflight.sh, the one file that holds it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { type InstallFacts, judgeInstallGaps } from "../src/install-gaps.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = path.resolve(import.meta.dirname, "..", "..");
const preflight = readFileSync(path.join(root, "install-preflight.sh"), "utf8");
const floor = preflight.match(/^MIN_PI_VERSION=(\S+)$/m)?.[1] ?? "";
assert(floor !== "", "install-preflight.sh declares the floor this module reads");

const complete: InstallFacts = {
  piVersion: floor,
  preflight,
  settings: { retry: { provider: { maxRetries: 3 } } },
  mcpConfigs: [{ mcpServers: { codebase_memory: { command: "codebase-memory-mcp" } } }, undefined],
  wrapperOnPath: true,
};
const names = (f: Partial<InstallFacts>) =>
  judgeInstallGaps({ ...complete, ...f }).map((g) => g.name);
const warning = (f: Partial<InstallFacts>) =>
  judgeInstallGaps({ ...complete, ...f })
    .map((g) => g.warning)
    .join("\n");

assert(names({}).length === 0, "a host install.sh set up has no gaps (pi exactly at the floor passes)");

const old = warning({ piVersion: "0.1.0" });
assert(names({ piVersion: "0.1.0" }).join() === "pi-version", "pi below the floor is a pi-version gap");
assert(old.includes(`minimum ${floor}`), "...naming the floor read from install-preflight.sh");
assert(
  old.includes(`pi-coding-agent@${floor}`) && !old.includes("${"),
  "...with the upgrade command from install-preflight.sh, floor substituted",
);
assert(names({ piVersion: null }).length === 0, "an unknown pi version is left to the probe's own warning");
assert(
  names({ preflight: null }).join() === "pi-version",
  "an unreadable install-preflight.sh is a named gap, not a silent pass",
);

assert(names({ mcpConfigs: [undefined, undefined] }).join() === "mcp", "no mcp.json is an mcp gap");
assert(
  names({ mcpConfigs: [{ mcpServers: { other: {} } }, undefined] }).join() === "mcp",
  "an mcp.json without codebase_memory is an mcp gap",
);
assert(
  names({ mcpConfigs: [undefined, { mcpServers: { codebase_memory: {} } }] }).length === 0,
  "a project-level .pi/mcp.json registration counts",
);

assert(names({ settings: undefined }).join() === "retries", "no settings.json is a retries gap");
assert(
  names({ settings: { retry: { provider: { timeoutMs: 600000 } } } }).join() === "retries",
  "retry.provider without maxRetries is a retries gap",
);
assert(
  names({ settings: { retry: { provider: { maxRetries: 0 } } } }).length === 0,
  "an explicit maxRetries of 0 is the operator's choice, not a gap",
);

assert(names({ wrapperOnPath: false }).join() === "wrapper", "no pi-rukas on PATH is a wrapper gap");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
assert(pkg.files.includes("install-preflight.sh"), "the package ships install-preflight.sh, so the floor reaches a gallery install");

process.exit(exit);
