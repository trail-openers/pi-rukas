#!/usr/bin/env bun
/**
 * #978 — bin/pi-rukas fails when invoked through a symlink.
 *
 * install.sh symlinks only `bin/pi-rukas` into ~/.local/bin; the helper
 * `lib-pi-rukas-shell.sh` is NOT symlinked. The pre-fix source line
 * `source "${BASH_SOURCE[0]%/*}/lib-pi-rukas-shell.sh"` resolves relative
 * to the unresolved BASH_SOURCE[0], so any symlink invocation aborts at
 * that line with "No such file or directory".
 *
 * This test proves the resolver fix works for:
 *   (a) one-level absolute symlink
 *   (b) two-level chain with a relative-target intermediate link
 *   (c) direct invocation (no symlink)
 *   (d) two-link cycle (a→b, b→a) — bounded loop, exits non-zero with
 *       "symlink cycle" in stderr (timeout-guarded at 10s)
 *
 * Plus a canary: a self-contained hardcoded pre-fix shim (no string-scanning
 * of the live bin/pi-rukas) that fails when invoked via symlink from a
 * helper-less directory — and works when invoked directly, proving the
 * failure is attributable to the symlink, not the shim.
 *
 * All invocations use `--help` (exits 0 without docker/network).
 * Temp dirs are created under `os.tmpdir()` and realpathSync'd where the
 * assertion needs canonical paths (macOS /tmp → /private/tmp).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BIN_DIR = path.join(REPO_ROOT, "bin");
const SCRIPT = path.join(BIN_DIR, "pi-rukas");
const HELPER = path.join(BIN_DIR, "lib-pi-rukas-shell.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Invoke a path to pi-rukas with --help via bash.
 * Returns { exitCode, stderr }.
 */
