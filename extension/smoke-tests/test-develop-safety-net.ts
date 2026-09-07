#!/usr/bin/env bun
/**
 * #622 — mechanical auto-commit safety net smoke test.
 *
 * Tests all three cases required by AC6:
 *   (a) uncommitted-only worktree → safety net fires and commits
 *   (b) already-committed worktree → safety net skips
 *   (c) clean (no changes) worktree → safety net skips
 *
 * Plus:
 *   (d) escape hatch PI_ENSEMBLE_SAFETY_NET_COMMIT=0 → safety net disabled
 *   (e) invalid baseSha → safety net skipped (older state files)
 *   (f) N>1 workstreams — fires only for the uncommitted-only worktree
 *
 * Uses real git repos in temp dirs (same pattern as
 * test-work-driver-453-commit-verify.ts and test-work-driver-cap-checkpoint.ts).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applySafetyNet } from "../src/work-driver-safety-net.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

/**
 * Create a real git repo with:
 *   - a base commit (baseSha)
 *   - a detached worktree at baseSha
 *
 * Returns the root dir, worktree path, and baseSha.
 */
async function mkBaseRepo(): Promise<{ root: string; wt: string; baseSha: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "safety-net-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await execFileP("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  await execFileP("git", ["-C", repo, "add", "base.txt"]);
  await execFileP("git", ["-C", repo, "commit", "-q", "-m", "base"]);
  const { stdout: baseShaRaw } = await execFileP("git", ["-C", repo, "rev-parse", "HEAD"]);
  const baseSha = baseShaRaw.trim();
  const wt = path.join(root, "wt");
  await execFileP("git", ["-C", repo, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
  return { root, wt, baseSha };
}

function makeState(
  issue: number,
  worktrees: Record<string, string>,
  baseSha: string,
): ReturnType<typeof initialState> {
  let s = initialState(issue, Date.now());
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "develop" as const,
      worktrees,
      baseSha,
    },
  };
  return s;
}

function makeCtx(repoRoot: string, issue: number): DriverContext {
  return {
    pi: makeFakePi(),
    repoRoot,
    issue,
  } as unknown as DriverContext;
}

