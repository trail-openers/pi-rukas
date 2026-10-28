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

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { ADVERSARIAL_PER_WS_MAX_RETRIES } from "../src/work-driver-adversarial-types.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import { failureEventOf } from "../src/work-driver-failure-lookup.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { nextStep } from "../src/work-driver-context.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
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

/** The last event the adversarial step itself appended, before later steps. */
function adversarialTailEvent(eventLog: readonly WorkEvent[]) {
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (e === undefined) continue;
    if (("step" in e ? e.step : undefined) === "adversarial" || e.kind === "adversarial-approved")
      return e;
  }
  return undefined;
}

/** The `dispatch-started` records of one step, narrowed so `.jobId` typechecks. */
function markersOf(
  eventLog: readonly WorkEvent[],
  step: "adversarial",
): Array<Extract<WorkEvent, { kind: "dispatch-started" }>> {
  return eventLog.filter(
    (e): e is Extract<WorkEvent, { kind: "dispatch-started" }> =>
      e.kind === "dispatch-started" && e.step === step,
  );
}

/** A host that swallows messages; a DriverHost is structural (#1020). */
function makeFakePi(): DriverHost {
  return {
    sendUserMessage: () => undefined,
    emit: () => undefined,
  } as unknown as DriverHost;
}

/** The step handlers take a `CycleContext`, which requires a sink (#1162). */
const SILENT_SINK: NonNullable<CycleContext["emitSink"]> = {
  emit: () => undefined,
  fingerprints: [],
};

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

    const ctx: CycleContext = {
      host: makeFakePi(),
      emitSink: SILENT_SINK,
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
          onDisk !== undefined &&
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
  const started = markersOf(during.eventLog, "adversarial");
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
    const tree: Record<string, string> = {
      "task-a": `${dir}/.worktrees/task-a`,
      "task-b": `${dir}/.worktrees/task-b`,
    };
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
    const ctx: CycleContext = {
      host: makeFakePi(),
      emitSink: SILENT_SINK,
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
    const started = markersOf(after.eventLog, "adversarial");
    const last = after.eventLog[after.eventLog.length - 1];
    // The re-emitted marker's IDENTITY (its `at`/`label` matching the persisted
    // record, and the headless `durationMs` that reads them) is asserted in
    // test-work-driver-adversarial-marker-identity.ts, which observes the
    // on-disk record directly rather than the batch the splice built.
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

// ── A FAILED adversarial dispatch never leaves the step on its write-ahead
// marker, and never routes to commit-pr (#1863 cause A).
//
// The whole reason the adversarial step now writes ahead is that a killed
// reviewer leaves something on disk. The write-ahead has one hazard: the marker
// is a `dispatch-started`, and if a pass died without clearing it the step's
// tail would be that marker. `failureEventOf` reads only the tail, `nextStep()`
// has no `dispatch-failed` branch at all, and the linear step table goes
// `adversarial → commit-pr` — so a stale marker is not an audit wrinkle, it is
// an unreviewed diff past the gate. The assertion is driven through the REAL
// fan-out (`runAdversarial`, no stubbed step) and observes the state the step
// RETURNS, which is what the driver persists and what `nextStep()` routes on.
async function failedDispatchNeverAdvances(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), `work-driver-1863-no-advance-`));
  try {
    initCleanRepo(dir);
    const s = initialState(1863, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: { default: dir },
      workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
      branchName: "feature/issue-1863",
    };
    await writeState(dir, s);
    const ctx: CycleContext = {
      host: makeFakePi(),
      emitSink: SILENT_SINK,
      repoRoot: dir,
      issue: 1863,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      // An infrastructure death, not a rejection: `ok: false` with no verdict.
      // `killCause: "inactivity"` is what makes it TRANSIENT, so the fan-out's
      // ladder runs (the shape #357 T8 exercises) rather than parking at once.
      // `errorStop` is what the loop itself synthesises for a killed phase and
      // is what `interpretReview` reads, so an injected result carries it.
      adversarialLoopFn: async () =>
        mkResult({
          ok: false,
          exitCode: 1,
          loopOutcome: "infra-failure",
          adversarialRounds: [],
          text: "",
          killCause: "inactivity",
          errorStop: { reason: "child-bound", message: "killed at its run bound" },
        }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`no dispatch expected: ${spec.role}/${opts?.label}`);
      },
    };
    // Drive the step through the REAL driver — the path #357 T8 exercises, and
    // the only one whose worktree/verify setup reaches the fan-out with a diff
    // it will actually review (calling `runAdversarial` directly on this fixture
    // short-circuits before dispatching, which would make every assertion below
    // vacuously true). One driver run spends the ladder AND applies the step
    // router's RETRY_ONCE, so this observes the whole two-tier shape: the
    // fan-out's dispatch events, the budget they carry, and the cap that
    // finally routes the park.
    await runWorkDriver(ctx);
    const fanState = (await readState(dir, 1863))!;
    // The property the router actually depends on: `failureEventOf` reads the
    // tail, and a tail that is a `dispatch-started` is invisible to it — which
    // is how an unreviewed diff fell through the linear step table to
    // commit-pr. Assert the router's own view plus the tail shape, rather than
    // "the last dispatch event is a failure" (later steps legitimately write
    // their own markers after this one, and the whole cycle has run here).
    const adversarialTail = adversarialTailEvent(fanState.eventLog);
    assert(
      adversarialTail?.kind !== "dispatch-started",
      `the adversarial step's own tail is never a write-ahead marker (tail: ${adversarialTail?.kind})`,
    );
    const routerFailure = failureEventOf(fanState.eventLog);
    assert(
      routerFailure === undefined ||
        ("step" in routerFailure ? routerFailure.step : undefined) === "adversarial",
      `the failure the router reads is the adversarial dispatch's (got ${routerFailure?.kind ?? "none"} / ${
        routerFailure !== undefined && "step" in routerFailure ? routerFailure.step : "-"
      })`,
    );
    assert(
      fanState.eventLog.some((e) => e.kind === "dispatch-failed" && e.step === "adversarial"),
      "the failed adversarial dispatch is recorded as a dispatch-failed",
    );
    assert(
      fanState.pipelineState.inFlightJobIds.length === 0,
      `a failed dispatch clears its in-flight marker (left: ${JSON.stringify(fanState.pipelineState.inFlightJobIds)})`,
    );
    // #1863 — the ladder the fan-out spent must be in the state the step
    // RETURNS, which is what the driver persists. It is what the step-level
    // RETRY_ONCE's re-entry seeds its per-workstream budget from; a fan-out
    // that spent its ladder and reported none ran a whole second ladder on the
    // retry (#357 T8: 6 calls instead of 4).
    assert(
      Object.values(fanState.pipelineState.adversarialTransientRetries ?? {}).some(
        (used) => used >= ADVERSARIAL_PER_WS_MAX_RETRIES,
      ),
      `the fan-out's spent ladder survives in the state the step returns (got ${JSON.stringify(fanState.pipelineState.adversarialTransientRetries)})`,
    );
    assert(
      fanState.eventLog.some((e) => e.kind === "dispatch-started" && e.step === "adversarial"),
      "the pass wrote its marker ahead — the audit record survives",
    );
    assert(
      !fanState.eventLog.some((e) => e.kind === "adversarial-approved"),
      "a failed dispatch is never an approval",
    );
    // The routing consequence: `nextStep()` has no `dispatch-failed` branch,
    // so a tail that is NOT a failure falls through the linear table into
    // commit-pr. Assert the routing directly rather than only the tail shape.
    assert(
      nextStep(fanState).kind === "done" ||
        (nextStep(fanState).kind === "step" &&
          (nextStep(fanState) as { step: string }).step !== "commit-pr"),
      `a step whose reviewer failed does not route to commit-pr (routes to ${JSON.stringify(nextStep(fanState))})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await failedDispatchNeverAdvances();

console.log(`\nexit ${exit}`);
process.exit(exit);
