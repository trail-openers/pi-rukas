#!/usr/bin/env bun
/**
 * #1863 — the adversarial step writes ahead.
 *
 * Cause B of the exit-30-without-handoff field failure: the adversarial step
 * persisted NOTHING before dispatching its round reviewer. `step-started` was
 * appended in memory only, the reviewer went through `runAdversarialLoop`
 * directly (bypassing `runSingleDispatch` / `beginDispatch`), and the only
 * write in the whole family was the fix dispatch. Disk writes happened at the
 * step boundary, reached only after `runAdversarial` returned. So a cycle whose
 * reviewer was killed at its run bound left the state file at develop's
 * boundary with `inFlightJobIds: []` — indistinguishable from a step that never
 * started, and the runner had nothing to project.
 *
 * This test observes the state file WHILE the review is in flight: the injected
 * `adversarialLoopFn` (the seam the real fan-out calls) reads the file back
 * from disk at the moment it is asked to review, and records what it saw. Then
 * it reads the file again after the step finished. Nothing here trusts the
 * in-memory state the step returns — that is exactly what a crash does not have.
 *
 * Offline: no spawn, no sleep.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult, ExtensionAPI } from "../src/types.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import { initCleanRepo } from "./lib/clean-repo-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "Adversarial APPROVED after round 1.\n",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
    ...overrides,
  };
}

function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

/** What the state file said while a review was in flight, and after it closed. */
interface Observation {
  /** The disk state at the moment the reviewer was asked to run. */
  during?: Awaited<ReturnType<typeof readState>>;
  /** The runId the fan-out handed the loop for this dispatch. */
  runId?: string;
}

async function run(name: string, multi: boolean): Promise<Observation> {
  const dir = mkdtempSync(path.join(tmpdir(), `work-driver-1863-writeahead-`));
  const obs: Observation = {};
  try {
    const s = initialState(1863, 1_000_000);
    const ids = multi ? ["task-a", "task-b"] : ["default"];
    const tree: Record<string, string> = {};
    const streams: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    > = {};
    for (const w of ids) {
      if (w === "default") continue;
      tree[w] = `${dir}/.worktrees/${w}`;
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
      initCleanRepo(tree[w]);
    }
    if (!multi) initCleanRepo(dir);
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: multi ? tree : {},
      workstreams: multi ? streams : undefined,
      branchName: "feature/issue-1863",
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      host: makeFakePi(),
      repoRoot: dir,
      issue: 1863,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params, _signal, orchestratorJobId) => {
        // THE OBSERVATION: read the file from disk while this dispatch is
        // outstanding. A reviewer killed here would leave precisely this state.
        const onDisk = await readState(dir, 1863);
        // The batch is a PARALLEL fan-out, so the two workstreams' callbacks
        // interleave and the first to arrive is not the first in the log. This
        // instrument's claim is "the child's id is a marker the fan-out already
        // persisted", which is a per-call fact: record it for whichever call
        // first saw an in-flight marker naming it, not for call number one.
        if (
          obs.during === undefined &&
          onDisk.pipelineState.inFlightJobIds.includes(orchestratorJobId)
        ) {
          obs.during = onDisk;
          obs.runId = orchestratorJobId;
        }
        if (obs.during === undefined) {
          // Still capture the first observation for the mid-review state
          // assertions; the id assertion below pairs with the matching marker.
          obs.during = onDisk;
          obs.runId = orchestratorJobId;
        }
        return mkResult();
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };
    const after = await runAdversarial(ctx, (await readState(dir, 1863))!, Date.now());
    // The step's own boundary write is what runAdversarial returns; the driver
    // persists it. Compare against the file the fan-out saw mid-review.
    void after;
    return obs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const multi of [false, true]) {
  const label = multi ? "N>1 fan-out" : "N=1";
  const obs = await run(`n${multi ? "multi" : "one"}`, multi);
  const during = obs.during;
  assert(during !== undefined, `${label}: the reviewer was actually dispatched`);
  if (!during) continue;
  const started = during.eventLog.filter(
    (e) => e.kind === "dispatch-started" && e.step === "adversarial",
  );
  assert(
    started.length >= 1,
    `${label}: dispatch-started is PERSISTED while the review runs (got ${started.length})`,
  );
  assert(
    during.pipelineState.inFlightJobIds.length >= 1,
    `${label}: inFlightJobIds names the in-flight dispatch (got ${JSON.stringify(during.pipelineState.inFlightJobIds)})`,
  );
  const marker = started[0];
  assert(
    marker !== undefined && during.pipelineState.inFlightJobIds.includes(marker.jobId),
    `${label}: the persisted marker's jobId is the in-flight id`,
  );
  // Every id the fan-out gave a child must be a marker it wrote ahead — that is
  // the property resume depends on, and it is per-child, so it is checked over
  // all of them rather than against `started[0]` (whose owner is whichever child
  // happened to be observed first).
  assert(
    started.every((m) => during.pipelineState.inFlightJobIds.includes(m.jobId)),
    `${label}: every dispatched child's id is in inFlightJobIds (${started.length} marker(s), ${during.pipelineState.inFlightJobIds.length} in flight)`,
  );
  assert(
    obs.runId !== undefined && started.some((m) => m.jobId === obs.runId),
    `${label}: the id the observed child received IS one of the persisted markers (child ${obs.runId})`,
  );
  const stepStarted = during.eventLog.filter(
    (e) => e.kind === "step-started" && e.step === "adversarial",
  );
  assert(
    stepStarted.length >= 1,
    `${label}: step-started for adversarial reached disk before the review finished (got ${stepStarted.length})`,
  );
  assert(
    during.resumable === true,
    `${label}: the mid-review file is marked resumable (got ${during.resumable})`,
  );
  assert(
    during.owner?.pid === process.pid,
    `${label}: the mid-review file records an owner (crash-resume can tell live from dead)`,
  );
}

