#!/usr/bin/env bun
/**
 * #849 — planQuality is written ONCE by runPlan, and the final reason is
 * computed once: a corrective re-plan that drops a dependsOn edge while the
 * first plan has ANOTHER quality issue records dropped-dependencies (the
 * #849 signal must not be lost to the stale first-plan reason), and the
 * dropped edges persist as planQuality.droppedEdges so the operator sees the
 * original trigger's evidence, not just the reason.
 *
 * Fully offline: runPlan with an injected dispatchFn, PI_ENSEMBLE_RESUME=0
 * (no state write-ahead), PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0 (no gh calls
 * in the path-claim registry).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";

const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

function mkResult(text: string): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-plan-deps-transcript.json",
  };
}

function mkCtx(dir: string, dispatchFn: DriverContext["dispatchFn"]): DriverContext {
  return { pi: fakePi, repoRoot: dir, issue: 849, dispatchFn };
}

function stateWithArtifact(dir: string, body: string): WorkState {
  const artifact = path.join(dir, "issue-body.txt");
  writeFileSync(artifact, body);
  const s0 = initialState(849, 1_000_000);
  return { ...s0, pipelineState: { ...s0.pipelineState, issueBodyArtifact: artifact } };
}

// The first plan has TWO defects (task-b has empty paths — empty-paths; and
// it overlaps task-a on src/b.ts); the corrective fixes both but drops the
// dependsOn edge. The final state must say dropped-dependencies, not the
// stale first-plan reason.
{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-dropped-deps-"));
  try {
    const primaryPlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts, src/b.ts",
      "",
      "### task-b — the dependent",
      "- depends-on: task-a",
      "",
    ].join("\n");
    const correctivePlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts, src/b.ts",
      "",
      "### task-b — the dependent",
      "- paths: src/c.ts",
      "",
    ].join("\n");
    let calls = 0;
    const ctx = mkCtx(dir, async () => {
      calls += 1;
      return mkResult(calls === 1 ? primaryPlan : correctivePlan);
    });
    // 4 findings → findingsCount 4 (no under-decomposition for N=2; the
    // empty-paths rule fires on task-b instead).
    const next = await runPlan(ctx, stateWithArtifact(dir, "1. a\n2. b\n3. c\n4. d\n"), 1_000_000);
    assert(calls === 2, "the first plan's quality issue triggers exactly one corrective");
    assert(
      next.pipelineState.planQuality?.reason === "dropped-dependencies",
      "corrective dropped the edge AND the first plan had another quality issue → the final state says dropped-dependencies, not the stale first-plan reason",
    );
    assert(
      next.pipelineState.planQuality?.redispatched === true,
      "the corrective re-dispatch is recorded",
    );
    assert(
      next.pipelineState.planQuality?.droppedEdges?.length === 1 &&
        next.pipelineState.planQuality?.droppedEdges?.[0]?.from === "task-b" &&
        next.pipelineState.planQuality?.droppedEdges?.[0]?.to === "task-a",
      "droppedEdges persists the dropped edge (from→to) alongside the reason",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A corrective that PRESERVES the edge records nothing: no
// dropped-dependencies reason, no droppedEdges (the single planQuality write
// leaves the first plan's reason untouched when there is no drop).
{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-kept-deps-"));
  try {
    const primaryPlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts, src/b.ts",
      "",
      "### task-b — the dependent",
      "- depends-on: task-a",
      "",
    ].join("\n");
    const correctivePlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts, src/b.ts",
      "",
      "### task-b — the dependent",
      "- paths: src/c.ts",
      "- depends-on: task-a",
      "",
    ].join("\n");
    let calls = 0;
    const ctx = mkCtx(dir, async () => {
      calls += 1;
      return mkResult(calls === 1 ? primaryPlan : correctivePlan);
    });
    const next = await runPlan(ctx, stateWithArtifact(dir, "1. a\n2. b\n"), 1_000_000);
    assert(calls === 2, "(no-drop): exactly one corrective re-dispatch");
    assert(
      next.pipelineState.planQuality?.reason === "empty-paths",
      "(no-drop): edge preserved → the first plan's own reason stands (not dropped-dependencies)",
    );
    assert(
      next.pipelineState.planQuality?.droppedEdges === undefined,
      "(no-drop): no droppedEdges when nothing was dropped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll plan-deps assertions passed." : "\nFAILURES above.");
process.exit(exit);
