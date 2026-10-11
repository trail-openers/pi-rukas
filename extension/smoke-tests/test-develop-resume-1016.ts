#!/usr/bin/env bun
/**
 * #1016 — crash-resume of a develop fan-out, driven end-to-end through
 * runWorkDriver from a real `running` state file with an in-flight dispatch.
 *
 * The crashed attempt left: task-a green (a commit), task-b failed with partial
 * uncommitted edits, task-c never run. The resumed run must keep task-a, save
 * task-b's partial edits to a re-appliable patch before re-dispatching it,
 * persist each branch-completed as its workstream finishes, and leave task-a
 * green in the resumed window so a second crash still finds it.
 *
 * No real Pi spawn happens; all dispatchFn calls are mocked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { greenWorkstreamsFromInterruptedDevelop } from "../src/work-develop-greens.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, readState, writeState } from "../src/workflow-state.ts";
import { gitIn, makeBaseWorktrees, mockDeveloperWork } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

const mockIssueBodyOk = async (issue: number) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body — non-empty placeholder`,
});

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "developer",
    ok: true,
    text: "mock developer output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const ISSUE = 1016;
const dir = mkdtempSync(path.join(tmpdir(), "resume-1016-"));
const probeDir = mkdtempSync(path.join(tmpdir(), "resume-probe-1016-"));
try {
  await mkdir(path.join(dir, ".git", "info"), { recursive: true });
  const ids = ["task-a", "task-b", "task-c"];
  const shas = await makeBaseWorktrees(dir, ids);
  const wt = (id: string) => path.join(dir, ".worktrees", id);

  // The crashed attempt's worktrees.
  writeFileSync(path.join(wt("task-a"), "a.txt"), "a\n");
  gitIn(wt("task-a"), ["add", "a.txt"]);
  gitIn(wt("task-a"), ["commit", "-qm", "task-a work"]);
  const aHead = gitIn(wt("task-a"), ["rev-parse", "HEAD"]);
  writeFileSync(
    path.join(wt("task-b"), "partial-b.txt"),
    "half-written by the crashed developer\n",
  );

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
      workstreams: Object.fromEntries(
        ids.map((id) => [id, { id, scope: id, paths: [`${id}.txt`], outOfScope: [] }]),
      ),
      workstreamBaseShas: shas,
      reviewRound: 0,
      ciRetryCount: 0,
      plumbReports: [],
      status: "running",
      branchName: `feature/issue-${ISSUE}-resume`,
    },
    eventLog: [
      { kind: "step-started", step: "develop", at: 1 },
      {
        kind: "dispatch-started",
        step: "develop",
        role: "developer",
        jobId: "j-crashed",
        label: "developer×3",
        at: 2,
      },
      { kind: "branch-completed", step: "develop", workstreamId: "task-a", ok: true, ms: 1, at: 3 },
      {
        kind: "branch-completed",
        step: "develop",
        workstreamId: "task-b",
        ok: false,
        ms: 1,
        at: 4,
        error: "crashed",
      },
    ],
  } as unknown as WorkState;
  await writeState(dir, state);

  // Waits until task-b's completion is on disk; reports what else was persisted.
  const waitForOnDisk = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const ev = (await readState(dir, ISSUE))?.eventLog ?? [];
      if (ev.some((e) => e.kind === "branch-completed" && e.workstreamId === "task-b" && e.ok)) {
        return {
          taskBPersisted: true,
          taskAKept: ev.some(
            (e) =>
              e.kind === "branch-completed" && e.workstreamId === "task-a" && e.resumed === true,
          ),
        };
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return { taskBPersisted: false, taskAKept: false };
  };

  const labels: string[] = [];
  let midFanOut = { taskBPersisted: false, taskAKept: false };
  const ctx: DriverContext = {
    pi: makeFakePi(),
    repoRoot: dir,
    issue: ISSUE,
    issueBodyFetcherFn: mockIssueBodyOk,
    dispatchFn: async (_pi, spec, opts) => {
      if (spec.role !== "developer") throw new Error("smoke: halting after develop fanout");
      const label = opts?.label ?? spec.role;
      labels.push(label);
      // task-c is the last to finish: by then task-b's completion must be on disk.
      if (label === "developer[task-c]") midFanOut = await waitForOnDisk();
      mockDeveloperWork(spec.cwd ?? dir, label);
      return mkResult({ text: `mock developer output for ${label}` });
    },
  };
  await runWorkDriver(ctx);

  // ── selective resume ────────────────────────────────────────────────────
  assert(
    !labels.includes("developer[task-a]"),
    "resume: the kept green task-a is never re-dispatched",
  );
  assert(
    labels.filter((l) => l === "developer[task-b]").length === 1 &&
      labels.includes("developer[task-c]"),
    "resume: task-b (failed) and task-c (never ran) are each dispatched once",
  );
  assert(
    gitIn(wt("task-a"), ["rev-parse", "HEAD"]) === aHead,
    "resume: task-a's HEAD is unchanged",
  );

  // ── partial work saved before re-dispatch ──────────────────────────────
  const scratch = path.join(dir, "tmp", `issue-${ISSUE}`);
  const patches = existsSync(scratch)
    ? readdirSync(scratch).filter((n) => /^retry-task-b-\d+\.patch$/.test(n))
    : [];
  assert(
    patches.length === 1,
    "resume: task-b's uncommitted work is saved to a patch before re-dispatch",
  );
  const patchPath = path.join(scratch, patches[0] ?? "missing.patch");
  assert(
    patches.length === 1 &&
      readFileSync(patchPath, "utf8").includes("half-written by the crashed developer"),
    "resume: the saved patch holds the partial edit",
  );
  // Re-apply the saved patch onto base in a fresh worktree: the work is recoverable.
  gitIn(probeDir, ["init", "-q"]);
  gitIn(probeDir, ["commit", "--allow-empty", "-qm", "base"]);
  gitIn(probeDir, ["apply", "--binary", patchPath]);
  assert(
    existsSync(path.join(probeDir, "partial-b.txt")) &&
      readFileSync(path.join(probeDir, "partial-b.txt"), "utf8").includes("half-written"),
    "resume: the saved patch re-applies onto base and restores the partial edit",
  );

  // ── per-completion persistence and the second-crash window ─────────────
  assert(midFanOut.taskBPersisted, "mid-fan-out: task-b's completion is on disk while task-c runs");
  assert(
    midFanOut.taskAKept,
    "mid-fan-out: kept green task-a is re-recorded at the start of the resumed window",
  );
  const after = await readState(dir, ISSUE);
  const secondCrash = after
    ? ({
        ...after,
        pipelineState: { ...after.pipelineState, currentStep: "develop", inFlightJobIds: ["j-2"] },
      } as WorkState)
    : undefined;
  const greensAfterSecondCrash = secondCrash
    ? greenWorkstreamsFromInterruptedDevelop(secondCrash)
    : new Set<string>();
  assert(
    greensAfterSecondCrash.has("task-a"),
    "second crash: task-a is still green in the resumed window (not re-dispatched next time)",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(probeDir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