// ── The marker is cleared on every exit, so the tail is never a dispatch-started.
async function clearedOnExit(name: string, mode: "approved" | "threw"): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), `work-driver-1863-clear-`));
  try {
    const s = initialState(1863, 1_000_000);
    const tree = { "task-a": `${dir}/.worktrees/task-a`, "task-b": `${dir}/.worktrees/task-b` };
    const streams: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    > = {};
    for (const w of Object.keys(tree)) {
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
      initCleanRepo(tree[w]!);
    }
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: tree,
      workstreams: streams,
      branchName: "feature/issue-1863",
    };
    await writeState(dir, s);
    const ctx: DriverContext = {
      host: makeFakePi(),
      repoRoot: dir,
      issue: 1863,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop();
        if (id === "task-a" && mode === "threw") throw new Error("reviewer threw");
        return mkResult();
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };
    const after = await runAdversarial(ctx, (await readState(dir, 1863))!, Date.now());
    assert(
      after.pipelineState.inFlightJobIds.length === 0,
      `${name}: every write-ahead marker was cleared (left: ${JSON.stringify(after.pipelineState.inFlightJobIds)})`,
    );
    const started = after.eventLog.filter((e) => e.kind === "dispatch-started");
    const last = after.eventLog[after.eventLog.length - 1];
    assert(
      last?.kind !== "dispatch-started",
      `${name}: the step's tail is NOT a dispatch-started (got ${last?.kind})`,
    );
    // The marker stays in the log as the record that a dispatch was paid for —
    // `clearForResume` keeps orphans for exactly this reason.
    assert(
      started.length >= 1,
      `${name}: the dispatch-started records are kept for the audit trail (got ${started.length})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await clearedOnExit("approved pass", "approved");
await clearedOnExit("throwing pass", "threw");

console.log(`\nexit ${exit}`);
process.exit(exit);
