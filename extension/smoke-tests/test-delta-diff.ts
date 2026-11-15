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
import { resolveDeltaDiff } from "../src/lens-review-diff.ts";import {
  DIFF_MAX_BUFFER,
  REVIEW_DIFF_READ_MAX_BYTES,
  computeDeltaDiff,
  computeRangeDiff,
} from "../src/review-diff.ts";
import { subtractReviewedHunks } from "../src/review-delta-hunks.ts";
import { withEnv } from "./lib/env-scope.ts";

const execp = promisify(exec);

/** Added lines of ~64 bytes each, sized against the two ceilings: one past
 * 16 MiB, one past 1 MiB but under it (the band the lean path used to lose). */
const OVER_LIMIT_LINES = 260_100;
const OVER_MIB_LINES = 24_000;

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

// --------------------- #2261: an over-ceiling DELTA is a named failure, not a silent one

/** A repo whose `since..head` delta is `lines` added lines of ~64 bytes. */
async function mkBigRepo(lines: number): Promise<{ dir: string; since: string; head: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-delta-big-"));
  await execp("git init -q -b main", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m base", { cwd: dir, shell: "/bin/bash" });
  const since = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  await execp("git checkout -qb feature/big", { cwd: dir });
  const body = Array.from(
    { length: lines },
    (_u, i) => `line ${i} with enough filler to make the diff genuinely large`,
  ).join("\n");
  writeFileSync(path.join(dir, "big.txt"), `${body}\n`);
  await execp("git add -A && git commit -q -m big", { cwd: dir, shell: "/bin/bash" });
  const head = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  await execp("git update-ref refs/remotes/origin/main " + since, { cwd: dir });
  return { dir, since, head };
}

{
  const { dir, since, head } = await mkBigRepo(OVER_LIMIT_LINES);
  try {
    const measured = (
      await execp(`git diff ${since}..${head}`, { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
    ).stdout;
    assert(
      measured.length > REVIEW_DIFF_READ_MAX_BYTES,
      `precondition: the synthetic delta is past the ceiling (${String(measured.length)} > ${REVIEW_DIFF_READ_MAX_BYTES})`,
    );
    const r = await computeDeltaDiff(dir, since, head);
    assert(!r.ok, "an over-ceiling delta is a FAILURE, never a truncated diff");
    assert(
      r.ok === false && r.reason.includes("REVIEW_DIFF_READ_MAX_BYTES"),
      `the delta reason NAMES the limit constant (got: ${r.ok === false ? r.reason : "ok"})`,
    );
    assert(
      r.ok === false && r.reason.includes(String(REVIEW_DIFF_READ_MAX_BYTES)),
      "...and its value",
    );
    assert(
      r.ok === false &&
        /\b\d{7,}\b/.test(r.reason.replace(String(REVIEW_DIFF_READ_MAX_BYTES), "")),
      `...and the measured size (got: ${r.ok === false ? r.reason : "ok"})`,
    );
    // The edge case the spec names: a truncated delta must NEVER read as an
    // EMPTY delta, which would silently skip the review.
    assert(
      r.ok === false,
      "an over-ceiling delta is not the ok:true empty outcome (a cut tail is never 'nothing to review')",
    );

    const resolved = await resolveDeltaDiff(since, head, dir);
    assert(
      resolved.noReview === false && resolved.problem !== undefined,
      "resolveDeltaDiff blocks on it rather than returning noReview",
    );
    assert(
      resolved.noReview === false &&
        (resolved.problem ?? "").includes("REVIEW_DIFF_READ_MAX_BYTES"),
      "...and the block carries the named reason through to the review",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------- #2261: the switch-off arm keeps the delta's pre-fix 1 MiB failure

{
  const { dir, since, head } = await mkBigRepo(OVER_MIB_LINES);
  try {
    const measured = (
      await execp(`git diff ${since}..${head}`, { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
    ).stdout;
    assert(
      measured.length > DIFF_MAX_BUFFER && measured.length < REVIEW_DIFF_READ_MAX_BYTES,
      `precondition: past 1 MiB, under the shared ceiling (${String(measured.length)})`,
    );
    const on = await computeDeltaDiff(dir, since, head);
    assert(on.ok === true && on.empty === false, "with the switch on a >1 MiB delta reads (AC1)");
    await withEnv({ PI_ENSEMBLE_LENS_LARGE_DIFF: "0" }, async () => {
      const off = await computeDeltaDiff(dir, since, head);
      assert(
        off.ok === false && /exceeded the limit DIFF_MAX_BUFFER \(1048576 bytes\)/.test(off.reason),
        `"0" restores the pre-fix 1 MiB delta failure verbatim (got: ${off.ok === false ? off.reason : "ok"})`,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (#1128) subtractReviewedHunks — pure hunk-identity filter, no git.
{
  const hunkA = "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n";
  const file = (name: string, body: string) =>
    `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n${body}`;
  // (a) identical hunk at a shifted line offset is the same hunk → dropped
  const shifted = "@@ -40,2 +41,2 @@\n ctx\n-old\n+new\n";
  assert(
    subtractReviewedHunks(file("a.ts", shifted), file("a.ts", hunkA)) === "",
    "shifted-offset identical hunk is subtracted (numbers ignored)",
  );
  // (b) a genuinely new hunk is kept; the reviewed one is dropped
  const hunkB = "@@ -9,1 +9,2 @@\n keep\n+added\n";
  const out = subtractReviewedHunks(file("a.ts", hunkA + hunkB), file("a.ts", hunkA));
  assert(out.includes("+added") && !out.includes("+new"), "new hunk kept, reviewed hunk dropped");
  assert(out.startsWith("diff --git a/a.ts b/a.ts\n"), "kept hunks keep their file header");
  // (c) identity is per file: the same body in another file is NOT subtracted
  assert(
    subtractReviewedHunks(file("b.ts", hunkA), file("a.ts", hunkA)).includes("+new"),
    "identical body in a different file is kept (per-file identity)",
  );
  // (d) multiset: two identical hunks in head, one reviewed → one survives
  const twice = file("a.ts", hunkA + hunkA);
  const once = subtractReviewedHunks(twice, file("a.ts", hunkA));
  assert(once.split("+new").length - 1 === 1, "multiset: one of two identical hunks survives");
  // (e) empty prev → everything kept, byte-identical to the input
  const full = file("a.ts", hunkA);
  assert(subtractReviewedHunks(full, "") === full, "empty previous diff leaves the head diff byte-identical");
  // (f) all hunks reviewed → "" (caller turns this into the no-review outcome)
  assert(subtractReviewedHunks(full, full) === "", "everything already reviewed → empty");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
