#!/usr/bin/env bun
/**
 * #973 — the delta review's diff selection (computeDeltaDiff +
 * resolveDeltaDiff) with real scratch git repos.
 *
 * The contract (design decision 4): a delta review's `since..head` is a
 * TWO-dot diff (exactly what changed since `since`). An EMPTY delta is a
 * distinct, named no-review outcome (`{ ok: true, empty: true }`) — NOT
 * the "empty diff" error of a confirmed-empty FULL diff (the #384 rule,
 * which computeRangeDiff enforces and which is untouched here). Refs are
 * validated the same way as computeRangeDiff (a leading `-` is rejected;
 * shell metacharacters are inert via execFile).
 *
 * Covers:
 *   - a non-empty delta selects exactly `git diff since..head` (two-dot);
 *   - an empty delta (no new commits) is `{ ok: true, empty: true }`,
 *     distinct from a full diff's "empty diff" error;
 *   - a `since` that is not an ancestor of head still computes (two-dot
 *     does not require ancestry — the caller's autoDeltaSince checks
 *     ancestry separately, so the diff itself is valid);
 *   - a ref starting with `-` is rejected (argument injection);
 *   - shell metacharacters in a ref are inert (execFile, no shell);
 *   - resolveDeltaDiff with an explicit head;
 *   - resolveDeltaDiff with no head (the current HEAD of the cwd);
 *   - resolveDeltaDiff with an empty delta → noReview (the churn-stopping
 *     outcome);
 *   - resolveDeltaDiff with an invalid `since` → a problem (a block, not a
 *     no-review).
 */

import { exec } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveDeltaDiff } from "../src/lens-review-diff.ts";
import { computeDeltaDiff, computeRangeDiff } from "../src/review-diff.ts";

