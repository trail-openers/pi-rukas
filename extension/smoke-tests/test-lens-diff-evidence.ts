#!/usr/bin/env bun
/**
 * #384 — the six-pass review must not approve on the absence of evidence.
 *
 * `runLens` treats an empty diff as APPROVED, and the diff came from a helper
 * that swallowed every git error and returned `""`. So a stale `origin/<branch>`
 * ref, a transient git failure, or a `maxBuffer` overrun on a large diff all
 * produced the same value as "there is genuinely nothing to review" — and that
 * value meant approve, then merge. Same defect class as the `ci-status:`
 * substring #380 removed from the merge step.
 *
 * These use REAL git repositories rather than a mocked exec, because the bug
 * lives in the gap between what git actually does and what the code assumed it
 * does. A fake that returns whatever the test wants cannot see that gap — and
 * in fact two pre-existing fixtures (`test-work-driver-pr6.ts`,
 * `test-work-driver-pr11-lens-diff.ts`) claimed to cover the genuine-empty
 * case while never creating `origin/<branch>`, so they were exercising a git
 * FAILURE the whole time and passing for the wrong reason.
 */

import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { readAllMergedDiffs, readIntegratedDiff } from "../src/work-driver-diff.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";

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
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-diff-"));
  await execp("git init -q", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
  await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
  await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", { cwd: dir });
  return dir;
}

// ------------------------------------------- the branch does not exist

{
  const dir = await mkRepo();
  try {
    // The exact real-world shape: the branch was never pushed, or the local
    // remote-tracking ref is stale. `git diff origin/main..origin/<branch>`
    // fails with "unknown revision".
    const r = await readIntegratedDiff(dir, "feature/never-pushed");
    assert(!r.ok, "a missing origin/<branch> is a FAILURE, not an empty diff");
    assert(
      r.ok === false && /failed|revision|unknown/i.test(r.reason),
      "...and the git error is carried through, so the operator need not reproduce it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------ genuinely nothing to review

{
  const dir = await mkRepo();
  try {
    await execp("git checkout -qb feature/no-work", { cwd: dir });
    await execp("git update-ref refs/remotes/origin/feature/no-work HEAD", { cwd: dir });
    const r = await readIntegratedDiff(dir, "feature/no-work");
    assert(
      r.ok === true && r.empty === true,
      "a branch with no commits ahead of base is a CONFIRMED empty diff, not a failure",
    );
    assert(
      r.ok === true && r.diff === "",
      "...and carries no diff, so lens-review still skips the way it always did",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------- real work to review

{
  const dir = await mkRepo();
  try {
    await execp("git checkout -qb feature/real-work", { cwd: dir });
    writeFileSync(path.join(dir, "base.txt"), "hello\nworld\n");
    await execp("git commit -qam change", { cwd: dir, shell: "/bin/bash" });
    await execp("git update-ref refs/remotes/origin/feature/real-work HEAD", { cwd: dir });
    const r = await readIntegratedDiff(dir, "feature/real-work");
    assert(r.ok === true && r.empty === false, "a branch with commits produces a reviewable diff");
    assert(r.ok === true && /\+world/.test(r.diff), "...and it is the actual change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------ commits exist but the diff comes back empty

{
  const dir = await mkRepo();
  try {
    await execp("git checkout -qb feature/empty-commit", { cwd: dir });
    await execp("git commit -q --allow-empty -m 'empty'", { cwd: dir });
    await execp("git update-ref refs/remotes/origin/feature/empty-commit HEAD", { cwd: dir });
    const r = await readIntegratedDiff(dir, "feature/empty-commit");
    assert(
      !r.ok,
      "commits ahead of base with an empty diff does NOT silently approve — it may be legitimate, but it is not something to wave through",
    );
    assert(
      r.ok === false && /ahead/.test(r.reason),
      "...and the reason says how many commits were ahead",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------- no branch recorded

{
  const dir = await mkRepo();
  try {
    const r = await readAllMergedDiffs({}, dir, undefined);
    assert(
      !r.ok,
      "with no branch name and nothing in the worktrees, the answer is 'could not tell' — not 'approved'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------- the mainline is unknown

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-nogit-"));
  try {
    // Not a git repository at all. Everything fails.
    const r = await readAllMergedDiffs({}, dir, "feature/x");
    assert(!r.ok, "outside a git repo the read fails closed rather than returning an empty diff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- end to end: the cycle halts

{
  // The one that matters: a cycle whose diff cannot be read must HALT, not
  // approve and proceed to merge. Pre-#384 this produced `lens-approved`.
  const dir = await mkRepo();
  try {
    await execp("git checkout -qb feature/unpushed", { cwd: dir });
    writeFileSync(path.join(dir, "base.txt"), "hello\nchanged\n");
    await execp("git commit -qam change", { cwd: dir, shell: "/bin/bash" });
    // Deliberately do NOT create refs/remotes/origin/feature/unpushed.

    let s = initialState(840, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "commit-pr",
        worktrees: { default: dir },
        workstreams: { default: { id: "default", scope: "t", paths: [], outOfScope: [] } },
        branchName: "feature/unpushed",
        prNumber: 8400,
      },
    } as WorkState;
    await writeState(dir, s);

    const labels: string[] = [];
    await runWorkDriver({
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: dir,
      issue: 840,
      issueBodyFetcherFn: async () => ({ stdout: "title:\tt\nstate:\tOPEN\n\nbody" }),
      dispatchFn: async (_pi, spec, opts) => {
        labels.push(opts?.label ?? spec.role);
        return {
          role: spec.role,
          ok: true,
          text: "Posted.",
          toolUses: [],
          ms: 1,
          exitCode: 0,
          transcriptPath: "/tmp/stub.json",
        } as DispatchResult;
      },
    } as DriverContext).catch(() => {});

    const after = await readState(dir, 840);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      !kinds.includes("lens-approved"),
      "an unreadable diff produces ZERO lens-approved events — pre-#384 it approved",
    );
    assert(
      (after?.eventLog ?? []).some((e) => e.kind === "cap-hit" && e.cap === "lens-diff-unreadable"),
      "...it halts with cap `lens-diff-unreadable` instead",
    );
    assert(
      (after?.pipelineState.lensDiffError ?? "").length > 0,
      "...and records the git error verbatim for the operator",
    );
    assert(
      !labels.some((l) => l.startsWith("lens")),
      "no lens children are spawned against a diff nobody could read",
    );
    assert(
      after?.pipelineState.status !== "merged",
      "and the cycle does not go on to merge unreviewed code",
    );
    const explanation = explainCap("lens-diff-unreadable", after!);
    assert(
      /six-pass/.test(explanation) && /fetch origin/.test(explanation),
      "the operator explanation names the gate and gives a concrete recovery",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
