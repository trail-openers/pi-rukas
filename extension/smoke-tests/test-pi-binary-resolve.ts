#!/usr/bin/env bun
/**
 * Pi binary resolution — issue #1019 (Headless S3).
 *
 * Tests the resolution helper in pi-binary-resolve.ts: env override,
 * package bin, PATH fallback, version probe, probe wiring.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  _resetPiBinaryCache,
  _resetVerifiedVersionCache,
  getPiInvocation,
  getPiResolutionInfo,
  isVersionOlder,
  looksLikePiCli,
  parsePiVersion,
  resolvePackageBin,
  resolvePiBinarySync,
} from "../src/pi-binary-resolve.ts";

let exit = 0;
let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
    passed++;
  } else {
    console.error(`✗ ${msg}`);
    failed++;
    exit = 1;
  }
}

function section(name: string) {
  console.log(`\n--- ${name} ---`);
}

// Shared env / tmpdir helpers

// Save/restore idiom (matches test-spawn-semaphore.ts).
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Unique tmpdir per run (avoids hard-coded paths from crashed runs).
function mkTmpDir(name: string): string {
  const dir = path.join(os.tmpdir(), `pi-rukas-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rmDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ok */
  }
}

function makeFakeBin(name: string, body: string, mode = 0o755): string {
  const bin = path.join(os.tmpdir(), `pi-rukas-${name}-${process.pid}-${Date.now()}`);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode });
  return bin;
}

function rmFile(f: string): void {
  try {
    rmSync(f, { force: true });
  } catch {
    /* ok */
  }
}

// ---------------------------------------------------------------------------
// looksLikePiCli
// ---------------------------------------------------------------------------

section("looksLikePiCli");

