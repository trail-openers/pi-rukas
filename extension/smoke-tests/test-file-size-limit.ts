#!/usr/bin/env bun
/**
 * File-size ratchet — AGENTS.md §12 hard limit (500 lines/file).
 *
 * §12 reads as a repo-wide rule. It was enforced over TypeScript in exactly
 * two directories, both under `extension/`. Invisible to it: `install.sh`,
 * `build.sh`, `.devcontainer/entrypoint.sh`, and every file in
 * `.github/workflows/`. `build.sh` sits at **499 lines** — one line under the
 * cap, entirely unmeasured, and the next edit would have pushed it over in
 * silence while the gate reported compliance.
 *
 * The same gap reopened for **extensionless** files: `bin/pi-ensemble` (the
 * Docker launch wrapper) is a shebang'd bash script with no extension, so an
 * extension-matched scan never saw it — it sat at 542 lines, 42 over the cap,
 * while CI reported compliance. #353 (Fedora/rootless podman support) plans to
 * edit it, and every line it added would have pushed the file further over
 * with the gate still green.
 *
 * That is the same defect class this suite keeps finding elsewhere: a gate
 * whose scope is narrower than its stated contract, so its silence reads as
 * proof. The scan is now the whole repository, and shebang'd executables are
 * in scope regardless of extension.
 *
 * **Source, not prose.** The limit is about code a person has to hold in their
 * head, so it covers `.ts`, `.sh`, workflow YAML and extensionless executables.
 * Markdown, JSON and data files are excluded deliberately, not by oversight:
 * `docs/troubleshooting.md` is 1399 lines and should be, and a 500-line cap on
 * documentation would produce a wall of noise that trains everyone to set
 * `PI_ENSEMBLE_SIZE_RATCHET=0`. A shebang is the executable's declaration of
 * "this is a program"; the execute bit alone is not (a generated data file
 * marked +x is still data), so only `#!`-prefixed files count.
 *
 * **Proven in both directions.** A gate never observed to fail is worthless —
 * this repo's own file-size ratchet shipped with three separate fail-open bugs
 * that each passed CI green, including a counter incremented inside a piped
 * `while` loop, which lives in a subshell and is therefore always zero. So
 * this asserts not only that the repo is clean but that a deliberately
 * oversized fixture IS caught — one with an extension, one extensionless.
 *
 * Escape hatch: `PI_ENSEMBLE_SIZE_RATCHET=0`.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HARD_LIMIT = 500;
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

/** Extensions the limit applies to: things a person reads as logic. */
const SOURCE_EXTENSIONS = [".ts", ".sh", ".yml", ".yaml"];

/**
 * Directories never scanned, named explicitly.
 *
 * An implicit exclusion is indistinguishable from a gap, which is how the old
 * `["src", "smoke-tests"]` scope survived: nothing said whether the rest of
 * the repo was exempt or forgotten.
 */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules", // dependencies — not ours
  "dist", // build output — generated
  ".worktrees", // driver scaffolding
  "tmp", // scratch
  "outputs", // research artefacts
  "parallel-research", // research artefacts
  "skill", // vendored skill content
]);

function isExecutableScript(file: string): boolean {
  // An extensionless file is in scope only if it declares itself a program.
  // The execute bit is deliberately NOT the test — it is set on generated
  // data files and build output too, which are not code a person reads.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (SOURCE_EXTENSIONS.some((e) => file.endsWith(e))) return false;
  const head = readFileSync(file, { maxBytes: 2 }).toString("utf8");
  return head.startsWith("#!");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // unreadable dir is not a violation
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue; // a broken symlink is not a violation
    }
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((e) => entry.endsWith(e)) && !entry.endsWith(".d.ts")) {
      out.push(full);
    } else if (isExecutableScript(full)) {
      out.push(full);
    }
  }
  return out;
}

function lineCount(file: string): number {
  const text = readFileSync(file, "utf8");
  // Count newlines; a trailing-newline-terminated file of N lines has N
  // newline characters, matching `wc -l` exactly.
  return (text.match(/\n/g) ?? []).length;
}

