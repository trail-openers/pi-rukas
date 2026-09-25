#!/usr/bin/env bun
/**
 * #873 (follow-up) — `buildExpectedRoster` installed-set semantics and the
 * precedence safe-integer parse.
 *   (j) an expected lens that IS installed but blocked by its own parse
 *       error (missing `precedence:`) appears ONCE with that error — no
 *       false "skill not installed" row on top
 *   (k) `precedence: 99999999999999999999` (not a safe integer) blocks the
 *       lens with a named error
 * Offline; all fixtures are mkdtemp copies of the repo's skill/ dir.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLensRoster, buildExpectedRoster } from "../src/lens-roster.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const REPO_SKILLS = path.join(REPO_ROOT, "skill");
const BUNDLED_SKILLS = [
  "code-review-security",
  "code-review-error-handling",
  "code-review-type-safety",
  "code-review-performance",
  "code-review-architecture",
  "code-review-simplicity",
];

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
    exit = 1;
  }
}

/** Copy the bundled code-review-* skills into a fresh mkdtemp dir. */
function installedFixture(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "lens-roster-exp-"));
  const dir = path.join(root, "installed");
  for (const skill of BUNDLED_SKILLS)
    cpSync(path.join(REPO_SKILLS, skill), path.join(dir, skill), { recursive: true });
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// (j) installed-but-broken lens: ONE row with its own error, no "not installed"

{
  const { dir, cleanup } = installedFixture();
  try {
    const skillDir = path.join(dir, "code-review-simplicity");
    const fm = readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(
      /^precedence:[^\n]*\r?\n/m,
      "",
    );
    writeFileSync(path.join(skillDir, "SKILL.md"), fm);

    const roster = buildExpectedRoster(dir);
    eq(roster.length, 6, "(j) six rows total");
    const rows = roster.filter((e) => e.skill === "code-review-simplicity");
    eq(rows.length, 1, "(j) the broken lens appears exactly once");
    assert(
      /missing or invalid `?precedence|missing or invalid/.test(rows[0]?.error ?? ""),
      `(j) that one row carries the missing-precedence error (${rows[0]?.error})`,
    );
    assert(
      !roster.some((e) => /skill not installed/.test(e.error ?? "")),
      "(j) no false 'skill not installed' row for the present-but-blocked lens",
    );
    assert(
      roster.filter((e) => e.error === undefined).length === 5,
      "(j) the other five installed lenses stay healthy",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// (k) precedence not a safe integer → named block

{
  const { dir, cleanup } = installedFixture();
  try {
    const skillDir = path.join(dir, "code-review-simplicity");
    const fm = readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(
      /^precedence:[^\n]*\r?\n/m,
      "precedence: 99999999999999999999\n",
    );
    writeFileSync(path.join(skillDir, "SKILL.md"), fm);

    const roster = buildLensRoster(dir);
    const blocked = roster.filter((e) => e.error !== undefined);
    eq(blocked.length, 1, "(k) exactly one lens blocked");
    eq(blocked[0]?.name, "SIMPLICITY", "(k) the blocked lens is SIMPLICITY");
    assert(
      /is not a safe integer/.test(blocked[0]?.error ?? ""),
      `(k) the error names the problem (${blocked[0]?.error})`,
    );
  } finally {
    cleanup();
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
