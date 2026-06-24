#!/usr/bin/env bun
/**
 * Smoke test for /work-status (PR2 O4).
 *
 * Exercises `renderStatus()` against synthetic WorkState fixtures —
 * pure-function, no I/O, no Pi spawn. The renderer is the bulk of the
 * /work-status command; the live wiring (cwd resolution, file reads,
 * notify) is covered by test-command-flow's command-registration
 * assertions.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type WorkState,
  appendEvent,
  initialState,
  workStateFile,
  writeState,
} from "../src/workflow-state.ts";
import { renderStatus } from "../src/work-status.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakeRoot = "/tmp/fake-repo";

// 1. Fresh state — minimum render.
{
  const state = initialState(42, 1_000_000);
  const out = renderStatus(state, fakeRoot);
  assert(out.includes("/work #42 — RUNNING"), "fresh state shows RUNNING badge");
  assert(out.includes("current step: explore"), "fresh state names current step");
  assert(out.includes("state file:"), "render includes state-file path");
  assert(out.includes(".pi/work-state/42.json"), "state-file path uses .pi/work-state convention");
  assert(!out.includes("caps:"), "fresh state with reviewRound=0 does NOT show caps line");
}

// 2. State with completed steps + cap data.
{
  let state: WorkState = initialState(553, Date.now() - 600_000); // 10 min ago
  state = {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      currentStep: "lens-fix",
      lastCompletedStep: "lens-review",
      branchName: "feature/issue-553-fix",
      reviewRound: 1,
      reviewCapStartedAt: Date.now() - 200_000,
      ciRetryCount: 2,
    },
  };
  state = appendEvent(
    state,
    { kind: "step-started", step: "explore", at: state.startedAt },
    {
      kind: "dispatch-completed",
      step: "explore",
      role: "explore",
      jobId: "j1",
      label: "explore",
      ok: true,
      ms: 31000,
      at: state.startedAt + 31000,
    },
    {
      kind: "dispatch-completed",
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer",
      ok: true,
      ms: 460000,
      at: state.startedAt + 500000,
    },
    {
      kind: "lens-issues-found",
      at: state.startedAt + 550000,
      jobId: "j3",
      round: 1,
      findings: "[]",
      verdict: "ISSUES_FOUND",
    },
  );
  const out = renderStatus(state, fakeRoot);
  assert(out.includes("current step: lens-fix"), "running state names current step");
  assert(
    out.includes("last completed: lens-review"),
    "render surfaces lastCompletedStep alongside currentStep",
  );
  assert(out.includes("branch: feature/issue-553-fix"), "render shows branch name");
  assert(out.includes("review round 1/3"), "render shows review-round cap state");
  assert(out.includes("wall-clock"), "render shows wall-clock cap when timer set");
  assert(out.includes("ci retries: 2/2"), "render shows ciRetryCount/MAX_CI_RETRIES");
  assert(out.includes("step durations:"), "render includes per-step duration breakdown");
  assert(out.includes("recent events"), "render includes recent-events tail");
  assert(out.includes("lens-issues-found · round 1"), "render formats recent lens event");
}

// 3. Terminal state — handoff.
{
  let state = initialState(99, 1_000_000);
  state = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "handoff", status: "handoff" },
  };
  const out = renderStatus(state, fakeRoot);
  assert(
    out.includes("HANDOFF") && out.includes("needs human attention"),
    "handoff status shows the needs-human-attention banner (PR5: 'cap-hit' inserted between)",
  );
}

// 4. Terminal state — merged.
{
  let state = initialState(100, 1_000_000);
  state = {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      currentStep: "merged",
      status: "merged",
      prNumber: 123,
    },
  };
  const out = renderStatus(state, fakeRoot);
  assert(out.includes("MERGED ✓"), "merged status shows checkmark");
  assert(out.includes("PR: #123"), "merged state shows PR number");
}

// 5. Aborted state.
{
  let state = initialState(101, 1_000_000);
  state = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "develop", status: "aborted" },
  };
  const out = renderStatus(state, fakeRoot);
  assert(out.includes("ABORTED"), "aborted status shows ABORTED");
}

// 6. Round-trip with persisted state on disk — ensures the renderer
// handles state read back from JSON (proves nothing in the renderer
// implicitly depends on object identity vs JSON-roundtrip).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-status-smoke-"));
  try {
    const state = initialState(42, 1_000_000);
    await writeState(dir, state);
    const file = workStateFile(dir, 42);
    const persisted = JSON.parse(await Bun.file(file).text()) as WorkState;
    const out = renderStatus(persisted, dir);
    assert(
      out.includes("/work #42 — RUNNING"),
      "renderStatus works against JSON-round-tripped state",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