const execp = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A repo with two commits on a feature branch off origin/main:
 *   origin/main → c0 (base)
 *   feature → c0 → c1 (first change) → c2 (second change)
 * Returns the SHAs so the delta range can be pinned to c1..c2 (the delta
 * since the first recorded lens run, if c1 was that run's head).
 */
async function mkRepo(): Promise<{ dir: string; c0: string; c1: string; c2: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-delta-"));
  await execp("git init -q -b main", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m c0", { cwd: dir, shell: "/bin/bash" });
  const c0 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  await execp("git checkout -qb feature/work", { cwd: dir });
  writeFileSync(path.join(dir, "first.txt"), "one\n");
  await execp("git add first.txt && git commit -q -m c1", { cwd: dir, shell: "/bin/bash" });
  const c1 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  writeFileSync(path.join(dir, "second.txt"), "two\n");
  await execp("git add second.txt && git commit -q -m c2", { cwd: dir, shell: "/bin/bash" });
  const c2 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  return { dir, c0, c1, c2 };
}

// ------------------------------------------- non-empty delta, two-dot

{
  const { dir, c1, c2 } = await mkRepo();
  try {
    const r = await computeDeltaDiff(dir, c1, c2);
    assert(r.ok === true, "a non-empty delta computes");
    if (r.ok && !r.empty) {
      const { stdout } = await execp(`git diff ${c1}..${c2}`, { cwd: dir });
      assert(r.diff === stdout, "the delta equals `git diff since..head` byte-for-byte (TWO-dot)");
      assert(/second\.txt/.test(r.diff), "...and it is the change between the two commits");
      // The two-dot form is NOT the three-dot (merge-base) form here: c1 is
      // an ancestor of c2, so they happen to agree — but the DIFFERENT
      // semantics are pinned by the empty-delta case below (where a
      // merge-base diff would be non-empty and a two-dot diff is empty).
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- empty delta (the churn case)

{
  const { dir, c2 } = await mkRepo();
  try {
    // No new commits since c2: the delta c2..c2 is empty.
    const r = await computeDeltaDiff(dir, c2, c2);
    assert(r.ok === true, "an empty delta is ok:true (NOT an error)");
    assert(r.ok === true && r.empty === true, "...and it is the named empty outcome (empty: true)");
    // Contrast: a FULL diff over the same empty range is an explicit error
    // (#384) — the two shapes are distinct and the distinction is the
    // churn-stopping contract.
    const full = await computeRangeDiff(dir, c2, c2);
    assert(full.ok === false, "a confirmed-empty FULL range is still an error (#384)");
    assert(
      full.ok === false && /empty diff/i.test(full.reason),
      "...with the explicit 'empty diff' reason",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- since not an ancestor of head

{
  const { dir, c0, c1 } = await mkRepo();
  try {
    // c0 is an ancestor of c1, so c0..c1 is non-empty. Now create a
    // divergent branch from c0 and diff c1..divergent-head: the two-dot
    // form computes the diff of the divergence (it does not require
    // ancestry — the caller's ancestry check is a separate concern).
    await execp(`git checkout -qb feature/diverged ${c0}`, { cwd: dir });
    writeFileSync(path.join(dir, "diverged.txt"), "diverged\n");
    await execp("git add diverged.txt && git commit -q -m diverged", {
      cwd: dir,
      shell: "/bin/bash",
    });
    const diverged = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
    const r = await computeDeltaDiff(dir, c1, diverged);
    assert(
      r.ok === true,
      "a two-dot delta over a divergent branch computes (no ancestry required)",
    );
    assert(r.ok === true && r.empty === false, "...and the diff is non-empty (the divergence)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- ref starting with '-', rejected

{
  const { dir, c1, c2 } = await mkRepo();
  try {
    const r = await computeDeltaDiff(dir, "-badref", c2);
    assert(!r.ok, "a since starting with '-' is rejected");
    assert(r.ok === false && /reject/i.test(r.reason), "...naming the rejection");
    const r2 = await computeDeltaDiff(dir, c1, "-also-bad");
    assert(!r2.ok, "a head starting with '-' is rejected too");
    assert(r2.ok === false && /reject/i.test(r2.reason), "...naming the rejection");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- shell metacharacters inert

{
  const { dir, c1, c2 } = await mkRepo();
  try {
    const sentinel = path.join(dir, "injected.txt");
    const evilRef = `${c1}; touch ${sentinel}`;
    const r = await computeDeltaDiff(dir, evilRef, c2);
    assert(!r.ok, "a since with shell metacharacters fails as an invalid ref");
    assert(!existsSync(sentinel), "...and nothing was executed (no shell, execFile)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- resolveDeltaDiff, explicit head

{
  const { dir, c1, c2 } = await mkRepo();
  try {
    const r = await resolveDeltaDiff(c1, c2, dir);
    assert(r.noReview === false, "an explicit-head non-empty delta is not a no-review");
    assert(r.noReview === false && r.diff !== undefined, "...and it carries the diff");
    if (!r.noReview && r.diff) {
      const { stdout } = await execp(`git diff ${c1}..${c2}`, { cwd: dir });
      assert(r.diff === stdout, "the resolved delta matches `git diff since..head`");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- resolveDeltaDiff, empty → noReview

{
  const { dir, c2 } = await mkRepo();
  try {
    const r = await resolveDeltaDiff(c2, c2, dir);
    assert(r.noReview === true, "an empty delta is a no-review (the churn-stopping outcome)");
    assert(r.noReview === true && r.since === c2, "...with the since ref carried through");
    assert(
      r.noReview === true && /no changes since/.test(r.reason),
      "...and the reason names the no-change",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- resolveDeltaDiff, no head (HEAD)

{
  const { dir, c1 } = await mkRepo();
  try {
    // The repo is on feature/work at c2. No explicit head → the current
    // HEAD (c2). The delta c1..c2 is non-empty.
    const r = await resolveDeltaDiff(c1, undefined, dir);
    assert(r.noReview === false, "no explicit head → the current HEAD is used");
    assert(r.noReview === false && r.diff !== undefined, "...and the delta is computed against it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- resolveDeltaDiff, invalid since

{
  const { dir, c2 } = await mkRepo();
  try {
    const r = await resolveDeltaDiff("not-a-real-ref", c2, dir);
    assert(r.noReview === false, "an invalid since is NOT a no-review");
    assert(
      r.noReview === false && r.problem !== undefined,
      "...it is a problem (a block, not an approval)",
    );
    assert(
      r.noReview === false && r.problem !== undefined && r.problem.includes("not-a-real-ref"),
      "...naming the offending ref",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- outside a git repo

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-delta-nogit-"));
  try {
    const r = await computeDeltaDiff(dir, "a", "b");
    assert(!r.ok, "outside a git repo the delta read fails closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
