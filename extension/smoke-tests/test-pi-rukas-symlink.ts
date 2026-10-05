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
 *   (e) self-referencing symlink (c→c) — same, via the LIVE resolver bytes
 *       extracted from bin/pi-rukas
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
function invokeHelp(
  target: string,
  timeoutMs = 0,
  ...args: string[]
): { exitCode: number; stderr: string; stdout: string } {
  // No extra args → --help (exits 0 without docker/network).
  const argv = args.length === 0 ? ["--help"] : args;
  try {
    const stdout = execFileSync("bash", [target, ...argv], {
      encoding: "utf8",
      stdio: "pipe",
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    // Narrow with type guards — the narrowing is confined to the minimal
    // shape read (same convention as test-os-guard.ts); the `??` coercions
    // below are load-bearing, since the guarded fields are optional but the
    // return type is non-optional.
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
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
    const resolved = liveResolverWrapper();
    writeFileSync(wrapper, resolved);
    chmodSync(wrapper, 0o755);

    // Two-link cycle: a → b, b → a
    const a = path.join(d, "a");
    const b = path.join(d, "b");
    symlinkSync(b, a);
    symlinkSync(a, b);

    const r = invokeHelp(wrapper, 10_000, a);
    assert(r.exitCode !== 0, "d: resolver loop on a two-link cycle exits non-zero");
    assert(r.stderr.includes("symlink cycle"), "d: failure message names the symlink cycle");

    // Self-referencing symlink: c → c. Same isolation rationale as the
    // two-link case above: on macOS bash cannot stat a bare symlink cycle
    // (ENAMETOOLONG), so the wrapper is handed the link as $1 and runs the
    // live resolver's own loop on it. The loop must terminate on the hop
    // guard (exit 1) well inside the 10s timeout.
    const self = path.join(d, "self");
    symlinkSync("self", self);
    const rSelf = invokeHelp(wrapper, 10_000, self);
    assert(rSelf.exitCode !== 0, "e: self-referencing symlink exits non-zero");
    assert(rSelf.stderr.includes("symlink cycle"), "e: failure message names the symlink cycle");
    assert(
      !rSelf.stderr.includes("timeout"),
      "e: loop terminates via the hop guard, not the timeout",
    );

    // Positive: a valid 30-hop chain resolves without tripping the guard
    const shim = path.join(d, "shim");
    writeFileSync(shim, "#!/bin/sh\necho ok\n");
    let prev = shim;
    for (let i = 0; i < 30; i++) {
      const next = path.join(d, `l${i}`);
      symlinkSync(prev, next);
      prev = next;
    }
    const r2 = invokeHelp(wrapper, 0, prev);
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
      '#!/usr/bin/env bash\nset -euo pipefail\nsource "${BASH_SOURCE[0]%/*}/lib-pi-rukas-shell.sh"\necho ok\n';

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
    assert(
      direct.exitCode === 0,
      "canary: pre-fix shim invoked directly exits 0 (positive control)",
    );

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

/**
 * Build the (d)-case wrapper from the LIVE bytes of bin/pi-rukas.
 *
 * The explicit contract: bin/pi-rukas wraps the resolver loop in
 * `# >>> symlink-resolver` / `# <<< symlink-resolver` marker lines. This
 * test extracts the lines strictly BETWEEN the two markers and fails loudly
 * if either marker is missing, duplicated, or out of order — a resolver
 * refactor that moves or rewrites the loop must update the markers
 * (and this test) deliberately.
 *
 * The extracted block must contain `while [ -L` and `readlink` (the live
 * resolver loop, not a rewrite) and its first line's `${BASH_SOURCE[0]}`
 * is substituted by `$1` so the wrapper receives the path under test as its
 * argument.
 */
function liveResolverWrapper(): string {
  const OPEN_MARKER = "# >>> symlink-resolver";
  const CLOSE_MARKER = "# <<< symlink-resolver";
  const bin = readFileSync(SCRIPT, "utf8");
  const lines = bin.split("\n");
  const opens = lines
    .map((l, i) => (l.trimStart().startsWith(OPEN_MARKER) ? i : -1))
    .filter((i) => i !== -1);
  const closes = lines
    .map((l, i) => (l.trimStart().startsWith(CLOSE_MARKER) ? i : -1))
    .filter((i) => i !== -1);
  if (opens.length === 0 || closes.length === 0) {
    throw new Error(
      `symlink-resolver marker missing in bin/pi-rukas (opens=${opens.length}, closes=${closes.length}) — update the script and this test deliberately`,
    );
  }
  if (opens.length > 1 || closes.length > 1) {
    throw new Error(
      `duplicate symlink-resolver marker in bin/pi-rukas (opens=${opens.length}, closes=${closes.length}) — update the script and this test deliberately`,
    );
  }
  const [start] = opens;
  const [end] = closes;
  if (end < start) {
    throw new Error(
      `symlink-resolver markers out of order in bin/pi-rukas (open=${start}, close=${end}) — update the script and this test deliberately`,
    );
  }
  const block = lines.slice(start + 1, end);
  const joined = block.join("\n");
  if (!joined.includes('_link="${BASH_SOURCE[0]}"')) {
    throw new Error(
      'symlink-resolver block missing the _link="${BASH_SOURCE[0]}" line — update the script and this test deliberately',
    );
  }
  if (!joined.includes("while [ -L")) {
    throw new Error(
      "symlink-resolver block missing 'while [ -L' — the resolver loop moved or was rewritten; update the script and this test deliberately",
    );
  }
  if (!joined.includes("readlink")) {
    throw new Error(
      "symlink-resolver block missing readlink — the resolver loop moved or was rewritten; update the script and this test deliberately",
    );
  }
  const substituted = block.map((l) => l.replace('_link="${BASH_SOURCE[0]}"', '_link="$1"'));
  const body = ["#!/usr/bin/env bash", "set -euo pipefail", ...substituted, "echo resolved:$_link"]
    .join("\n")
    .concat("\n");
  return body;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
