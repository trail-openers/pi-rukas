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
 * That is the same defect class this suite keeps finding elsewhere: a gate
 * whose scope is narrower than its stated contract, so its silence reads as
 * proof. The scan is now the whole repository.
 *
 * **Source, not prose.** The limit is about code a human has to hold in their
 * head, so it covers `.ts`, `.sh` and workflow YAML. Markdown and JSON are
 * excluded deliberately, not by oversight: `docs/troubleshooting.md` is 1399
 * lines and should be, and a 500-line cap on documentation would produce a
 * wall of noise that trains everyone to set `PI_ENSEMBLE_SIZE_RATCHET=0`.
 *
 * **Proven in both directions.** A gate never observed to fail is worthless —
 * lantern's own file-size ratchet shipped with three separate fail-open bugs
 * that each passed CI green, including a counter incremented inside a piped
 * `while` loop, which lives in a subshell and is therefore always zero. So
 * this asserts not only that the repo is clean but that a deliberately
 * oversized fixture IS caught.
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
    const found = findOversized(fixtureRoot);
    assert(
      found.length === 1 && found[0]?.file === "toolong.sh",
      `canary: an oversized fixture IS caught (found ${JSON.stringify(found)}) — a gate never observed to fail is worthless`,
    );
    // And a shell script is caught at all, which is the scope widening.
    assert(found[0]?.lines === HARD_LIMIT + 1, `...with its real line count (${found[0]?.lines})`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------- and the repo is clean

const violations = findOversized(REPO_ROOT);
if (violations.length === 0) {
  assert(true, `every ${SOURCE_EXTENSIONS.join("/")} file in the repo is ≤ ${HARD_LIMIT} lines`);
} else {
  for (const v of violations) {
    assert(false, `${v.file}: ${v.lines} lines (exceeds ${HARD_LIMIT}-line hard limit)`);
  }
}

// The scope must actually reach outside extension/, or this is the old gate
// with a longer docstring.
{
  const scanned = listSourceFiles(REPO_ROOT).map((f) => path.relative(REPO_ROOT, f));
  for (const expected of ["install.sh", "build.sh", ".github/workflows/ci.yml"]) {
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
