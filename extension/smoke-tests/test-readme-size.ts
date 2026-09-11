#!/usr/bin/env bun
/**
 * README.md size ratchet — issue #703.
 *
 * README.md had grown to 578 lines (62.8 KB) — 9x the size of upstream Pi's
 * README and 2.4x bun's — of which ~57% was reference material (68 environment
 * variables, the full sandbox detail, the MCP bridge walkthrough, the custom
 * provider walkthrough) that belongs in dedicated docs files, not the entry
 * point a reader lands on. The reference material moved to docs/configuration.md,
 * docs/sandbox.md, docs/mcp.md and docs/custom-providers.md (#703); this ratchet
 * keeps the README at a skimmable size.
 *
 * **Scoped to README.md only, deliberately.** test-file-size-limit.ts excludes
 * markdown on the grounds that the limit is about code a person holds in their
 * head; that reasoning does not apply to the README, which IS the project's
 * first impression and where reference bloat is a known, measured failure mode.
 * The new docs/*.md reference files are intentionally NOT in scope —
 * docs/troubleshooting.md is 1700+ lines and should be.
 *
 * **Proven in both directions** (the same doctrine test-file-size-limit.ts
 * follows): a gate never observed to fail is worthless, so this asserts not only
 * that the real README.md is under the limit but that a deliberately oversized
 * fixture README in a temp dir IS caught by the same exported function.
 *
 * Escape hatch: PI_ENSEMBLE_README_SIZE=0.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LIMIT = 200;
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

/** Count newlines — a trailing-newline-terminated file of N lines has N
 * newline characters, matching `wc -l` exactly (same convention as
 * test-file-size-limit.ts). */
function lineCount(file: string): number {
  const text = readFileSync(file, "utf8");
  return (text.match(/\n/g) ?? []).length;
}

/**
 * Check a README.md in `root` against the line limit. Returns { lines } on
 * violation, or null when the file is absent or under the limit. Exported so
 * the both-directions check below can call it on a fixture.
 */
export function checkReadmeSize(root: string, limit = LIMIT): { lines: number } | null {
  const readme = path.join(root, "README.md");
  let lines: number;
  try {
    lines = lineCount(readme);
  } catch {
    return null; // no README.md in this root — not a violation here
  }
  return lines > limit ? { lines } : null;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

if (process.env.PI_ENSEMBLE_README_SIZE === "0") {
  console.log("PI_ENSEMBLE_README_SIZE=0 — README size gate skipped.");
  process.exit(0);
}

// ---------------------------------------------- the gate CAN fail

{
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-readmesize-"));
  try {
    // An oversized README fixture (LIMIT + 1 lines) must be caught.
    writeFileSync(path.join(fixtureRoot, "README.md"), "line\n".repeat(LIMIT + 1));
    const hit = checkReadmeSize(fixtureRoot);
    assert(
      hit !== null && hit.lines === LIMIT + 1,
      `canary: an oversized fixture README (${LIMIT + 1} lines) IS caught — a gate never observed to fail is worthless`,
    );
    // A clean README fixture must NOT be flagged.
    writeFileSync(path.join(fixtureRoot, "README.md"), "line\n".repeat(10));
    assert(
      checkReadmeSize(fixtureRoot) === null,
      "...and a small README.md (10 lines) is not flagged",
    );
    // The gate must be scoped to README.md: a big docs/troubleshooting.md in the
    // same root is NOT in scope (the docs files deliberately can be long).
    writeFileSync(path.join(fixtureRoot, "README.md"), "line\n".repeat(10));
    writeFileSync(path.join(fixtureRoot, "long-notes.md"), "line\n".repeat(LIMIT + 50));
    assert(
      checkReadmeSize(fixtureRoot) === null,
      "...and a non-README markdown file over the limit is out of scope (docs files are allowed to be long)",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------- and the repo README is clean

{
  const violation = checkReadmeSize(REPO_ROOT);
  if (violation === null) {
    const lines = lineCount(path.join(REPO_ROOT, "README.md"));
    assert(true, `README.md is ${lines} lines (≤ ${LIMIT}-line limit)`);
  } else {
    assert(
      false,
      `README.md is ${violation.lines} lines (exceeds the ${LIMIT}-line limit) — move reference material to docs/ and link to it`,
    );
  }
}

console.log(exit === 0 ? "\nAll README-size checks passed." : "\nFAILED");
process.exit(exit);