function invokeHelp(
  target: string,
  timeoutMs = 0,
): { exitCode: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync("bash", [target, "--help"], {
      encoding: "utf8",
      stdio: "pipe",
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    // Narrow with type guards — the cast is confined to the minimal shape read
    // (same convention as test-os-guard.ts); the `??` coercions below are
    // load-bearing, since the guarded fields are optional but the return type
    // is non-optional.
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null;
    const err = isRecord(e) ? e : { message: String(e) };
    const status = typeof err.status === "number" ? err.status : undefined;
    const stderr = typeof err.stderr === "string" ? err.stderr : undefined;
    const stdout = typeof err.stdout === "string" ? err.stdout : undefined;
    const message = typeof err.message === "string" ? err.message : undefined;
    const spawnFailed = status === undefined;
    return {
      exitCode: status ?? 1,
      stdout: stdout ?? "",
      stderr: spawnFailed
        ? `spawn failed (no exit status): ${message ?? String(e)}`
        : (stderr ?? ""),
    };
  }
}

/**
 * Invoke a bash script with args via execFileSync.
 * Returns { exitCode, stderr }.
 */
function execFileSyncSafe(
  script: string,
  ...args: string[]
): { exitCode: number; stderr: string } {
  try {
    execFileSync("bash", [script, ...args], { encoding: "utf8", stdio: "pipe", timeout: 10_000 });
    return { exitCode: 0, stderr: "" };
  } catch (e: unknown) {
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null;
    const err = isRecord(e) ? e : { message: String(e) };
    const status = typeof err.status === "number" ? err.status : undefined;
    const stderr = typeof err.stderr === "string" ? err.stderr : undefined;
    const message = typeof err.message === "string" ? err.message : undefined;
    const spawnFailed = status === undefined;
    return {
      exitCode: status ?? 1,
      stderr: spawnFailed ? `spawn failed: ${message ?? String(e)}` : (stderr ?? ""),
    };
  }
}

// ---------------------------------------------------------------------------
// (a) One-level absolute symlink
// ---------------------------------------------------------------------------

{
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-rukas-sym-a-")));
  try {
    const link = path.join(d, "pi-rukas");
    symlinkSync(SCRIPT, link);
    const r = invokeHelp(link);
    assert(r.exitCode === 0, "a: one-level absolute symlink exits 0");
    assert(
      !r.stderr.includes("No such file or directory"),
      "a: no 'No such file or directory' in stderr",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (b) Two-level chain with a relative-target intermediate link
// ---------------------------------------------------------------------------

{
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-rukas-sym-b-")));
  try {
    // Intermediate link: relative target "pi-rukas-alias" pointing to the absolute SCRIPT.
    // Final link: "pi-rukas" pointing to relative "pi-rukas-alias" (same dir).
    const alias = path.join(d, "pi-rukas-alias");
    const link = path.join(d, "pi-rukas");
    // Intermediate: alias → absolute target
    symlinkSync(SCRIPT, alias);
    // Final link: relative target to the intermediate (same directory)
    symlinkSync("pi-rukas-alias", link);
    const r = invokeHelp(link);
    assert(r.exitCode === 0, "b: two-level chain with relative intermediate exits 0");
    assert(
      !r.stderr.includes("No such file or directory"),
      "b: no 'No such file or directory' in stderr",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (c) Direct invocation (no symlink)
// ---------------------------------------------------------------------------

{
  const r = invokeHelp(SCRIPT);
  assert(r.exitCode === 0, "c: direct bin/pi-rukas --help exits 0");
  assert(
    !r.stderr.includes("No such file or directory"),
    "c: no 'No such file or directory' in stderr",
  );
}

// ---------------------------------------------------------------------------
// (d) Symlink cycle — bounded resolver loop
// ---------------------------------------------------------------------------
//
// On macOS, bash itself cannot stat a bare symlink cycle (ENAMETOOLONG), so
// `bash <cyclic-link>` fails before the resolver runs (status 126). To
// exercise the resolver's own cycle guard we call the resolver logic with the
// cycle path as $1 — [ -L ] and readlink work on individual path components
// without stat'ing the full target, so the loop actually runs.

{
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-rukas-sym-d-")));
  try {
    // Wrapper that runs the same resolver loop as bin/pi-rukas with $1 as
    // the starting path. This isolates the guard from bash's own stat
    // limitation on cyclic paths.
    const wrapper = path.join(d, "wrap.sh");
    const resolverLines = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "_link=\"$1\"; _hops=0",
      "while [ -L \"$_link\" ]; do",
      "  _hops=$(( _hops + 1 )); [ \"$_hops\" -le 40 ] || { echo \"pi-rukas: symlink cycle near $_link\" >&2; exit 1; }",
      "  _tgt=\"$(readlink \"$_link\")\" || { echo \"pi-rukas: failed to resolve symlink chain at $_link\" >&2; exit 1; }",
      "  case \"$_tgt\" in /*) _link=\"$_tgt\" ;; *) _link=\"$(cd \"$(dirname \"$_link\")\" && pwd -P)/$_tgt\" ;; esac",
      "done",
      "echo resolved:$_link",
    ];
    writeFileSync(wrapper, resolverLines.join("\n"));
    chmodSync(wrapper, 0o755);

    // Two-link cycle: a → b, b → a
    const a = path.join(d, "a");
    const b = path.join(d, "b");
    symlinkSync(b, a);
    symlinkSync(a, b);

    const r = execFileSyncSafe(wrapper, a);
    assert(r.exitCode !== 0, "d: resolver loop on a two-link cycle exits non-zero");
    assert(r.stderr.includes("symlink cycle"), "d: failure message names the symlink cycle");

    // Positive: a valid 30-hop chain resolves without tripping the guard
    const shim = path.join(d, "shim");
    writeFileSync(shim, "#!/bin/sh\necho ok\n");
    let prev = shim;
    for (let i = 0; i < 30; i++) {
      const next = path.join(d, `l${i}`);
      symlinkSync(prev, next);
      prev = next;
    }
    const r2 = execFileSyncSafe(wrapper, prev);
    assert(r2.exitCode === 0, "d: 30-hop chain resolves without tripping the guard");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Canary: hardcoded pre-fix shim (no string-scanning of the live script)
// ---------------------------------------------------------------------------

{
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-rukas-sym-c-")));
  try {
    // Self-contained shim reproducing the pre-fix source line. It is
    // hardcoded here — independent of bin/pi-rukas's current content — so a
    // future resolver refactor cannot silently invalidate the canary.
    const shim =
      "#!/usr/bin/env bash\nset -euo pipefail\nsource \"${BASH_SOURCE[0]%/*}/lib-pi-rukas-shell.sh\"\necho ok\n";

    // Helper-less dir: contains the helper (so the positive control works)
    // but the symlink to the shim lives in a separate dir without one.
    const shimDir = path.join(d, "bin");
    mkdirSync(shimDir);
    const shimPath = path.join(shimDir, "pi-rukas");
    writeFileSync(shimPath, shim);
    chmodSync(shimPath, 0o755);
    copyFileSync(HELPER, path.join(shimDir, "lib-pi-rukas-shell.sh"));

    // Positive control: direct invocation finds the helper next to the shim.
    const direct = invokeHelp(shimPath);
    assert(direct.exitCode === 0, "canary: pre-fix shim invoked directly exits 0 (positive control)");

    // Negative: symlink from a helper-less dir — BASH_SOURCE[0] is the link,
    // so the source line resolves the helper next to the link, not the shim.
    const invokeDir = path.join(d, "invoke");
    mkdirSync(invokeDir);
    const link = path.join(invokeDir, "pi-rukas");
    symlinkSync(shimPath, link);
    const r = invokeHelp(link);
    assert(r.exitCode !== 0, "canary: pre-fix shim via symlink exits non-zero");
    assert(
      r.stderr.includes("No such file or directory"),
      "canary: failure is 'No such file or directory' (the source line, not a permission error)",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