// ------------------------- (a) uncommitted-only → safety net fires and commits
async function caseA_uncommittedOnly(): Promise<void> {
  const { root, wt, baseSha } = await mkBaseRepo();
  try {
    // Developer left uncommitted work (no commits ahead of baseSha).
    writeFileSync(path.join(wt, "developer-work.ts"), "const x = 1;\n");
    writeFileSync(path.join(wt, "another-file.ts"), "const y = 2;\n");

    const state = makeState(622, { default: wt }, baseSha);
    const ctx = makeCtx(root, 622);
    const result = await applySafetyNet(ctx, state);

    // Check: safety-net-commit event emitted.
    const snEvents = result.eventLog.filter(
      (e): e is Extract<(typeof result.eventLog)[number], { kind: "safety-net-commit" }> =>
        e.kind === "safety-net-commit",
    );
    assert(snEvents.length === 1, "(a) safety-net-commit event emitted");

    // Check: commitSha is valid and the commit exists.
    if (snEvents.length === 1) {
      assert(
        /^[0-9a-f]{40}$/.test(snEvents[0].commitSha),
        "(a) commitSha is a valid 40-char SHA",
      );
      const { stdout: log } = await execFileP("git", ["-C", wt, "log", "--oneline", "-1"]);
      assert(
        log.includes("driver safety-net commit"),
        `(a) commit message is driver-attributed (got: ${log.trim()})`,
      );
      assert(
        snEvents[0].workstreamId === "default",
        "(a) workstreamId is 'default'",
      );
      assert(
        snEvents[0].filesCommitted === 2,
        `(a) filesCommitted is 2 (got: ${snEvents[0].filesCommitted})`,
      );
      // Check the commit contains the right files.
      const { stdout: files } = await execFileP("git", ["-C", wt, "show", "--name-only", "--format=", snEvents[0].commitSha]);
      assert(
        files.includes("developer-work.ts") && files.includes("another-file.ts"),
        "(a) commit contains the developer's uncommitted files",
      );
    }

    // Check: the worktree now has a commit ahead of baseSha.
    const { stdout: ahead } = await execFileP("git", ["-C", wt, "rev-list", "--count", `${baseSha}..HEAD`]);
    assert(
      parseInt(ahead.trim(), 10) === 1,
      `(a) worktree has exactly 1 commit ahead of baseSha (got: ${ahead.trim()})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------- (b) already committed → safety net skips
async function caseB_alreadyCommitted(): Promise<void> {
  const { root, wt, baseSha } = await mkBaseRepo();
  try {
    // Developer already committed correctly.
    writeFileSync(path.join(wt, "committed-file.ts"), "const z = 3;\n");
    await execFileP("git", ["-C", wt, "add", "committed-file.ts"]);
    await execFileP("git", ["-C", wt, "commit", "-q", "-m", "feat(#622): committed work"]);

    const state = makeState(622, { default: wt }, baseSha);
    const ctx = makeCtx(root, 622);
    const result = await applySafetyNet(ctx, state);

    const snEvents = result.eventLog.filter(
      (e): e is Extract<(typeof result.eventLog)[number], { kind: "safety-net-commit" }> =>
        e.kind === "safety-net-commit",
    );
    assert(snEvents.length === 0, "(b) no safety-net-commit event when already committed");
    assert(
      result.eventLog.length === state.eventLog.length,
      "(b) no events added when safety net skips",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------- (c) no changes → safety net skips
async function caseC_noChanges(): Promise<void> {
  const { root, wt, baseSha } = await mkBaseRepo();
  try {
    // Clean worktree — nothing to commit.
    const state = makeState(622, { default: wt }, baseSha);
    const ctx = makeCtx(root, 622);
    const result = await applySafetyNet(ctx, state);

    const snEvents = result.eventLog.filter(
      (e): e is Extract<(typeof result.eventLog)[number], { kind: "safety-net-commit" }> =>
        e.kind === "safety-net-commit",
    );
    assert(snEvents.length === 0, "(c) no safety-net-commit event when tree is clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------- (d) escape hatch: PI_ENSEMBLE_SAFETY_NET_COMMIT=0
async function caseD_escapeHatch(): Promise<void> {
  const prevEnv = process.env.PI_ENSEMBLE_SAFETY_NET_COMMIT;
  process.env.PI_ENSEMBLE_SAFETY_NET_COMMIT = "0";
  try {
    const { root, wt, baseSha } = await mkBaseRepo();
    try {
      // Developer left uncommitted work.
      writeFileSync(path.join(wt, "uncommitted.ts"), "const w = 1;\n");

      const state = makeState(622, { default: wt }, baseSha);
      const ctx = makeCtx(root, 622);
      const result = await applySafetyNet(ctx, state);

      const snEvents = result.eventLog.filter(
        (e): e is Extract<(typeof result.eventLog)[number], { kind: "safety-net-commit" }> =>
          e.kind === "safety-net-commit",
      );
      assert(snEvents.length === 0, "(d) escape hatch PI_ENSEMBLE_SAFETY_NET_COMMIT=0 disables safety net");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    if (prevEnv === undefined) delete process.env.PI_ENSEMBLE_SAFETY_NET_COMMIT;
    else process.env.PI_ENSEMBLE_SAFETY_NET_COMMIT = prevEnv;
  }
}

// ------------------- (e) invalid baseSha → safety net skipped
async function caseE_invalidBaseSha(): Promise<void> {
  const { root, wt, baseSha } = await mkBaseRepo();
  try {
    writeFileSync(path.join(wt, "uncommitted.ts"), "const v = 1;\n");

    const state = makeState(622, { default: wt }, "abc123"); // invalid SHA
    const ctx = makeCtx(root, 622);
    const result = await applySafetyNet(ctx, state);

    const snEvents = result.eventLog.filter(
      (e): e is Extract<(typeof result.eventLog)[number], { kind: "safety-net-commit" }> =>
        e.kind === "safety-net-commit",
    );
    assert(snEvents.length === 0, "(e) no safety-net event when baseSha is invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------- (f) N>1 workstreams — fires only for uncommitted-only
async function caseF_multiWorkstream(): Promise<void> {
  const { root, wt: wtA, baseSha } = await mkBaseRepo();
  try {
    // Create a second worktree at baseSha for task-b.
    const wtB = path.join(root, "wt-b");
    await execFileP("git", ["-C", path.join(root, "repo"), "worktree", "add", "-q", "--detach", wtB, "HEAD"]);

    // task-a: uncommitted work (safety net should fire).
    writeFileSync(path.join(wtA, "task-a-file.ts"), "const a = 1;\n");

    // task-b: already committed (safety net should skip).
    writeFileSync(path.join(wtB, "task-b-file.ts"), "const b = 1;\n");
    await execFileP("git", ["-C", wtB, "add", "task-b-file.ts"]);
    await execFileP("git", ["-C", wtB, "commit", "-q", "-m", "feat(#622): task-b committed"]);

    const state = makeState(622, { "task-a": wtA, "task-b": wtB }, baseSha);
    const ctx = makeCtx(root, 622);
    const result = await applySafetyNet(ctx, state);

    const snEvents = result.eventLog.filter(
      (e): e is Extract<(typeof result.eventLog)[number], { kind: "safety-net-commit" }> =>
        e.kind === "safety-net-commit",
    );
    assert(snEvents.length === 1, "(f) exactly one safety-net-commit event (only for task-a)");
    if (snEvents.length === 1) {
      assert(
        snEvents[0].workstreamId === "task-a",
        `(f) safety net fired for task-a (got: ${snEvents[0].workstreamId})`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------- (g) .pi/ and tmp/ artefacts excluded from commit
async function caseG_driverArtefactsExcluded(): Promise<void> {
  const { root, wt, baseSha } = await mkBaseRepo();
  try {
    // Developer left uncommitted work + driver artefacts.
    writeFileSync(path.join(wt, "real-code.ts"), "const x = 1;\n");
    mkdirSync(path.join(wt, ".pi"), { recursive: true });
    writeFileSync(path.join(wt, ".pi", "state.json"), "{}");
    mkdirSync(path.join(wt, "tmp"), { recursive: true });
    writeFileSync(path.join(wt, "tmp", "scratch.txt"), "scratch");

    const state = makeState(622, { default: wt }, baseSha);
    const ctx = makeCtx(root, 622);
    const result = await applySafetyNet(ctx, state);

    const snEvents = result.eventLog.filter(
      (e): e is Extract<(typeof result.eventLog)[number], { kind: "safety-net-commit" }> =>
        e.kind === "safety-net-commit",
    );
    assert(snEvents.length === 1, "(g) safety-net-commit event emitted");
    if (snEvents.length === 1) {
      const { stdout: files } = await execFileP("git", ["-C", wt, "show", "--name-only", "--format=", snEvents[0].commitSha]);
      assert(
        files.includes("real-code.ts"),
        "(g) real code file IS in the commit",
      );
      assert(
        !files.includes(".pi/") && !files.includes("state.json"),
        "(g) .pi/ artefact NOT in the commit",
      );
      assert(
        !files.includes("tmp/") && !files.includes("scratch.txt"),
        "(g) tmp/ artefact NOT in the commit",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await caseA_uncommittedOnly();
await caseB_alreadyCommitted();
await caseC_noChanges();
await caseD_escapeHatch();
await caseE_invalidBaseSha();
await caseF_multiWorkstream();
await caseG_driverArtefactsExcluded();

console.log(`\nexit ${exit}`);
process.exit(exit);
