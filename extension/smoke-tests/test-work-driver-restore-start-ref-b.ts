#!/usr/bin/env bun
/**
 * #1093 — restore-start-ref, part 2: the abort path (§7), metacharacter refs (§8),
 * write-ahead (§9) and capture failure (§10). Helpers: lib/restore-start-ref-fixtures.ts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampCycleStartRef } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { captureCycleStartRef, hasCaptureFailure, recordCycleStartRef, restoreCheckout } from "../src/work-driver-git.ts";
import { restoreRootToRefPreserving } from "../src/work-driver-restore.ts";
import { readState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import { assert, realExec, shown, buildRepo, head, stateWith, result } from "./lib/restore-start-ref-fixtures.ts";

// ---- 7. abort path: non-forcing, preserved, command reported --------------
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1093-abort-scratch-"));
  try {
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    g(["checkout", "-q", "feature/x"]);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    g(["commit", "-q", "-am", "x"]);
    g(["checkout", "-q", "feature/merged"]);
    writeFileSync(join(dir, "tracked.txt"), "operator edit\n");
    const calls: string[] = [];
    const recording: ExecFn = (cmd, opts) => {
      calls.push(shown(cmd, opts));
      return realExec(cmd, opts);
    };
    const r = await restoreRootToRefPreserving(recording, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "test",
    });
    assert(!r.restored, "abort: a refused checkout is not claimed restored");
    assert(
      r.detail?.includes("run `git checkout feature/x`") === true,
      `abort: the detail carries the exact command (got ${JSON.stringify(r.detail)})`,
    );
    assert(
      readFileSync(join(dir, "tracked.txt"), "utf8") === "operator edit\n",
      "abort: the operator's edit survives (no reset --hard)",
    );
    assert(
      !calls.some((c) => /reset --hard|checkout --force|checkout -f\b/.test(c)),
      `abort: no forced command was issued (commands: ${JSON.stringify(calls)})`,
    );
    assert(
      r.preservedAt !== undefined &&
        existsSync(r.preservedAt) &&
        readFileSync(r.preservedAt, "utf8").includes("operator edit"),
      "abort: the discarded state is preserved to a file before the restore runs",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 8. refs with metacharacters / tag collisions -------------------------
{
  const dir = buildRepo();
  try {
    const marker = join(dir, "pwned-1093");
    // No literal space in the payload (git refuses one in a refname); `${IFS}`
    // is the shell's space. `mkdir` creates the marker if the substitution runs.
    const evil = "feat$(mkdir${IFS}pwned-1093)x";
    execFileSync("git", ["branch", evil, "main"], { cwd: dir });
    const notes = await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: undefined,
      execFn: realExec,
      startRef: evil,
    });
    assert(
      !existsSync(marker),
      "metachar: a `$(…)` in the start ref is not executed by the restore",
    );
    assert(head(dir) === "main", "metachar: the unusable ref is never checked out (falls back to main)");
    assert(
      notes.some((n) => n.includes("cycle start ref not used")),
      `metachar: the note says why (got ${JSON.stringify(notes)})`,
    );
    const tick = "feat`touch-1093`x";
    execFileSync("git", ["branch", tick, "main"], { cwd: dir });
    const tickNotes = await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: undefined,
      execFn: realExec,
      startRef: tick,
    });
    assert(head(dir) === "main", "metachar: a backtick ref is never checked out");
    assert(
      tickNotes.some((n) => n.includes("cycle start ref not used")),
      "metachar: a backtick ref gets the same note",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = buildRepo();
  try {
    execFileSync("git", ["tag", "feature/merged"], { cwd: dir });
    assert(
      (await captureCycleStartRef(realExec, dir)) === "feature/merged",
      "capture: a tag sharing the branch's short name does not leak a `heads/` prefix",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 9. write-ahead: the stamp is on disk before the branch step runs -----
{
  const dir = buildRepo();
  try {
    execFileSync("git", ["checkout", "-q", "feature/x"], { cwd: dir });
    const ctx = {
      repoRoot: dir,
      verifyExecFn: realExec,
    } as unknown as DriverContext;
    await stampCycleStartRef(ctx, stateWith(undefined, "b"));
    // A crash here would leave the checkout moved below; the file must already say where it started.
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
    const onDisk = await readState(dir, 1093);
    assert(
      onDisk?.pipelineState.startRef === "feature/x",
      `write-ahead: the start ref is persisted before the branch step (got ${onDisk?.pipelineState.startRef})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 10. capture failure: noted in state, never recaptured on resume ------
{
  const dir = buildRepo();
  try {
    const failing: ExecFn = async () => {
      throw new Error("not a repository");
    };
    const failed = await recordCycleStartRef(failing, dir, stateWith(undefined, "b"));
    assert(failed.pipelineState.startRef === undefined, "capture failure: no startRef is stored");
    assert(
      hasCaptureFailure(failed),
      "capture failure: recorded in plumbReports (so the handoff shows it)",
    );
    const ctx = { repoRoot: dir, verifyExecFn: realExec } as unknown as DriverContext;
    execFileSync("git", ["checkout", "-q", "feature/x"], { cwd: dir });
    const again = await stampCycleStartRef(ctx, failed);
    assert(
      again.pipelineState.startRef === undefined && again === failed,
      "capture failure: a resumed cycle does not recapture a moved checkout",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${result.exit}`);
process.exit(result.exit);
