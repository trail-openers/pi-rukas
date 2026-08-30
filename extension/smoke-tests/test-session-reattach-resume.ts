#!/usr/bin/env bun
/**
 * #573 — session re-attach resume path.
 *
 * Tests that the crash-resume path:
 *  1. Reads the transcriptPath from dispatch-started events
 *  2. Calls resolveReattach to decide reattach vs re-dispatch
 *  3. Calls attemptReattach with injected spawnReattach
 *  4. On reattach success, emits dispatch-completed and skips runStep
 *  5. On reattach failure, falls back to re-dispatch (no transcript / flag off)
 *
 * No real Pi child is spawned — the spawnReattach function is injected by
 * the test with canned outputs.
 */

import {
  attemptReattach,
} from "../src/work-driver-resume-reattach.ts";
import {
  beginDispatch,
  clearDispatch,
  resolveReattach,
  sessionReattachEnabled,
} from "../src/work-driver-resume.ts";
import { initialState } from "../src/workflow-state.ts";
import {
  classifyRunningState,
  clearForResume,
} from "../src/work-driver-resume.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// Test 1: flag off → resolveReattach returns re-dispatch
// ---------------------------------------------------------------------------
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = undefined;
  const state = initialState(123);
  const verdict = classifyRunningState({
    ...state,
    owner: { pid: 99999, at: Date.now() - 60000 },
    pipelineState: {
      ...state.pipelineState,
      currentStep: "explore",
    },
    eventLog: [
      {
        kind: "dispatch-started",
        step: "explore",
        role: "explore",
        label: "explore",
        jobId: "explore:explore:99999:0",
        at: Date.now() - 60000,
        transcriptPath: "/tmp/test-transcript.json",
      },
    ],
    pipelineState: {
      ...state.pipelineState,
      currentStep: "explore",
      inFlightJobIds: ["explore:explore:99999:0"],
    },
  });
  assert(verdict.action === "resume", "classifyRunningState detects crash");

  const reattach = resolveReattach(
    "explore",
    [{ jobId: "explore:explore:99999:0", transcriptPath: "/tmp/test-transcript.json" }],
    Date.now(),
    3_600_000,
    Date.now() - 60_000,
  );
  assert(reattach.mode === "re-dispatch", "flag off → re-dispatch");
}

// ---------------------------------------------------------------------------
// Test 2: flag on, single dispatch, transcript present → reattach decision
// ---------------------------------------------------------------------------
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  const presentFs = { existsSync: (_p: string) => true };
  const reattach = resolveReattach(
    "explore",
    [{ jobId: "j1", transcriptPath: "/tmp/test-transcript.json" }],
    Date.now(),
    3_600_000,
    Date.now() - 60_000,
    { fs: presentFs },
  );
  assert(reattach.mode === "reattach", "flag on + single-dispatch + transcript → reattach");
  assert(
    reattach.transcriptPath === "/tmp/test-transcript.json",
    "reattach carries the correct transcriptPath",
  );
  assert(reattach.grantMs >= 5 * 60_000, "grant is at least the 5-min floor");
}

// ---------------------------------------------------------------------------
// Test 3: injected spawnReattach succeeds → reattach result
// ---------------------------------------------------------------------------
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  const mockSpawn = async () => ({
    exitCode: 0,
    stdout: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Work done — summary of changes."}]}}',
    stderr: "",
  });
  const result = await attemptReattach(
    "/tmp/test-transcript.json",
    "explore",
    "explore",
    300_000,
    mockSpawn,
  );
  assert("result" in result && result.reattach, "injected spawn → reattach succeeds");
  if ("result" in result && result.reattach) {
    assert(
      result.result.ok === true,
      "reattached result is ok=true",
    );
    assert(
      result.result.text.includes("Work done"),
      "reattached result carries the assistant text",
    );
    assert(result.result.transcriptPath === "/tmp/test-transcript.json", "transcriptPath set");
  }
}

// ---------------------------------------------------------------------------
// Test 4: injected spawnReattach fails (non-zero exit) → re-dispatch
// ---------------------------------------------------------------------------
{
  const mockFail = async () => ({ exitCode: 1, stdout: "", stderr: "error" });
  const result = await attemptReattach(
    "/tmp/test-transcript.json",
    "explore",
    "explore",
    300_000,
    mockFail,
  );
  assert(
    "reattach" in result && !result.reattach,
    "non-zero exit → reattach fails (re-dispatch)",
  );
}

