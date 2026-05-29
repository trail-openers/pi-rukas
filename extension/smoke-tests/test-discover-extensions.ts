#!/usr/bin/env bun
/**
 * Unit test for discoverInstalledExtensions against a synthetic
 * ~/.pi/agent/extensions/ tree.
 *
 * Verifies the four discovery rules:
 *   1. Valid extensions (package.json + pi.extensions manifest) are forwarded
 *   2. pi-ensemble itself is skipped (no recursive subagent spawn)
 *   3. Directories without package.json or without pi.extensions are skipped
 *   4. PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1 returns an empty list
 *
 * No Pi, no network.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverInstalledExtensions } from "../src/spawn.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

async function writePkg(
  dir: string,
  pkg: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

// Build a fake $PI_AGENT_DIR with an extensions/ subtree.
const piAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-discover-"));
const extDir = path.join(piAgentDir, "extensions");

// (a) valid auth extension — should be forwarded
await writePkg(path.join(extDir, "pi-claude-auth"), {
  name: "pi-claude-auth",
  version: "1.0.0",
  pi: { extensions: ["dist/index.js"] },
});

// (b) pi-ensemble itself — must be skipped to avoid recursive spawn
await writePkg(path.join(extDir, "pi-ensemble"), {
  name: "@randomm/pi-ensemble",
  version: "0.11.0",
  pi: { extensions: ["dist/index.js"] },
});

// (c) directory without package.json — must be skipped
await fs.mkdir(path.join(extDir, "stray-dir"), { recursive: true });

// (d) package.json without pi.extensions — must be skipped
await writePkg(path.join(extDir, "not-a-pi-ext"), {
  name: "some-other-thing",
  version: "1.0.0",
});

// (e) symlinked extension — verifies realpathSync resolution
const realSrc = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-discover-src-"));
await writePkg(realSrc, {
  name: "pi-symlinked-bridge",
  version: "1.0.0",
  pi: { extensions: ["dist/index.js"] },
});
await fs.symlink(realSrc, path.join(extDir, "symlinked-bridge"));

// Point discovery at our fake tree.
const prevAgentDir = process.env.PI_AGENT_DIR;
const prevDisable = process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;
process.env.PI_AGENT_DIR = piAgentDir;
delete process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;

const result = discoverInstalledExtensions("test");
console.log("forwarded:", result);

assert(result.length === 2, `forwards exactly 2 extensions (got ${result.length})`);

// We use endsWith because realpathSync may resolve through /private/var on macOS,
// but the trailing path segment is stable.
const hasAuth = result.some((p) => p.endsWith("/pi-claude-auth"));
assert(hasAuth, "pi-claude-auth is in the forwarded list");

const hasSymlinked = result.some((p) => p === realSrc || p.endsWith(path.basename(realSrc)));
assert(hasSymlinked, "symlinked extension resolved to its real path");

const hasEnsemble = result.some((p) => p.endsWith("/pi-ensemble"));
assert(!hasEnsemble, "pi-ensemble itself is filtered out");

const hasStray = result.some((p) => p.endsWith("/stray-dir"));
assert(!hasStray, "directory without package.json is filtered out");

const hasNotPi = result.some((p) => p.endsWith("/not-a-pi-ext"));
assert(!hasNotPi, "package.json without pi.extensions is filtered out");

// Opt-out env var
process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD = "1";
const optedOut = discoverInstalledExtensions("test");
assert(optedOut.length === 0, "PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1 returns empty list");

// Missing extensions/ directory falls through cleanly
delete process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;
const emptyAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-discover-empty-"));
process.env.PI_AGENT_DIR = emptyAgentDir;
const noDir = discoverInstalledExtensions("test");
assert(noDir.length === 0, "missing extensions/ dir returns empty list (no crash)");
await fs.rm(emptyAgentDir, { recursive: true, force: true });

// Restore env
if (prevAgentDir === undefined) delete process.env.PI_AGENT_DIR;
else process.env.PI_AGENT_DIR = prevAgentDir;
if (prevDisable === undefined) delete process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;
else process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD = prevDisable;

await fs.rm(piAgentDir, { recursive: true, force: true });
await fs.rm(realSrc, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll discover-extensions checks passed." : "\nFAILED");
process.exit(exit);
