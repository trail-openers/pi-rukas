#!/usr/bin/env bun
/**
 * #859 — computeRangeDiff: the tool-side `git diff base...head` computation.
 *
 * Real scratch git repos (the test-lens-diff-evidence.ts pattern) because the
 * bug this exists to prevent lives in the gap between what git actually does
 * and what the code assumes: an empty string must NEVER be ambiguous —
 * "invalid ref", "confirmed-empty range" and "overflow" are three distinct
 * errors, and only a real diff is a success.
 *
 * Covers:
 *   - byte-for-byte equality with `git diff base...head` (three-dot form);
 *   - an invalid ref gives an error NAMING the ref;
 *   - an empty range gives an explicit "empty diff" error (never ok:true);
 *   - a ref starting with `-` is rejected (argument injection);
 *   - shell metacharacters in a ref are inert (execFile, no shell).
 */

import { exec } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { computeRangeDiff } from "../src/review-diff.ts";

const execp = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A repo with an initial commit and origin/main pointing at it. */
async function mkRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-review-diff-"));
  await execp("git init -q", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
  await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
  return dir;
}

// ------------------------------------------- byte-for-byte, three-dot

{
  const dir = await mkRepo();
  try {
    await execp("git checkout -qb feature/work", { cwd: dir });
    writeFileSync(path.join(dir, "base.txt"), "hello\nworld\n");
    await execp("git commit -qam change", { cwd: dir, shell: "/bin/bash" });
    await execp("git update-ref refs/remotes/origin/feature/work HEAD", { cwd: dir });

    const r = await computeRangeDiff(dir, "origin/main", "origin/feature/work");
    assert(r.ok === true, "a real range computes successfully");
    if (r.ok) {
      const { stdout } = await execp("git diff origin/main...origin/feature/work", { cwd: dir });
      assert(r.diff === stdout, "the computed diff equals `git diff base...head` byte-for-byte");
      assert(/\+world/.test(r.diff), "...and it is the actual change");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------- three-dot, not two-dot (divergence)

{
  // A branch that has DIVERGED from main (main moved on after the fork):
  // two-dot and three-dot differ. The tool must use three-dot.
  const dir = await mkRepo();
  try {
    await execp("git checkout -qb feature/diverged", { cwd: dir });
    writeFileSync(path.join(dir, "branch.txt"), "from-branch\n");
    await execp("git add branch.txt && git commit -qm branch-change", {
      cwd: dir,
      shell: "/bin/bash",
    });
    await execp("git checkout -q main", { cwd: dir });
    writeFileSync(path.join(dir, "main-moved.txt"), "from-main\n");
    await execp("git add main-moved.txt && git commit -qm main-moved", {
      cwd: dir,
      shell: "/bin/bash",
    });
    const mainSha = await execp("git rev-parse HEAD", { cwd: dir });
    await execp(`git update-ref refs/remotes/origin/main ${mainSha.stdout.trim()}`, { cwd: dir });
    await execp("git update-ref refs/remotes/origin/feature/diverged refs/heads/feature/diverged", {
      cwd: dir,
    });

    const r = await computeRangeDiff(dir, "origin/main", "origin/feature/diverged");
    assert(r.ok === true, "a diverged range computes");
    if (r.ok) {
      const { stdout: threeDot } = await execp("git diff origin/main...origin/feature/diverged", {
        cwd: dir,
      });
      const { stdout: twoDot } = await execp("git diff origin/main..origin/feature/diverged", {
        cwd: dir,
      });
      assert(r.diff === threeDot, "the diff is the THREE-dot (merge-base) form");
      assert(r.diff !== twoDot, "...and NOT the two-dot form (they differ on a diverged branch)");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------ invalid ref, named

{
  const dir = await mkRepo();
  try {
    const r = await computeRangeDiff(dir, "origin/main", "origin/feature/never-pushed");
    assert(!r.ok, "an invalid head ref is a FAILURE, not an empty diff");
    assert(
      r.ok === false && r.reason.includes("origin/feature/never-pushed"),
      "...and the error NAMES the offending ref",
    );
    const r2 = await computeRangeDiff(dir, "refs/heads/nope", "origin/main");
    assert(
      !r2.ok && r2.ok === false && r2.reason.includes("refs/heads/nope"),
      "an invalid BASE ref is named too",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- empty range, explicit

{
  const dir = await mkRepo();
  try {
    await execp("git checkout -qb feature/no-work", { cwd: dir });
    const r = await computeRangeDiff(dir, "origin/main", "feature/no-work");
    assert(!r.ok, "a range with no diff is NOT ok:true — it is an explicit error");
    assert(
      r.ok === false && /empty diff/i.test(r.reason),
      "...the error is the explicit 'empty diff' one (never an approval)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- ref starting with '-', rejected

{
  const dir = await mkRepo();
  try {
    const r = await computeRangeDiff(dir, "-badref", "HEAD");
    assert(
      !r.ok && r.ok === false && /' -badref'|reject/i.test(r.reason),
      "a ref starting with '-' is rejected (argument injection)",
    );
    const r2 = await computeRangeDiff(dir, "HEAD", "-also-bad");
    assert(
      !r2.ok && r2.ok === false && /reject/i.test(r2.reason),
      "a HEAD ref starting with '-' is rejected too",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------- shell metacharacters are inert (no shell)

{
  const dir = await mkRepo();
  try {
    // A ref containing a `;` is not a valid ref — but with a shell it would
    // have executed. execFile has no shell, so it simply fails as an
    // invalid ref, naming it, with no side effects.
    const sentinel = path.join(dir, "injected.txt");
    const evilRef = "HEAD; touch " + path.join(dir, "x");
    const r = await computeRangeDiff(dir, evilRef, "HEAD");
    assert(!r.ok, "a ref with shell metacharacters fails as an invalid ref");
    assert(
      !existsSync(sentinel) && !existsSync(path.join(dir, "x")),
      "...and nothing was executed (no shell, execFile)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------- outside a git repo

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-review-diff-nogit-"));
  try {
    const r = await computeRangeDiff(dir, "a", "b");
    assert(!r.ok, "outside a git repo the read fails closed (never an empty success)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
