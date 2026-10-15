#!/usr/bin/env bun
/**
 * #1366 — bin/pi-rukas-headless fails when invoked through a symlink.
 *
 * The image links /usr/local/bin/pi-rukas-headless → /opt/pi-rukas/bin/
 * pi-rukas-headless. The pre-fix script took its dir from the unresolved
 * BASH_SOURCE[0], so the PATH name looked for cli.ts under
 * /usr/local/bin/../extension and bun exited with "Module not found".
 *
 * Blocks:
 *   1. one-level absolute symlink from an unrelated dir: --capabilities
 *      exits 0 and prints JSON with a schemaVersion
 *   2. two-level chain with a relative-target intermediate link
 *   3. direct invocation (no symlink)
 *   4. the resolver block between the `# >>> symlink-resolver` markers is
 *      identical to bin/pi-rukas's, whose cycle and long-chain cases
 *      test-pi-rukas-symlink.ts covers
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "bin", "pi-rukas-headless");
const LAUNCHER = path.join(REPO_ROOT, "bin", "pi-rukas");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Run `<target> --capabilities` from a neutral cwd; returns exit code, stdout, stderr. */
function capabilities(
  target: string,
  cwd: string,
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [target, "--capabilities"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const err = isRecord(e) ? e : {};
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : String(e),
    };
  }
}

function hasSchemaVersion(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null && "schemaVersion" in parsed;
  } catch {
    return false;
  }
}

function check(label: string, target: string, cwd: string) {
  const r = capabilities(target, cwd);
  assert(
    r.code === 0,
    `${label}: --capabilities exits 0${r.code === 0 ? "" : ` (stderr: ${r.stderr.trim()})`}`,
  );
  assert(!r.stderr.includes("Module not found"), `${label}: no 'Module not found' in stderr`);
  assert(hasSchemaVersion(r.stdout), `${label}: stdout is JSON with schemaVersion`);
}

const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-rukas-headless-sym-")));
try {
  // 1. One-level absolute symlink, the image's /usr/local/bin layout.
  const link = path.join(d, "pi-rukas-headless");
  symlinkSync(SCRIPT, link);
  check("a: absolute symlink", link, d);

  // 2. Chain: final link → relative "alias" → absolute script.
  const alias = path.join(d, "alias");
  const chained = path.join(d, "chained");
  symlinkSync(SCRIPT, alias);
  symlinkSync("alias", chained);
  check("b: two-level chain with relative intermediate", chained, d);

  // 3. Direct invocation still works.
  check("c: direct", SCRIPT, d);
} finally {
  rmSync(d, { recursive: true, force: true });
}

// 4. The two resolver copies must not drift apart.
function resolverBlock(file: string): string {
  const lines = readFileSync(file, "utf8").split("\n");
  const open = lines.findIndex((l) => l.startsWith("# >>> symlink-resolver"));
  const close = lines.findIndex((l) => l.startsWith("# <<< symlink-resolver"));
  if (open === -1 || close === -1 || close < open) {
    throw new Error(`symlink-resolver markers missing or out of order in ${file}`);
  }
  return lines.slice(open + 1, close).join("\n");
}
assert(
  resolverBlock(SCRIPT) === resolverBlock(LAUNCHER),
  "d: pi-rukas-headless resolver block is identical to bin/pi-rukas's",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
