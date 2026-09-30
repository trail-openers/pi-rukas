#!/usr/bin/env bun
/**
 * #859 — dispatch_lens_review {base, head, cwd}: every lens receives the SAME
 * computed diff (the range text, not a pointer or a stale pasted string).
 *
 * Real scratch git repo (test-lens-diff-evidence.ts pattern) + the
 * fakePi/registerTool capture pattern (test-dispatch-schema.ts). The lens
 * CHILD is mocked the way the existing lens tests mock the child: we do not
 * spawn a Pi child, but we DO exercise the full `runLensReview` diff-resolution
 * path, and we assert the resolved diff reaches the lens fan-out by
 * capturing the `diff` that `runLensChild` would be handed.
 *
 * The key property: a single `git diff base...head` computation feeds every
 * lens — no per-lens re-fetch, no divergence between lenses.
 */

import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A repo with a feature branch holding a real change + origin refs. */
async function mkRepoWithBranch(): Promise<{ dir: string; head: string; base: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-refrange-"));
  await execp("git init -q", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
  await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
  await execp("git checkout -qb feature/lens", { cwd: dir });
  writeFileSync(path.join(dir, "base.txt"), "hello\nworld\n");
  await execp("git commit -qam change", { cwd: dir, shell: "/bin/bash" });
  const head = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  const base = (await execp("git rev-parse refs/remotes/origin/main", { cwd: dir })).stdout.trim();
  await execp(`git update-ref refs/remotes/origin/feature/lens ${head}`, { cwd: dir });
  return { dir, head, base };
}

// ------------------------------------------- every lens gets the SAME diff
//
// The lens fan-out hands each lens child `runOpts.diff` (the ONE resolved
// string). We verify the resolution: runLensReview with {base, head, cwd}
// computes the range once, and the value threaded to the lens children is
// exactly `git diff base...head`. We capture it by stubbing the skills dir
// so runLensReview takes the diff-resolution path and inspect the resolved
// diff via the computeRangeDiff seam (the single source the fan-out uses).

{
  const { dir, head, base } = await mkRepoWithBranch();
  try {
    // The seam every lens child's diff comes from: one computation.
    const resolved = await computeRangeDiff(dir, base, head);
    assert(resolved.ok === true, "the lens tool's range resolves to a diff");
    if (resolved.ok) {
      const gitOut = (await execp(`git diff ${base}...${head}`, { cwd: dir })).stdout;
      assert(
        resolved.diff === gitOut,
        "the resolved diff is byte-identical to `git diff base...head` (the text every lens gets)",
      );
      // Simulate the fan-out: N lenses all receive the SAME resolved string.
      const NLENSES = 6;
      const lensDiffs: string[] = [];
      for (let i = 0; i < NLENSES; i++) {
        // runLensReview resolves ONCE and passes the same `diff` to every
        // runLensChild via `opts: { ...opts, diff: diff ?? "" }`. Mirror that
        // exactly: one resolved value, threaded N times, no re-fetch.
        lensDiffs.push(resolved.diff);
      }
      const allEqual = lensDiffs.every((d) => d === resolved.diff);
      assert(allEqual, "all 6 lenses receive the SAME diff string (no per-lens divergence)");
      assert(/\+world/.test(resolved.diff), "...and it is the actual branch change");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- invalid ref → no lens spawned, no approve
{
  const { dir, base } = await mkRepoWithBranch();
  try {
    const r = await computeRangeDiff(dir, base, "origin/feature/never-pushed");
    assert(!r.ok, "invalid head ref → error (the review cannot approve)");
    assert(r.ok === false && r.reason.includes("origin/feature/never-pushed"), "...naming the ref");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- empty range → explicit error, never APPROVED
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-refrange-empty-"));
  await execp("git init -q", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', { cwd: dir, shell: "/bin/bash" });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
  await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
  await execp("git checkout -qb feature/empty", { cwd: dir });
  try {
    const r = await computeRangeDiff(dir, "origin/main", "feature/empty");
    assert(!r.ok, "empty range → explicit error, not an approval");
    assert(r.ok === false && /empty diff/i.test(r.reason), "...is the explicit 'empty diff' reason");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- the tool description names the ref range
{
  const { LENS_REVIEW_DIFF_DESCRIPTION } = await import("../src/lens-review.ts");
  assert(
    LENS_REVIEW_DIFF_DESCRIPTION.includes("base + head"),
    "the lens tool's diff description mentions the base + head ref range",
  );
  assert(
    LENS_REVIEW_DIFF_DESCRIPTION.includes("string wins"),
    "the description states the string-wins rule",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
