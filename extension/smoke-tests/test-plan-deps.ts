#!/usr/bin/env bun
/**
 * #849 — planQuality is written ONCE by runPlan, and the final reason is
 * computed once: a corrective re-plan that drops a dependsOn edge while the
 * first plan has ANOTHER quality issue records dropped-dependencies (the
 * #849 signal must not be lost to the stale first-plan reason), and the
 * dropped edges persist as planQuality.droppedEdges so the operator sees the
 * original trigger's evidence, not just the reason.
 *
 * #1005 — the coupling merge runs BEFORE the quality gate. A plan with a
 * depends-on edge between two workstreams is merged by rule 2 before the
 * gate sees it, so the gate sees the post-merge plan (one workstream) and
 * no quality issue → no corrective fires. The dropped-edge check compares
 * the FIRST plan's RAW workstreams (held aside as firstPlanWorkstreams)
 * against the corrective's RAW workstreams — but if the corrective never
 * fires (the post-merge plan has no quality issue), the dropped-edge check
 * has no corrective to compare against and does not fire either.
 *
 * This test exercises the #849 path where the corrective DOES fire: the
 * first plan has a quality issue that is NOT subsumed by the coupling merge
 * (task-b has a non-empty path AND a depends-on edge, but the paths OVERLAP
 * with task-a — the coupling merge's rule 1 fires on the overlap, merging
 * task-b into task-a, and the gate sees one workstream → no quality issue).
 * To make the corrective fire, the first plan must have a quality issue on
 * the POST-MERGE plan. The simplest shape: task-b depends on task-a (rule 2
 * merges them), and the merged workstream has an empty-paths defect (both
 * task-a and task-b have empty paths — the merge's union is empty). The gate
 * fires on empty-paths; the corrective re-plans with a valid plan that
 * drops the depends-on edge → dropped-dependencies.
 *
 * Fully offline: runPlan with an injected dispatchFn, PI_ENSEMBLE_RESUME=0
 * (no state write-ahead), PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0 (no gh calls
 * in the path-claim registry), and NO verifyExecFn (rule 3 is skipped).
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

// #1005 — the first plan has task-b depending on task-a (rule 2 couples them)
// AND both task-a and task-b have empty paths (the merged workstream's union
// is empty → empty-paths on the post-merge plan). The quality gate fires on
// empty-paths; the corrective re-plans with a valid plan (task-a with a path,
// task-b with a path, no depends-on — the corrective DROPS the edge). The
// dropped-edge check fires: first plan's RAW workstreams had task-b→task-a;
// the corrective's RAW workstreams have no such edge and no merge of the pair
// → dropped-dependencies.
{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-dropped-deps-"));
  try {
    const primaryPlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "",
      "### task-b — the dependent",
      "- depends-on: task-a",
      "",
    ].join("\n");
    const correctivePlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts",
      "",
      "### task-b — the dependent",
      "- paths: src/b.ts",
      "",
    ].join("\n");
    let calls = 0;
    const ctx = mkCtx(dir, async () => {
      calls += 1;
      return mkResult(calls === 1 ? primaryPlan : correctivePlan);
    });
    const next = await runPlan(ctx, stateWithArtifact(dir, "1. a\n2. b\n"), 1_000_000);
    assert(calls === 2, "the first plan's quality issue (empty-paths on the post-merge plan) triggers exactly one corrective");
    assert(
      next.pipelineState.planQuality?.reason === "dropped-dependencies",
      "corrective dropped the edge → the final state says dropped-dependencies (not the stale empty-paths reason)",
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
//
// The first plan has task-b depending on task-a (rule 2 merges them) and
// task-b has a non-empty path (so the post-merge plan has paths → no
// empty-paths defect). The gate sees one workstream (the merged task-a)
// with paths → no quality issue → no corrective fires (calls === 1).
// The cycle proceeds with the merged plan; no droppedEdges.
{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-kept-deps-"));
  try {
    const primaryPlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts",
      "",
      "### task-b — the dependent",
      "- paths: src/b.ts",
      "- depends-on: task-a",
      "",
    ].join("\n");
    let calls = 0;
    const ctx = mkCtx(dir, async () => {
      calls += 1;
      return mkResult(primaryPlan);
    });
    const next = await runPlan(ctx, stateWithArtifact(dir, "1. a\n2. b\n"), 1_000_000);
    assert(calls === 1, "(no-drop): the coupling merge merges task-b into task-a → no corrective is triggered (the post-merge plan has no quality issue)");
    assert(
      next.pipelineState.workstreams && Object.keys(next.pipelineState.workstreams).length === 1,
      "(no-drop): one workstream after the coupling merge",
    );
    assert(
      next.pipelineState.planQuality?.droppedEdges === undefined,
      "(no-drop): no droppedEdges when nothing was dropped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #1005 kill-path regression: a kill-triggered corrective must NOT feed a
// partial map to the dropped-edge check. Pre-#1005: firstPlanWorkstreams
// was set to firstPlanRaw at declaration, so the killed primary's partial
// map (parsed from a killed child's empty report) was passed to the
// dropped-edge check. Post-#1005: firstPlanWorkstreams is set ONLY when
// the quality gate fires on the primary's plan, so the kill path leaves it
// undefined and the dropped-edge check does not fire.
//
// The shape: primary plan is killed (timeout, no structured output →
// parseWorkstreams returns {}). The corrective re-plans successfully with
// two workstreams that have a depends-on edge. The dropped-edge check must
// NOT fire (firstPlanWorkstreams is undefined) — the corrective's edge is
// not a "drop" because there was no first plan to drop it from.
{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-kill-path-"));
  try {
    const correctivePlan = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts",
      "",
      "### task-b — the dependent",
      "- paths: src/b.ts",
      "- depends-on: task-a",
      "",
    ].join("\n");
    let calls = 0;
    // The primary is stubbed as a timeout kill (`killCause: "timeout"`) so
    // the kill path runs and leaves `firstPlanWorkstreams` unset.
    const killResult: DispatchResult = {
      role: "explore",
      ok: false,
      text: "",
      toolUses: [],
      ms: 10,
      exitCode: 143,
      transcriptPath: "/tmp/stub-plan-kill-transcript.json",
      killCause: "timeout",
      killBudgetMs: 60_000,
    };
    const killCtx = mkCtx(dir, async () => {
      calls += 1;
      return calls === 1 ? killResult : mkResult(correctivePlan);
    });
    const prevEnv = process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS;
    process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = "60000";
    let next: WorkState;
    try {
      next = await runPlan(killCtx, stateWithArtifact(dir, "1. a\n2. b\n"), 1_000_000);
    } finally {
      if (prevEnv === undefined) delete process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS;
      else process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = prevEnv;
    }
    assert(calls === 2, "kill path: the primary kill triggers exactly one corrective re-dispatch");
    assert(
      next.pipelineState.planQuality?.droppedEdges === undefined,
      "kill path: no droppedEdges (firstPlanWorkstreams is undefined on the kill path — the corrective's edge is not a 'drop')",
    );
    assert(
      next.pipelineState.planQuality?.reason === undefined,
      "kill path: no quality reason recorded (the corrective plan has no quality issue)",
    );
    assert(
      Object.keys(next.pipelineState.workstreams ?? {}).length === 1,
      "kill path: the coupling merge merges task-b into task-a (depends-on rule) → one workstream",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll plan-deps assertions passed." : "\nFAILURES above.");
process.exit(exit);
