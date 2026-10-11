#!/usr/bin/env bun
/**
 * Smoke test: pi binary resolver hardening + probe lifecycle (#1038).
 *
 * Split out of test-pi-binary-resolve.ts to keep both under the file-size gate.
 * Covers: realpath containment of the package bin, broken-symlink rejection,
 * one-shot version probe (failed spawn is cached, not re-run), spawn-failure
 * warning, and the PATH warning firing exactly once at resolution time.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePackageBin } from "../src/pi-binary-resolve.ts";
import { _resetPiVersionProbe, probePiVersion } from "../src/pi-version-probe.ts";

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

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  return {
    warnings,
    restore: () => {
      console.warn = origWarn;
    },
  };
}

section("package bin containment (realpath)");

// Symlink inside the package dir pointing outside is rejected (realpath check)
{
  const pkg = mkTmpDir("hard-pkg4");
  const outside = mkTmpDir("hard-outer4");
  const target = path.join(outside, "evil.js");
  writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
  symlinkSync(target, path.join(pkg, "cli.js"));
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: "cli.js" }));
  assert(
    resolvePackageBin(path.join(pkg, "package.json")) === null,
    "rejects a symlink escaping the package directory",
  );
  rmDir(pkg);
  rmDir(outside);
}

// Broken symlink bin is rejected without throwing
{
  const pkg = mkTmpDir("hard-pkg5");
  symlinkSync(path.join(pkg, "gone.js"), path.join(pkg, "cli.js"));
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: "cli.js" }));
  assert(
    resolvePackageBin(path.join(pkg, "package.json")) === null,
    "rejects a broken symlink bin",
  );
  rmDir(pkg);
}

section("version probe lifecycle");

// A missing PI_ENSEMBLE_PI_BIN makes resolvePiBinarySync throw synchronously
// inside the probe. It must resolve to version null with one warning, and the
// same (resolved, never rejected) promise must be cached for later callers.
{
  _resetPiVersionProbe();
  const cap = captureWarnings();
  try {
    const missing = path.join(os.tmpdir(), `pi-rukas-missing-bin-${process.pid}-${Date.now()}`);
    const first = withEnv({ PI_ENSEMBLE_PI_BIN: missing }, () => probePiVersion());
    const probe = await first;
    assert(
      probe.version === null,
      "missing PI_ENSEMBLE_PI_BIN: probe resolves to version null (not rejected)",
    );
    assert(
      withEnv({ PI_ENSEMBLE_PI_BIN: missing }, () => probePiVersion()) === first,
      "missing binary: probe promise identity is stable (one-shot)",
    );
    assert(
      cap.warnings.length === 1 &&
        cap.warnings[0]?.includes("pi-version-probe") === true &&
        cap.warnings[0]?.includes(missing) === true,
      `missing binary: exactly one warning (got ${cap.warnings.length})`,
    );
  } finally {
    cap.restore();
    _resetPiVersionProbe();
  }
}

// Spawn failure (a directory passes X_OK but cannot be spawned) warns visibly,
// and the probe is one-shot (#1038): the failed result stays cached.
{
  _resetPiVersionProbe();
  const dir = mkTmpDir("hard-unrunnable");
  const cap = captureWarnings();
  try {
    const first = withEnv({ PI_ENSEMBLE_PI_BIN: dir }, () => probePiVersion());
    const probe = await first;
    assert(
      probe.version === null && cap.warnings.some((w) => w.includes(dir)),
      "spawn failure warns, naming the command",
    );
    const second = probePiVersion();
    assert(second === first, "one-shot probe: a failed spawn is cached, not re-probed");
    await second;
    assert(
      cap.warnings.length === 1,
      `one-shot probe: spawn-failure warning emitted once (got ${cap.warnings.length})`,
    );
    assert(/\bE[A-Z]+: /.test(cap.warnings[0] ?? ""), "spawn-failure warning names the errno code");
  } finally {
    cap.restore();
    _resetPiVersionProbe();
    rmDir(dir);
  }
}

section("PATH warning");

// The PATH warning is returned as data on the first uncached resolution only
// (#1038). Run in a child process over a copy of src/ with no pi package, so the
// PATH branch is reached deterministically (the real install ships a package bin
// that short-circuits it). The child counts the warnings it receives across
// repeated resolution, so the count does not depend on stderr.
{
  const root = mkTmpDir("hard-pathwarn");
  cpSync(path.resolve(import.meta.dirname, "..", "src"), path.join(root, "src"), {
    recursive: true,
  });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "no-pi" }));
  const modUrl = path.join(root, "src", "pi-binary-resolve.ts");
  const script = `const m = await import(${JSON.stringify(modUrl)});\nconst rs = [m.resolvePiBinarySync(), m.resolvePiBinarySync(), m.resolvePiBinarySync()];\nconsole.log("REPORTED " + rs.filter((r) => r.warning).length);\nconsole.log("WARNING " + (rs[0].warning ?? ""));\nconsole.log("SOURCE " + rs[0].source);`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[0] !== "PI_ENSEMBLE_PI_BIN" && e[1] !== undefined,
    ),
  );
  const r = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  const out = r.stdout ?? "";
  const pathWarns = Number(/REPORTED (\d+)/.exec(out)?.[1] ?? "-1");
  assert(out.includes("SOURCE path"), `child resolves via PATH (stdout: ${out.trim()})`);
  assert(
    pathWarns === 1 && out.includes("WARNING ") && out.includes("resolved from PATH"),
    `PATH warning returned on exactly one of three resolutions (got ${pathWarns})`,
  );
  rmDir(root);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(exit);