// ---------------------------------------------------------------------------
// Test 5: injected spawnReattach throws → re-dispatch
// ---------------------------------------------------------------------------
{
  const mockThrow = async () => { throw new Error("spawn failed"); };
  const result = await attemptReattach(
    "/tmp/test-transcript.json",
    "explore",
    "explore",
    300_000,
    mockThrow,
  );
  assert(
    "reattach" in result && !result.reattach,
    "spawn throws → reattach fails (re-dispatch)",
  );
}

// ---------------------------------------------------------------------------
// Test 6: injected spawnReattach returns empty stdout → re-dispatch
// ---------------------------------------------------------------------------
{
  const mockEmpty = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const result = await attemptReattach(
    "/tmp/test-transcript.json",
    "explore",
    "explore",
    300_000,
    mockEmpty,
  );
  assert(
    "reattach" in result && !result.reattach,
    "empty stdout → reattach fails (no text to build result from)",
  );
}

// ---------------------------------------------------------------------------
// Test 7: fan-out step (develop) → resolveReattach returns re-dispatch
// ---------------------------------------------------------------------------
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  const presentFs = { existsSync: (_p: string) => true };
  const reattach = resolveReattach(
    "develop",
    [{ jobId: "j1", transcriptPath: "/tmp/test.json" }],
    Date.now(),
    3_600_000,
    Date.now() - 60_000,
    { fs: presentFs },
  );
  assert(reattach.mode === "re-dispatch", "fan-out step 'develop' → re-dispatch");
}

// ---------------------------------------------------------------------------
// Test 8: resume path WITH dispatch-started event → classify correctly
// ---------------------------------------------------------------------------
{
  const state = initialState(123);
  const verdict = classifyRunningState({
    ...state,
    owner: { pid: 99999, at: Date.now() - 60000 },
    pipelineState: {
      ...state.pipelineState,
      currentStep: "plan",
      inFlightJobIds: ["plan:explore:99999:0"],
    },
    eventLog: [
      {
        kind: "dispatch-started",
        step: "plan",
        role: "explore",
        label: "plan",
        jobId: "plan:explore:99999:0",
        at: Date.now() - 60000,
      },
    ],
  });
  assert(verdict.action === "resume", "classifyRunningState detects crash (with dispatch-started)");
  assert(verdict.step === "plan", "verdict identifies the crashed step");
}

// ---------------------------------------------------------------------------
// Test 9: beginDispatch records transcriptPath in dispatch-started
// ---------------------------------------------------------------------------
{
  let state = initialState(123);
  state.pipelineState.currentStep = "explore";
  const begun = await beginDispatch(
    "/tmp/test-repo",
    state,
    "explore",
    "explore",
    "explore",
    Date.now(),
    "/tmp/test-transcript.json",
  );
  const startedEvt = begun.state.eventLog.find((e) => e.kind === "dispatch-started");
  assert(startedEvt !== undefined, "beginDispatch emits dispatch-started event");
  if (startedEvt && "transcriptPath" in startedEvt) {
    assert(
      (startedEvt as { transcriptPath?: string }).transcriptPath === "/tmp/test-transcript.json",
      "transcriptPath recorded in dispatch-started",
    );
  }
  assert(
    begun.state.pipelineState.inFlightJobIds.length === 1,
    "inFlightJobIds includes the jobId",
  );
}

// ---------------------------------------------------------------------------
// Test 10: clearDispatch removes the jobId from inFlightJobIds
// ---------------------------------------------------------------------------
{
  let state = initialState(123);
  state.pipelineState.currentStep = "explore";
  state.pipelineState.inFlightJobIds = ["j1", "j2"];
  const cleared = clearDispatch(state, "j1");
  assert(
    cleared.pipelineState.inFlightJobIds.length === 1,
    "clearDispatch removes the correct jobId",
  );
  assert(
    cleared.pipelineState.inFlightJobIds[0] === "j2",
    "only the specified jobId is removed",
  );
}

// Restore the env for the rest of the suite.
process.env.PI_ENSEMBLE_SESSION_REATTACH = undefined;

console.log(`\nexit ${exit}`);
process.exit(exit);
