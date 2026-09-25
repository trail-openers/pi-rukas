#!/usr/bin/env bun
/**
 * #873 lens fix — `skillsDirUsable` must agree with the roster predicate:
 * a `code-review-*` entry counts only if it is a DIRECTORY (the roster
 * skips non-directory entries, and `statSync` follows symlinks). A skills
 * dir holding only a `code-review-foo` plain FILE therefore yields the
 * install message with ALL bundled lenses blocked — not a partial roster.
 *
 * Drives the REAL `runLensReview` (lens-review.ts) with `spawnSpecialist`
 * mocked the way test-lens-skill-wiring.ts does (mock.module before the
 * lens-module import), and `PI_ENSEMBLE_SKILLS_DIR` pointed at a mkdtemp
 * fixture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";

let exit = 0;
function assert(cond: boolean, msg: string): boolean {
  if (cond) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}`);
  exit = 1;
  return false;
}

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-873pf",
  spawnSpecialist: async () => {
    throw new Error("spawnSpecialist must not be called for a file-only skills dir");
  },
}));

const { runLensReview } = await import("../src/lens-review.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");
const { skillsDirUsable } = await import("../src/lens-review-skills.ts");

const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "lens873pf-")), "skills");
mkdirSync(dir, { recursive: true });
// A `code-review-*` entry that is a plain FILE, not a directory: the roster
// (buildLensRoster) skips it, so the installed roster is empty → the
// skills-dir block path must fire with the single install message.
writeFileSync(path.join(dir, "code-review-foo"), "not a skill dir\n");

try {
  const prior = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_SKILLS_DIR = dir;
  try {
    const summary = await runLensReview({ diff: "diff --git a/a b/a" } as never);
    const problem = `skills dir ${dir} missing or empty — run ./install.sh`;
    assert(
      skillsDirUsable(dir) === problem,
      "(a) skillsDirUsable flags a dir holding only a code-review-foo plain file with the install message",
    );
    const expected = new Set(LENS_ROSTER.map((e) => e.name));
    const names = summary.lenses.map((l) => l.lens);
    assert(
      summary.lenses.every((l) => l.blocked && l.attempts === 0 && l.parseError === problem),
      "(a) all bundled lenses blocked with the single install message (no spawn, no retries)",
    );
    assert(
      summary.lenses.length === expected.size &&
        names.every((n) => expected.has(n)) &&
        new Set(names).size === names.length,
      `(a) one blocked row per bundled lens (${expected.size} rows, roster order, deduped)`,
    );
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = prior;
  }
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

console.log(`\nexit ${exit}`);
process.exit(exit);
