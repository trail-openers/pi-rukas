#!/usr/bin/env bun
/**
 * Unit test for discoverInstalledExtensions against a synthetic
 * ~/.pi/agent/extensions/ tree, and for discoverPackageExtensions against
 * packages declared in the same agent dir's settings.json.
 *
 * Verifies the discovery rules:
 *   1. Valid extensions (package.json + pi.extensions manifest) are forwarded
 *   2. pi-ensemble itself is skipped (no recursive subagent spawn)
 *   3. Directories without package.json or without pi.extensions are skipped
 *   4. PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1 returns an empty list
 *   5. The agent dir is Pi's PI_CODING_AGENT_DIR, not PI_AGENT_DIR
 *   6. settings.json npm/git packages with no extensions/ entry are forwarded,
 *      per-package filters honoured, pi-rukas and pi-mcp-adapter skipped
 *   7. pi-lens, from either source, reaches the developer alone, and its argv
 *      carries the flags that turn its file rewrites and tests off
 *
 * No Pi, no network.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverInstalledExtensions,
  discoverPackageExtensions,
  extensionForwardArgs,
} from "../src/spawn-extension-forward.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

async function writePkg(dir: string, pkg: Record<string, unknown>): Promise<void> {
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

// (b) pi-rukas itself — must be skipped to avoid recursive spawn
await writePkg(path.join(extDir, "pi-ensemble"), {
  name: "@trail-openers/pi-rukas",
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

// (f) pi-mcp-adapter — must be skipped even if a host has not yet re-run
// install.sh and the adapter lingers in extensions/ (issue #959). Its /mcp
// extension registration would replace the built-in MCP and disable native
// MCP in every child.
await writePkg(path.join(extDir, "pi-mcp-adapter"), {
  name: "pi-mcp-adapter",
  version: "2.32.1",
  pi: { extensions: ["dist/index.js"] },
});

// (f2) pi-lens — forwarded to the developer only
await writePkg(path.join(extDir, "pi-lens"), {
  name: "pi-lens",
  version: "4.5.2",
  pi: { extensions: ["dist/index.js"] },
});

// (g) packages installed by `pi install` — under Pi's npm/git dirs, declared
// in settings.json, with no entry under extensions/.
async function writeExt(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "export default () => {};\n");
}
const npmRoot = path.join(piAgentDir, "npm", "node_modules");
await writePkg(path.join(npmRoot, "pi-gallery-auth"), {
  name: "pi-gallery-auth",
  version: "1.2.0",
  pi: { extensions: ["./src/auth.ts"] },
});
await writeExt(path.join(npmRoot, "pi-gallery-auth", "src", "auth.ts"));
const gitRoot = path.join(piAgentDir, "git", "github.com", "example", "pi-tools");
await writePkg(gitRoot, { name: "pi-tools", version: "0.1.0" });
await writeExt(path.join(gitRoot, "extensions", "keep.ts"));
await writeExt(path.join(gitRoot, "extensions", "legacy.ts"));
await writePkg(path.join(npmRoot, "@trail-openers", "pi-rukas"), {
  name: "@trail-openers/pi-rukas",
  version: "0.15.0",
  pi: { extensions: ["./index.ts"] },
});
await writeExt(path.join(npmRoot, "@trail-openers", "pi-rukas", "index.ts"));
await writePkg(path.join(npmRoot, "pi-mcp-adapter"), {
  name: "pi-mcp-adapter",
  version: "2.32.1",
  pi: { extensions: ["./index.ts"] },
});
await writeExt(path.join(npmRoot, "pi-mcp-adapter", "index.ts"));
await writePkg(path.join(npmRoot, "pi-lens"), {
  name: "pi-lens",
  version: "4.5.2",
  pi: { extensions: ["./index.ts"] },
});
await writeExt(path.join(npmRoot, "pi-lens", "index.ts"));
await fs.writeFile(
  path.join(piAgentDir, "settings.json"),
  // A leading BOM: Pi accepts it, so discovery must too.
  `\uFEFF${JSON.stringify({
    packages: [
      "npm:pi-gallery-auth@^1.0.0",
      { source: "git:github.com/example/pi-tools@v1", extensions: ["!extensions/legacy.ts"] },
      "npm:@trail-openers/pi-rukas",
      "npm:pi-mcp-adapter",
      "npm:pi-lens",
      "npm:pi-not-installed",
    ],
  })}`,
);

// Point discovery at our fake tree. PI_AGENT_DIR names an empty dir: Pi reads
// PI_CODING_AGENT_DIR, so discovery must too.
const prevAgentDir = process.env.PI_AGENT_DIR;
const prevCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const prevDisable = process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;
const decoyAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-discover-decoy-"));
process.env.PI_AGENT_DIR = decoyAgentDir;
process.env.PI_CODING_AGENT_DIR = piAgentDir;
delete process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;

const result = discoverInstalledExtensions("test").map((ext) => ext.path);
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

const hasAdapter = result.some((p) => p.endsWith("/pi-mcp-adapter"));
assert(!hasAdapter, "pi-mcp-adapter is filtered out (issue #959: its /mcp registration would replace native MCP)");

const packages = (await discoverPackageExtensions("test")).map((ext) =>
  path.relative(piAgentDir, ext.path),
);
console.log("package extensions:", packages);
assert(
  JSON.stringify(packages.sort()) ===
    JSON.stringify(
      [
        path.join("git", "github.com", "example", "pi-tools", "extensions", "keep.ts"),
        path.join("npm", "node_modules", "pi-gallery-auth", "src", "auth.ts"),
      ].sort(),
    ),
  "settings.json packages forward their extension files: filter honoured, pi-rukas/adapter/uninstalled skipped",
);

assert(!result.some((p) => p.endsWith("/pi-lens")), "pi-lens is not forwarded to a non-developer role");
const lensFlags = ["--no-autoformat", "--no-autofix", "--no-tests"];
const plainArgs = extensionForwardArgs(discoverInstalledExtensions("test"));
assert(!lensFlags.some((f) => plainArgs.includes(f)), "no pi-lens flags without pi-lens");
for (const role of ["explore", "code-review-specialist", "adversarial-developer", "ops"]) {
  const scan = discoverInstalledExtensions(role);
  const pkgs = await discoverPackageExtensions(role);
  assert(
    ![...scan, ...pkgs].some((ext) => ext.name === "pi-lens"),
    `pi-lens is not forwarded to ${role} from either source`,
  );
}
const devScanArgs = extensionForwardArgs(discoverInstalledExtensions("developer"));
assert(
  devScanArgs.some((a) => a.endsWith("/pi-lens")) && lensFlags.every((f) => devScanArgs.includes(f)),
  "the extensions/ scan forwards pi-lens to the developer, with its rewrite/test flags",
);
const devPkgArgs = extensionForwardArgs(await discoverPackageExtensions("developer"));
assert(
  devPkgArgs.some((a) => a.includes(`${path.sep}pi-lens${path.sep}`)) &&
    lensFlags.every((f) => devPkgArgs.includes(f)),
  "a settings.json pi-lens package reaches the developer, with its rewrite/test flags",
);

// Opt-out env var
process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD = "1";
const optedOut = discoverInstalledExtensions("test");
assert(optedOut.length === 0, "PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1 returns empty list");
const optedOutPackages = await discoverPackageExtensions("test");
assert(optedOutPackages.length === 0, "PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1 forwards no packages");

// Missing extensions/ directory falls through cleanly
delete process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;
const emptyAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-discover-empty-"));
process.env.PI_CODING_AGENT_DIR = emptyAgentDir;
const noDir = discoverInstalledExtensions("test");
assert(noDir.length === 0, "missing extensions/ dir returns empty list (no crash)");
const noSettings = await discoverPackageExtensions("test");
assert(noSettings.length === 0, "missing settings.json forwards no packages (no crash)");
await fs.rm(emptyAgentDir, { recursive: true, force: true });

// Restore env
if (prevAgentDir === undefined) delete process.env.PI_AGENT_DIR;
else process.env.PI_AGENT_DIR = prevAgentDir;
if (prevCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = prevCodingAgentDir;
if (prevDisable === undefined) delete process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD;
else process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD = prevDisable;

await fs.rm(piAgentDir, { recursive: true, force: true });
await fs.rm(decoyAgentDir, { recursive: true, force: true });
await fs.rm(realSrc, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll discover-extensions checks passed." : "\nFAILED");
process.exit(exit);
