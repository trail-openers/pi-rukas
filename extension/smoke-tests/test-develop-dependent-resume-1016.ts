#!/usr/bin/env bun
/**
 * #1016 — crash-resume covers DEPENDENT workstreams too. The crashed attempt
 * left task-a (independent) and task-b (depends-on task-a) both green, each
 * with a commit, and task-b's worktree recorded in pipelineState. The resumed
 * run must keep both: neither is re-dispatched, and each stays green.
 *
 * No real Pi spawn happens; all dispatchFn calls are mocked.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, readState, writeState } from "../src/workflow-state.ts";
import { ensureGitIdentity, gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

ensureGitIdentity();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const ISSUE = 1016;
const dir = mkdtempSync(path.join(tmpdir(), "dep-resume-1016-"));
try {
  await mkdir(path.join(dir, ".git", "info"), { recursive: true });
  const ids = ["task-a", "task-b"];
  const shas = await makeBaseWorktrees(dir, ids);
  const wt = (id: string) => path.join(dir, ".worktrees", id);
  // Each kept workstream finished with a commit ahead of its own base.
  for (const id of ids) {
    writeFileSync(path.join(wt(id), `${id}.txt`), `${id} work\n`);
    gitIn(wt(id), ["add", `${id}.txt`]);
    gitIn(wt(id), ["commit", "-qm", `${id} work`]);
  }

  const state = {
    schemaVersion: 1,
    resumable: false,
    issue: ISSUE,
    startedAt: 1_000_000,
    updatedAt: 1_000_000,
    pipelineState: {
      currentStep: "develop",
      lastCompletedStep: "branch",
      inFlightJobIds: ["j-crashed"],
      worktrees: Object.fromEntries(ids.map((id) => [id, wt(id)])),
      workstreams: {
        "task-a": { id: "task-a", scope: "a", paths: ["task-a.txt"], outOfScope: [] },
        "task-b": {
          id: "task-b",
          scope: "b",
          paths: ["task-b.txt"],
          outOfScope: [],
          dependsOn: ["task-a"],
        },
      },
      workstreamBaseShas: shas,
      reviewRound: 0,
      ciRetryCount: 0,
      plumbReports: [],
      status: "running",
      branchName: `feature/issue-${ISSUE}-dep`,
    },
    eventLog: [
      { kind: "step-started", step: "develop", at: 1 },
      {
        kind: "dispatch-started",
        step: "develop",
        role: "developer",
        jobId: "j-crashed",
        label: "developer×2",
        at: 2,
      },
      { kind: "branch-completed", step: "develop", workstreamId: "task-a", ok: true, ms: 1, at: 3 },
      { kind: "branch-completed", step: "develop", workstreamId: "task-b", ok: true, ms: 1, at: 4 },
    ],
  } as unknown as WorkState;
  await writeState(dir, state);

  const labels: string[] = [];
  const ctx: DriverContext = {
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: dir,
    issue: ISSUE,
    issueBodyFetcherFn: async (issue: number) => ({
      stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body`,
    }),
    dispatchFn: async (_pi, spec, opts) => {
      if (spec.role !== "developer") throw new Error("smoke: halting after develop fanout");
      labels.push(opts?.label ?? spec.role);
      return {
        role: "developer",
        ok: true,
        text: "mock developer output",
        toolUses: [],
        ms: 100,
        exitCode: 0,
        transcriptPath: "/tmp/stub-transcript.json",
      };
    },
  };
  await runWorkDriver(ctx);

  assert(
    labels.length === 0,
    `resume: no developer re-dispatched for kept greens (dispatched: ${labels.join(", ") || "none"})`,
  );
  const after = await readState(dir, ISSUE);
  const resumedB = (after?.eventLog ?? []).some(
    (e) => e.kind === "branch-completed" && e.workstreamId === "task-b" && e.resumed === true,
  );
  assert(resumedB, "resume: the kept dependent task-b is re-recorded as resumed green");
  const converged = [...(after?.eventLog ?? [])]
    .reverse()
    .find((e) => e.kind === "branches-converged" && e.step === "develop");
  assert(
    converged?.kind === "branches-converged" &&
      converged.verdicts.length === 2 &&
      converged.verdicts.every((v) => v.ok),
    "resume: develop converges with both kept workstreams ok",
  );
  assert(
    gitIn(wt("task-b"), ["rev-list", "--count", `${shas["task-b"]}..HEAD`]) === "1",
    "resume: task-b's worktree and commit are untouched",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
