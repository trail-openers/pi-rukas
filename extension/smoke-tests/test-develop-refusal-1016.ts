#!/usr/bin/env bun
/**
 * #1016 — a driver refusal is a NON-transient develop failure.
 *
 * A refused workstream (no worktree recorded, unsafe reuse, containment) must
 * halt the develop step with its reason: no transient retry with backoff, no
 * `dispatch-failed` event, and no advance to adversarial / commit-pr. Even when
 * a sibling dispatch failed transiently, the fan-out is not retried.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { refuseMissingWorktrees } from "../src/work-develop-missing-worktree.ts";
import { failureEventOf } from "../src/work-driver-failure-lookup.ts";
import { routeStepOutcome } from "../src/work-driver-step-router.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REASON = "no worktree recorded for workstream a";

function refusedFanOut(extra: WorkEvent[] = []): WorkEvent[] {
  const branchEvents: WorkEvent[] = [];
  const verdicts: Array<{ id: string; ok: boolean; reason?: string }> = [];
  const failedOrSkipped = new Set<string>();
  const failureSource: Record<string, "skipped" | "failed"> = {};
  refuseMissingWorktrees({
    missing: ["a"],
    reasons: { a: REASON },
    branchEvents,
    verdicts,
    failedOrSkipped,
    failureSource,
  });
  return [
    { kind: "branches-fanned-out", step: "develop", workstreams: ["a", ...extra.map(() => "b")], at: 1 },
    ...extra,
    ...branchEvents,
    { kind: "branches-converged", step: "develop", verdicts, at: 3 },
  ];
}

const transientSibling: WorkEvent = {
  kind: "dispatch-failed",
  step: "develop",
  role: "developer",
  jobId: "j1",
  label: "developer[b]",
  ms: 1,
  at: 2,
  errorTail: "Request timed out.",
} as WorkEvent;

// 1. The refusal is typed and carries its reason; no dispatch-failed is emitted.
{
  const events = refusedFanOut();
  const bc = events.find((e) => e.kind === "branch-completed");
  assert(bc?.kind === "branch-completed" && bc.refused === true, "refusal: branch-completed carries refused: true");
  assert(
    bc?.kind === "branch-completed" && bc.error === REASON,
    "refusal: branch-completed carries the refusal reason",
  );
  assert(!events.some((e) => e.kind === "dispatch-failed"), "refusal: no dispatch-failed event is recorded");
  const conv = events[events.length - 1];
  assert(
    conv?.kind === "branches-converged" && conv.verdicts[0]?.reason === REASON,
    "refusal: branches-converged verdict carries the reason",
  );
  assert(failureEventOf(events) === undefined, "refusal: failureEventOf declines (not transient)");
}

// 2. A refusal beside a transient sibling is still not retried.
{
  const events = refusedFanOut([transientSibling]);
  assert(failureEventOf(events) === undefined, "refusal + transient sibling: failureEventOf declines");
}

// 3. The step router halts develop with the refusal, with no transient retry.
{
  const dir = mkdtempSync(path.join(tmpdir(), "develop-refusal-1016-"));
  try {
    const base = initialState(1016, 1_000_000);
    const state = {
      ...base,
      pipelineState: { ...base.pipelineState, currentStep: "develop" as const },
      eventLog: refusedFanOut(),
    };
    await writeState(dir, state);
    const ctx = { repoRoot: dir, issue: 1016 } as unknown as DriverContext;
    const out = await routeStepOutcome(ctx, state, "develop", { num: 3, total: 9 }, 1, Date.now());
    const tail = out.state.eventLog[out.state.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "step-failed:develop",
      `refusal: develop halts at step-failed:develop (got ${tail?.kind === "cap-hit" ? tail.cap : tail?.kind})`,
    );
    assert(out.state.pipelineState.currentStep === "handoff", "refusal: cycle routes to handoff");
    assert(
      (out.state.pipelineState.transientRetryAttempts?.develop ?? 0) === 0,
      "refusal: no transient retry budget consumed",
    );
    assert(out.retry === true, "refusal: router halts (no step advance)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);
