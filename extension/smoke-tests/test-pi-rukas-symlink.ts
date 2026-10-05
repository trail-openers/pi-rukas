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
 *
 * Plus a canary: stage a temp copy of bin/ with the resolver replaced by
 * the literal pre-fix line, and assert it FAILS when invoked via symlink
 * from a helper-less directory.
 *
 * All invocations use `--help` (exits 0 without docker/network).
 * Temp dirs are created under `os.tmpdir()` and realpathSync'd where the
 * assertion needs canonical paths (macOS /tmp → /private/tmp).
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
function invokeHelp(target: string): { exitCode: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync("bash", [target, "--help"], {
      encoding: "utf8",
      stdio: "pipe",
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
// Canary: pre-fix resolver line FAILS via symlink from a helper-less dir
// ---------------------------------------------------------------------------

{
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-rukas-sym-c-")));
  try {
    // Stage a temp copy of bin/ including the real helper.
    const tmpBin = path.join(d, "bin");
    mkdirSync(tmpBin, { recursive: true });
    copyFileSync(SCRIPT, path.join(tmpBin, "pi-rukas"));
    copyFileSync(HELPER, path.join(tmpBin, "lib-pi-rukas-shell.sh"));
    chmodSync(path.join(tmpBin, "pi-rukas"), 0o755);

    // Replace the resolver with the literal pre-fix line.
    const content = readFileSync(path.join(tmpBin, "pi-rukas"), "utf8");
    // The pre-fix line is the source using BASH_SOURCE[0] directly.
    // We need to find the current source line and replace the entire resolver block.
    // The resolver block starts with the comment line and ends at the source line.
    const fixedSourceLine = 'source "$helper"';
    const preFixLine = 'source "${BASH_SOURCE[0]%/*}/lib-pi-rukas-shell.sh"';
    // The copy is of the current (fixed) bin/pi-rukas, so the fixed line is
    // always present; fail loudly rather than guessing a mutation strategy.
    assert(
      content.includes(fixedSourceLine),
      "canary: fixed source line present in the staged copy",
    );
    // Remove the resolver comment + loop lines and the PI_RUKAS_DIR/REPO_DIR line,
    // then replace the source line with the pre-fix version.
    const lines = content.split("\n");
    const out: string[] = [];
    let inResolver = false;
    for (const line of lines) {
      if (line.includes("# Resolve this script's real dir")) {
        inResolver = true;
        out.push(preFixLine);
        continue;
      }
      if (inResolver) {
        if (line.includes(fixedSourceLine)) {
          inResolver = false;
          continue; // skip the fixed source line; preFixLine already emitted
        }
        // Skip resolver body lines (_link, case, PI_RUKAS_DIR/REPO_DIR)
        continue;
      }
      out.push(line);
    }
    writeFileSync(path.join(tmpBin, "pi-rukas"), out.join("\n"));
    chmodSync(path.join(tmpBin, "pi-rukas"), 0o755);

    // Now create a symlink in a DIFFERENT dir that does NOT contain the helper.
    const invokeDir = path.join(d, "invoke");
    mkdirSync(invokeDir, { recursive: true });
    const link = path.join(invokeDir, "pi-rukas");
    symlinkSync(path.join(tmpBin, "pi-rukas"), link);

    const r = invokeHelp(link);
    assert(r.exitCode !== 0, "canary: pre-fix line via symlink exits non-zero");
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