assert(
  looksLikePiCli("/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  "matches dist/cli.js",
);
assert(
  looksLikePiCli("/opt/node_modules/@earendil-works/pi-coding-agent/cli.cjs"),
  "matches cli.cjs (no dist)",
);
assert(
  looksLikePiCli("/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.mjs"),
  "matches dist/cli.mjs",
);
assert(
  !looksLikePiCli("/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js.map"),
  "rejects dist/cli.js.map (source map is not the CLI)",
);
assert(!looksLikePiCli("/opt/some-other-app/cli.js"), "rejects non-pi-coding-agent path");
assert(!looksLikePiCli("/$bunfs/opt/cli.js"), "rejects bunfs path");
assert(!looksLikePiCli(undefined), "rejects undefined");
assert(!looksLikePiCli(""), "rejects empty string");
assert(
  !looksLikePiCli("/opt/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  "rejects non-cli.js entry",
);

// ---------------------------------------------------------------------------
// parsePiVersion
// ---------------------------------------------------------------------------

section("parsePiVersion");

assert(parsePiVersion("pi 1.0.0") === "1.0.0", "parses 'pi 1.0.0'");
assert(parsePiVersion("1.0.0") === "1.0.0", "parses bare '1.0.0'");
assert(parsePiVersion("pi 0.9.0") === "0.9.0", "parses 'pi 0.9.0'");
assert(parsePiVersion("pi 2.1.3-beta.1") === "2.1.3-beta.1", "parses pre-release");
assert(parsePiVersion("some garbage output") === null, "returns null for unparseable");
assert(parsePiVersion("") === null, "returns null for empty string");
assert(parsePiVersion("1.2") === "1.2", "parses major.minor only");

// ---------------------------------------------------------------------------
// isVersionOlder
// ---------------------------------------------------------------------------

section("isVersionOlder");

assert(isVersionOlder("0.99.0", "1.0.0") === true, "0.99.0 < 1.0.0");
assert(isVersionOlder("1.0.0", "1.0.0") === false, "1.0.0 == 1.0.0");
assert(isVersionOlder("1.0.1", "1.0.0") === false, "1.0.1 > 1.0.0");
assert(isVersionOlder("1.0.0", "1.0.1") === true, "1.0.0 < 1.0.1");
assert(isVersionOlder("0.9.0", "0.9.1") === true, "0.9.0 < 0.9.1");
assert(isVersionOlder("2.0.0", "1.9.9") === false, "2.0.0 > 1.9.9");
assert(isVersionOlder("1.0", "1.0.1") === true, "1.0 < 1.0.1");
assert(isVersionOlder("garbage", "1.0.0") === false, "unparseable returns false");

// ---------------------------------------------------------------------------
// resolvePiBinarySync — resolution order
// ---------------------------------------------------------------------------

section("resolvePiBinarySync");

// --- PATH fallback (no env, package injected-absent) ---
_resetPiBinaryCache();
withEnv({ PI_ENSEMBLE_PI_BIN: undefined }, () => {
  const fallback = resolvePiBinarySync();
  if (fallback.source === "package") {
    assert(
      fallback.path.includes("pi-coding-agent"),
      `package branch resolves inside the installed package (got ${fallback.path})`,
    );
  } else {
    assert(fallback.source === "path", "falls back to PATH when the package is absent");
    assert(fallback.path === "pi", "path is 'pi'");
    assert(fallback.command === "pi", "command is 'pi'");
  }
});

// --- ENV override (valid) ---
_resetPiBinaryCache();
const fakeBin1 = makeFakeBin("fake-pi", "echo 'pi 9.9.9'");
withEnv({ PI_ENSEMBLE_PI_BIN: fakeBin1 }, () => {
  const resolved = resolvePiBinarySync();
  assert(resolved.source === "env", "env source when PI_ENSEMBLE_PI_BIN is set");
  assert(resolved.path === fakeBin1, "path is the env value");
  assert(resolved.command === fakeBin1, "command is the env value");
});
rmFile(fakeBin1);

// --- ENV override (invalid — non-existent path) ---
_resetPiBinaryCache();
let threw1 = false;
let errMsg1 = "";
withEnv({ PI_ENSEMBLE_PI_BIN: "/nonexistent/path/to/pi-12345" }, () => {
  try {
    resolvePiBinarySync();
  } catch (e) {
    threw1 = true;
    errMsg1 = (e as Error).message;
  }
});
assert(threw1, "throws when PI_ENSEMBLE_PI_BIN is not an existing executable");
assert(errMsg1.includes("PI_ENSEMBLE_PI_BIN"), "error names the env var");
assert(errMsg1.includes("not an existing executable"), "error describes the failure");

// --- ENV override (invalid — not executable) ---
_resetPiBinaryCache();
const nonExec = makeFakeBin("non-exec-pi", "echo never", 0o644);
let threw2 = false;
let errMsg2 = "";
withEnv({ PI_ENSEMBLE_PI_BIN: nonExec }, () => {
  try {
    resolvePiBinarySync();
  } catch (e) {
    threw2 = true;
    errMsg2 = (e as Error).message;
  }
});
assert(threw2, "throws when PI_ENSEMBLE_PI_BIN is not executable");
assert(errMsg2.includes("PI_ENSEMBLE_PI_BIN"), "non-exec error names the env var");
rmFile(nonExec);

// --- Package bin found (deterministic: injected package path -> bin resolved) ---
{
  const tmpDir = mkTmpDir("pi-resolve-test-pkg");
  const fakePkgJson = path.join(tmpDir, "package.json");
  writeFileSync(fakePkgJson, JSON.stringify({ name: "fake", bin: { pi: "cli.js" } }));
  writeFileSync(path.join(tmpDir, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });

  const resolved = resolvePackageBin(fakePkgJson);
  assert(resolved !== null, "resolvePackageBin finds the bin");
  assert(resolved === path.join(tmpDir, "cli.js"), `path is ${path.join(tmpDir, "cli.js")}`);

  rmDir(tmpDir);
}

// --- Package bin not found (deterministic: package absent -> "path") ---
{
  const missing = path.join(os.tmpdir(), "does-not-exist-12345", "package.json");
  const resolved = resolvePackageBin(missing);
  assert(resolved === null, "resolvePackageBin returns null when package.json missing");

  _resetPiBinaryCache();
  withEnv({ PI_ENSEMBLE_PI_BIN: undefined }, () => {
    const fallback = resolvePiBinarySync();
    assert(fallback.source === "path", "sync resolution falls back to PATH");
    assert(fallback.path === "pi", "path is 'pi'");
    assert(fallback.command === "pi", "command is 'pi'");
  });
}

// --- Package bin not executable ---
{
  const tmpDir2 = mkTmpDir("pi-resolve-test-pkg2");
  const fakePkgJson2 = path.join(tmpDir2, "package.json");
  writeFileSync(fakePkgJson2, JSON.stringify({ name: "fake", bin: "cli.js" }));
  writeFileSync(path.join(tmpDir2, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o644 });

  const resolved = resolvePackageBin(fakePkgJson2);
  assert(resolved === null, "resolvePackageBin returns null when bin is not executable");

  rmDir(tmpDir2);
}

// --- Package bin escaping the package directory is rejected ---
{
  const tmpDir3 = mkTmpDir("pi-resolve-test-pkg3");
  const outsideBin = mkTmpDir("pi-resolve-test-outerbin");
  const outsideBinPath = path.join(outsideBin, "evil.js");
  writeFileSync(outsideBinPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  const fakePkgJson3 = path.join(tmpDir3, "package.json");
  writeFileSync(
    fakePkgJson3,
    JSON.stringify({ name: "fake", bin: `../../${path.basename(outsideBin)}/evil.js` }),
  );

  const resolved = resolvePackageBin(fakePkgJson3);
  assert(
    resolved === null,
    "resolvePackageBin rejects a bin that resolves outside the package directory",
  );

  rmDir(tmpDir3);
  rmDir(outsideBin);
}

// ---------------------------------------------------------------------------
// getPiInvocation — backward-compatible interface
// ---------------------------------------------------------------------------

section("getPiInvocation");

// PATH/source path (argv[1] is this test file, not Pi CLI)
_resetPiBinaryCache();
withEnv({ PI_ENSEMBLE_PI_BIN: undefined }, () => {
  const inv = getPiInvocation(["--mode", "rpc"]);
  // In dev env, the package is installed so it resolves to the package bin
  assert(inv.args.includes("--mode"), "args contain the passed args");
  assert(inv.args.includes("rpc"), "args contain 'rpc'");
  assert(typeof inv.command === "string" && inv.command.length > 0, "command is set");
});

// Simulate Pi process (argv[1] looks like Pi CLI)
_resetPiBinaryCache();
withEnv({ PI_ENSEMBLE_PI_BIN: undefined }, () => {
  assert(
    looksLikePiCli("/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "Pi CLI path is recognized",
  );
});

// ---------------------------------------------------------------------------
// getPiResolutionInfo — async version probe
// ---------------------------------------------------------------------------

section("getPiResolutionInfo");

// Use a fake pi binary that responds to --version
{
  _resetPiBinaryCache();
  _resetVerifiedVersionCache();

  const fakeBin = makeFakeBin(
    "fake-pi-ver",
    'if [ "$1" = "--version" ]; then echo \'pi 0.9.0\'; fi',
  );
  const info = withEnv({ PI_ENSEMBLE_PI_BIN: fakeBin }, () => getPiResolutionInfo());
  const resolvedInfo = await info;
  assert(resolvedInfo.source === "env", "resolution source is env");
  assert(resolvedInfo.path === fakeBin, "path matches env value");
  assert(
    resolvedInfo.version === "0.9.0",
    `version parsed as 0.9.0 (got: ${resolvedInfo.version})`,
  );
  assert(resolvedInfo.probeTimedOut === undefined, "no timeout for fast response");
  rmFile(fakeBin);
}

// Version probe with a non-responsive binary (timeout path)
{
  _resetPiBinaryCache();
  _resetVerifiedVersionCache();

  const slowBin = makeFakeBin("slow-pi", "sleep 5");
  const start = Date.now();
  const info = withEnv({ PI_ENSEMBLE_PI_BIN: slowBin }, () => getPiResolutionInfo());
  const resolvedInfo = await info;
  const elapsed = Date.now() - start;
  assert(resolvedInfo.version === null, "version is null on timeout");
  assert(resolvedInfo.probeTimedOut === true, "probeTimedOut is true");
  assert(elapsed < 5000, `probe timed out before 5s (took ${elapsed}ms)`);
  rmFile(slowBin);
}

// Unparseable version output
{
  _resetPiBinaryCache();
  _resetVerifiedVersionCache();

  const garbageBin = makeFakeBin("garbage-pi", "echo 'I am not a version'");
  const info = withEnv({ PI_ENSEMBLE_PI_BIN: garbageBin }, () => getPiResolutionInfo());
  const resolvedInfo = await info;
  assert(resolvedInfo.version === null, "version is null for unparseable output");
  assert(resolvedInfo.probeTimedOut === undefined, "not a timeout, just unparseable");
  rmFile(garbageBin);
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

section("Caching");

_resetPiBinaryCache();
withEnv({ PI_ENSEMBLE_PI_BIN: undefined }, () => {
  const first = resolvePiBinarySync();
  const second = resolvePiBinarySync();
  assert(first === second, "same object returned on second call (cached)");
});

// ---------------------------------------------------------------------------
// Probe wiring — the first child spawn kicks the version probe exactly once
// and never waits on it.
// ---------------------------------------------------------------------------

section("probe wiring");

{
  _resetPiBinaryCache();
  _resetVerifiedVersionCache();
  const { _resetPiResolutionProbeFlag, kickPiResolutionProbe } = await import("../src/spawn.ts");

  // Fake pi: appends to a counter file on --version.
  const probeFakeBin = makeFakeBin(
    "probe-wiring-pi",
    [
      'if [ "$1" = "--version" ]; then',
      '  echo probe-count >> "$COUNTER_FILE" 2>/dev/null',
      "  echo 'pi 1.0.0'",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  const counterFile = path.join(os.tmpdir(), `pi-rukas-probe-count-${process.pid}-${Date.now()}`);
  const priorCounterFile = process.env.COUNTER_FILE;
  const priorPiBin = process.env.PI_ENSEMBLE_PI_BIN;
  process.env.COUNTER_FILE = counterFile;
  process.env.PI_ENSEMBLE_PI_BIN = probeFakeBin;

  try {
    _resetPiBinaryCache();
    _resetVerifiedVersionCache();
    _resetPiResolutionProbeFlag();

    // The kick returns synchronously (void) and must not block.
    const start = Date.now();
    kickPiResolutionProbe();
    const elapsed = Date.now() - start;
    assert(elapsed < 100, `kickPiResolutionProbe returns synchronously (took ${elapsed}ms)`);

    // Second call is a no-op (once-flag is set).
    kickPiResolutionProbe();

    // Await the cached probe promise to let the child process finish.
    await new Promise((r) => setTimeout(r, 500));
    const probeRuns = readFileSyncSafe(counterFile);
    assert(
      probeRuns.trim() === "probe-count",
      `the first kick triggered the probe exactly once (got: ${JSON.stringify(probeRuns.trim())})`,
    );
  } finally {
    const restoreEnv = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restoreEnv("COUNTER_FILE", priorCounterFile);
    restoreEnv("PI_ENSEMBLE_PI_BIN", priorPiBin);
    rmFile(probeFakeBin);
    rmFile(counterFile);
    _resetPiBinaryCache();
    _resetVerifiedVersionCache();
    _resetPiResolutionProbeFlag();
  }
}

function readFileSyncSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(exit);
