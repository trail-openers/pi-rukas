#!/usr/bin/env bun
/**
 * Identity pins for the pi-ensemble → pi-rukas rename (S2, #627).
 *
 * The rename touches identity-critical facts that have no other test:
 *
 *   1. The package name in extension/package.json must equal the
 *      self-detection constant in src/spawn-extension-forward.ts. The
 *      constant is a literal in source (not imported), so a drift between
 *      the two strings silently breaks discoverInstalledExtensions — the
 *      guard that prevents the extension from forwarding itself into
 *      subagents and spawning recursively. This test reads both sides and
 *      compares.
 *
 *   2. The release-please manifest keys must match the config's package
 *      keys 1:1 — the same set of components, tracked in both files. A
 *      mismatch after the key rename silently breaks release-please (the
 *      #337 incident class).
 *
 *   3. The launcher script in bin/ exists, is executable, and starts with
 *      a shebang — the acceptance criterion "the launcher binary exists
 *      and is executable" had no offline test (test-file-size-limit's
 *      canary only proves scan scope, not executability).
 *
 * All reads are against the real files; no fixtures, no stubs.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXT_PKG = path.join(ROOT, "extension", "package.json");
const FORWARD_SRC = path.join(ROOT, "extension", "src", "spawn-extension-forward.ts");
const RP_CONFIG = path.join(ROOT, "release-please-config.json");
const RP_MANIFEST = path.join(ROOT, ".release-please-manifest.json");
const BIN_DIR = path.join(ROOT, "bin");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ===================================================== 1. package name vs self-detection const

{
  const pkg = JSON.parse(readFileSync(EXT_PKG, "utf8")) as { name?: string };
  assert(typeof pkg.name === "string" && pkg.name.length > 0, "extension/package.json: name present");
  // Anchor to the known identity pair: the constant is a literal string, so
  // the pin is "the const is exactly one of the two identities, and it
  // equals package.json". A drift to any other string fails either arm.
  const known = ["@randomm/pi-ensemble", "@trail-openers/pi-rukas"];
  assert(
    known.includes(pkg.name ?? ""),
    `extension/package.json: name is a known identity (got ${JSON.stringify(pkg.name)})`,
  );

  const forwardSrc = readFileSync(FORWARD_SRC, "utf8");
  // The self-detection guard: `const PI_ENSEMBLE_PACKAGE_NAME = "<name>";`
  // Anchored to the const name so a comment mentioning the package name
  // cannot satisfy the assertion.
  const m = forwardSrc.match(/const\s+PI_ENSEMBLE_PACKAGE_NAME\s*=\s*"([^"]*)"/);
  assert(m !== null, "spawn-extension-forward.ts: PI_ENSEMBLE_PACKAGE_NAME const present");
  assert(
    m !== null && m[1] === pkg.name,
    `self-detection guard: PI_ENSEMBLE_PACKAGE_NAME (${JSON.stringify(m?.[1] ?? "absent")}) equals package.json name (${JSON.stringify(pkg.name)})`,
  );
}

// ===================================================== 2. release-please manifest vs config

{
  const rpConfig = JSON.parse(readFileSync(RP_CONFIG, "utf8")) as {
    packages?: Record<string, { "package-name"?: string }>;
  };
  const packages = rpConfig.packages ?? {};
  const configKeys = Object.keys(packages);
  assert(configKeys.length > 0, "release-please-config.json: at least one package entry");
  for (const [key, p] of Object.entries(packages)) {
    assert(
      typeof p["package-name"] === "string" && p["package-name"].length > 0,
      `release-please-config.json: package "${key}" has a non-empty package-name (got ${JSON.stringify(p["package-name"])})`,
    );
  }

  const rpManifest = JSON.parse(readFileSync(RP_MANIFEST, "utf8")) as Record<string, string>;
  const manifestKeys = Object.keys(rpManifest);
  assert(manifestKeys.length > 0, ".release-please-manifest.json: at least one key present");
  for (const [key, version] of Object.entries(rpManifest)) {
    assert(
      typeof version === "string" && version.length > 0,
      `manifest key "${key}" maps to a non-empty version string`,
    );
  }
  // The config keys and manifest keys must describe the SAME set of
  // components — a mismatch is the #337 class of silent release-please break.
  assert(
    JSON.stringify([...configKeys].sort()) === JSON.stringify([...manifestKeys].sort()),
    `release-please: config package keys (${JSON.stringify(configKeys)}) match manifest keys (${JSON.stringify(manifestKeys)})`,
  );
}

// ===================================================== 3. bin launcher: exists, executable, shebang

{
  // The launcher is bin/pi-ensemble pre-rename, bin/pi-rukas post-rename.
  // The identity pin checks whichever name exists and asserts it is a
  // regular file, executable, and shebang'd. Post-rename the assertion
  // automatically pins the new name; pre-rename it pins the old one so the
  // test is green on the current codebase and flips without an edit when
  // the bin/* workstream renames the file.
  const knownBins = ["pi-rukas", "pi-ensemble"];
  const present = knownBins.filter((n) => existsSync(path.join(BIN_DIR, n)));
  assert(
    present.length === 1,
    `exactly one known launcher in bin/ (got ${JSON.stringify(present)})`,
  );
  if (present.length === 1) {
    const binName = present[0];
    const binPath = path.join(BIN_DIR, binName);
    const st = statSync(binPath);
    assert(st.isFile(), `bin/${binName}: is a regular file`);
    const mode = st.mode & 0o755;
    assert(
      (mode & 0o100) !== 0 && (mode & 0o010) !== 0,
      `bin/${binName}: executable by owner and others (mode ${mode.toString(8)})`,
    );
    const head = readFileSync(binPath, { maxBytes: 2 }).toString("utf8");
    assert(head.startsWith("#!"), `bin/${binName}: starts with a shebang (first 2 chars are '#!')`);
  }
}

console.log(exit === 0 ? "\nAll identity-pin checks passed." : "\nFAILED");
process.exit(exit);
