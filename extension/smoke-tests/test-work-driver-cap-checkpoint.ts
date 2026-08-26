#!/usr/bin/env bun
/**
 * #543 F5 — the driver-owned checkpoint (M5/M6) after a dispatch-cap kill.
 *
 * A cap-killed child never commits (developer: "Do NOT commit"; lens /
 * adversarial / explore: structurally write-gated per role-tools.ts #238).
 * The driver stages + commits the worktree, authors `status-<role>.md` in
 * the scratch dir, and records `capedPartialState`. This test exercises the
 * two behaviours the round-1 findings pinned:
 *
 *   (M5) a structurally write-gated role (adversarial-developer /
 *        code-review-specialist / explore) is REPORT-ONLY: no stage, no
 *        commit, `reportOnly: true` on the record;
 *   (M6) when the killed developer's workstream paths are declared, the
 *        stage is SCOPED to them: foreign untracked files are NOT swept
 *        into the checkpoint commit and are counted in the status file.
 *
 * Real git repo, no dispatches — the cap kill is recorded directly on the
 * state file the checkpoint reads.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkpointCapedDispatch } from "../src/work-driver-cap-checkpoint.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-checkpoint-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function capKillState(repoRoot: string, issue: number): ReturnType<typeof initialState> {
  let s = initialState(issue, Date.now());
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "develop",
      worktrees: { default: repoRoot },
    },
  };
  s = {
    ...s,
    eventLog: [
      ...s.eventLog,
      {
        kind: "dispatch-failed" as const,
        step: "develop" as const,
        role: "developer" as const,
        jobId: "j1",
        label: "developer",
        ms: 1000,
        at: Date.now(),
        exitCode: 143,
        killCause: "loop" as const,
        errorTail: "killed by pi-ensemble (loop)",
      },
    ],
  };
  return s;
}

const fakePi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;

// ------------------------------- (M6) scoped stage, foreign file NOT swept
{
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    writeFileSync(path.join(repo, "foreign-untracked.txt"), "foreign\n");
    let s = capKillState(repo, 9901);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        workstreams: {
          default: {
            id: "default",
            scope: "scope",
            paths: ["in-scope.ts"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(repo, s);
    const ctx = { pi: fakePi, repoRoot: repo, issue: 9901 } as unknown as Parameters<
      typeof checkpointCapedDispatch
    >[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    const cps = out.pipelineState.capedPartialState;
    assert(cps !== undefined, "M6: capedPartialState recorded");
    assert(cps?.tree === "committed", "M6: in-scope file committed (tree=committed)");
    assert(
      typeof cps?.commitSha === "string" && cps.commitSha.length >= 7,
      "M6: commitSha recorded",
    );
    const committed = git(repo, "show", "--name-only", "--format=", cps?.commitSha ?? "");
    assert(committed.includes("in-scope.ts"), "M6: in-scope file IS in the checkpoint commit");
    assert(
      !committed.includes("foreign-untracked.txt"),
      "M6: foreign untracked file NOT swept into the checkpoint commit",
    );
    const statusFile = path.join(repo, "tmp", "issue-9901", "status-developer.md");
    const content = await readFile(statusFile, "utf8").catch(() => "");
    assert(
      /1 untracked path\(s\) outside the declared workstream scope/.test(content),
      `M6: status file counts the foreign file as swept-foreign (got: ${JSON.stringify(content.slice(0, 400))})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// --------------------- (M6-neg) no declared paths → unscoped sweep (legacy)
{
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    writeFileSync(path.join(repo, "foreign-untracked.txt"), "foreign\n");
    const s = capKillState(repo, 9902);
    await writeState(repo, s);
    const ctx = { pi: fakePi, repoRoot: repo, issue: 9902 } as unknown as Parameters<
      typeof checkpointCapedDispatch
    >[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    const cps = out.pipelineState.capedPartialState;
    assert(cps?.tree === "committed", "M6-neg: unscoped checkpoint still commits (legacy sweep)");
    const committed = git(repo, "show", "--name-only", "--format=", cps?.commitSha ?? "");
    assert(
      committed.includes("in-scope.ts") && committed.includes("foreign-untracked.txt"),
      "M6-neg: without declared paths the sweep is unscoped (both files committed)",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------- (M5) write-gated role is report-only
{
  const repo = makeRepo();
  try {
    // A write-gated child cannot have written files — but a dirty tree can
    // exist (driver artefacts / other workstreams); the checkpoint must not
    // stage or commit anything for this role.
    writeFileSync(path.join(repo, "stray.txt"), "stray\n");
    let s = initialState(9903, Date.now());
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        worktrees: { default: repo },
      },
    };
    s = {
      ...s,
      eventLog: [
        ...s.eventLog,
        {
          kind: "dispatch-failed" as const,
          step: "lens-review" as const,
          role: "code-review-specialist" as const,
          jobId: "j3",
          label: "lens:security",
          ms: 1000,
          at: Date.now(),
          exitCode: 143,
          killCause: "token-budget" as const,
          errorTail: "killed by pi-ensemble (token budget)",
        },
      ],
    };
    await writeState(repo, s);
    const before = git(repo, "rev-parse", "HEAD");
    const ctx = { pi: fakePi, repoRoot: repo, issue: 9903 } as unknown as Parameters<
      typeof checkpointCapedDispatch
    >[0];
    const out = await checkpointCapedDispatch(ctx, s, "lens-review");
    const after = git(repo, "rev-parse", "HEAD");
    assert(before === after, "M5: write-gated role → NO checkpoint commit");
    const cps = out.pipelineState.capedPartialState;
    assert(cps?.reportOnly === true, "M5: capedPartialState.reportOnly is true");
    assert(!cps?.commitSha, "M5: no commitSha for a report-only checkpoint");
    const statusFile = path.join(repo, "tmp", "issue-9903", "status-code-review-specialist.md");
    const content = await readFile(statusFile, "utf8").catch(() => "");
    assert(
      content.length > 0,
      "M5: the status file is still authored (the report IS the checkpoint)",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