/** Exported shape so the both-directions check below can call it on a fixture. */
export function findOversized(root: string, limit = HARD_LIMIT): { file: string; lines: number }[] {
  return listSourceFiles(root)
    .map((file) => ({ file: path.relative(root, file), lines: lineCount(file) }))
    .filter((f) => f.lines > limit)
    .sort((a, b) => b.lines - a.lines);
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

if (process.env.PI_ENSEMBLE_SIZE_RATCHET === "0") {
  console.log("PI_ENSEMBLE_SIZE_RATCHET=0 — file-size gate skipped.");
  process.exit(0);
}

// ---------------------------------------------- the gate CAN fail

{
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-sizegate-"));
  try {
    writeFileSync(path.join(fixtureRoot, "fine.ts"), "x\n".repeat(10));
    writeFileSync(path.join(fixtureRoot, "toolong.sh"), "echo x\n".repeat(HARD_LIMIT + 1));
    // Extensionless, shebang'd, oversized — the #493 gap class: an executable
    // that the extension-matched scan was blind to.
    const extensionless = path.join(fixtureRoot, "toolong-tool");
    writeFileSync(extensionless, "#!/bin/sh\n".repeat(HARD_LIMIT + 1));
    // Extensionless, no shebang — must NOT be in scope (data, not logic).
    writeFileSync(path.join(fixtureRoot, "data-blob"), "x\n".repeat(HARD_LIMIT + 1));
    const found = findOversized(fixtureRoot);
    const foundFiles = found.map((f) => f.file);
    assert(
      foundFiles.length === 2 &&
        foundFiles.includes("toolong.sh") &&
        foundFiles.includes("toolong-tool"),
      `canary: oversized fixtures WITH and WITHOUT an extension are both caught (found ${JSON.stringify(foundFiles)}) — a gate never observed to fail is worthless`,
    );
    assert(
      !foundFiles.includes("data-blob"),
      "...and an extensionless non-shebang file is out of scope (data, not logic)",
    );
    const byFile = new Map(found.map((f) => [f.file, f.lines]));
    assert(
      byFile.get("toolong.sh") === HARD_LIMIT + 1 && byFile.get("toolong-tool") === HARD_LIMIT + 1,
      `...with their real line counts (sh=${byFile.get("toolong.sh")}, extensionless=${byFile.get("toolong-tool")})`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------- and the repo is clean

const violations = findOversized(REPO_ROOT);
if (violations.length === 0) {
  assert(
    true,
    `every source file in the repo (${SOURCE_EXTENSIONS.join("/")} + shebang'd executables) is ≤ ${HARD_LIMIT} lines`,
  );
} else {
  for (const v of violations) {
    assert(false, `${v.file}: ${v.lines} lines (exceeds ${HARD_LIMIT}-line hard limit)`);
  }
}

// The scope must actually reach outside extension/, or this is the old gate
// with a longer docstring.
{
  const scanned = listSourceFiles(REPO_ROOT).map((f) => path.relative(REPO_ROOT, f));
  // #1788's acceptance criterion says "no file exceeds 500 lines", and the
  // feature added six modules plus a bin script. A criterion is only worth
  // what its gate actually measures, so the feature's own files are named here
  // — an exclusion that hides them would read as compliance.
  for (const expected of [
    "install.sh",
    "build.sh",
    ".github/workflows/ci.yml",
    "bin/pi-rukas",
    "extension/src/public-denylist.ts",
    "extension/src/public-hygiene-scan.ts",
    "extension/src/public-hygiene-guard.ts",
    "extension/src/public-hygiene-push.ts",
    "extension/src/public-hygiene-refusals.ts",
    "extension/src/public-hygiene-types.ts",
    "bin/pre-push-hygiene.sh",
  ]) {
    assert(
      scanned.includes(expected),
      `canary: ${expected} is in scope — it was invisible to the old extension/-only scan`,
    );
  }
  // Closest-to-limit, so the next file to breach is known before it does.
  // build.sh sat at 499 while entirely unmeasured.
  const nearest = listSourceFiles(REPO_ROOT)
    .map((f) => ({ file: path.relative(REPO_ROOT, f), lines: lineCount(f) }))
    .sort((a, b) => b.lines - a.lines)[0];
  if (nearest) {
    console.log(`  closest to the limit: ${nearest.file} at ${nearest.lines}/${HARD_LIMIT} lines`);
  }
}

console.log(exit === 0 ? "\nAll file-size checks passed." : "\nFAILED");
process.exit(exit);
