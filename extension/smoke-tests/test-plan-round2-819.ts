#!/usr/bin/env bun
/**
 * #819 round-2 — the plan step's kill routing, the persisted cap, and the two
 * recovery lines that could not be run.
 *
 * The round-1 review findings this pins:
 *
 * 1. A corrective plan dispatch that was KILLED (backstop / loop / token-budget
 *    / abort) used to fall through to the plan-to-spec gate, which read the
 *    killed child's empty text and capped the cycle as `plan-spec-mismatch`.
 *    A killed child produced no plan, so that verdict was the driver inventing
 *    a finding about a silence it caused. It now routes like the primary's
 *    kill: a `dispatch-failed` carrying the structured cause, whose tail the
 *    step router maps to the plan caps.
 * 2. `planSpecMismatchCap` wrote only the cap-hit event, so the state file's
 *    `planQuality.reason` was absent and the cycle read as "the shape gate
 *    passed, the run just happened to stop". It now writes both, and clips the
 *    persisted evidence (an uncovered-deliverables verdict concatenates every
 *    deliverable and all of its paths).
 * 3. The `plan-spec-mismatch` recovery recipe printed `glab issue edit` (no
 *    such subcommand) and `PI_ENSEMBLE_PLAN_QUALITY=0 /work N --restart` (a
 *    shell env prefix in front of a Pi slash command is pasted as literal text).
 *
 * Offline: `runPlan` with an injected `dispatchFn`; `PI_ENSEMBLE_RESUME=0`
 * makes the resume bookkeeping a no-op, `verifyExecFn` stubs the coupling
 * merge's grep, and no provider / git / wall clock is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import { planSpecMismatchCap } from "../src/work-driver-plan-helpers.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { routeStepOutcome } from "../src/work-driver-step-router.ts";
import type { PlanSpecMismatch } from "../src/work-driver-plan-spec-coverage.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";

const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

function mkResult(text: string, patch: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-plan-transcript.json",
    ...patch,
  };
}

const WORKSTREAMS = ["## Workstreams", "", "### default — the fix", "- paths: src/a.ts", ""].join(
  "\n",
);

/**
 * A 2-workstream plan with disjoint file sets and no `depends-on`, where
 * task-b declares NO paths. The coupling merge leaves it as two (so the
 * post-merge map the gate reads is the map this fixture authored) and
 * `planQualityReason` returns `empty-paths` — the trigger that dispatches the
 * quality-gate corrective. Neither workstream covers `src/required.ts`, so the
 * round-1 code capped on the corrective's text; the round-2 code must not when
 * the corrective was killed.
 */
const TRIGGER_PLAN = [
  "## Workstreams",
  "",
  "### task-a — the fix",
  "- paths: src/a.ts",
  "",
  "### task-b — the stub",
  "- out-of-scope: docs/",
  "",
].join("\n");

function mkCtx(dir: string, dispatchFn: DriverContext["dispatchFn"]): DriverContext {
  return {
    host: fakePi,
    repoRoot: dir,
    issue: 819,
    dispatchFn,
    // The coupling merge's rule-3 grep runs through this seam; an empty
    // stdout means "no shared symbols", so the merge is a no-op and the
    // fixture's shape — not the repo's — decides what the gate sees.
    verifyExecFn: (async () => ({ stdout: "", code: 0 })) as unknown as DriverContext["verifyExecFn"],
  };
}

/** A state whose spec has one deliverable neither plan covers, so the
 * round-1 code path had a mismatch to (wrongly) cap on. */
function stateWithSpec(state: WorkState): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      normalisedSpec: {
        intent: "fix the thing",
        deliverables: [{ id: "d1", description: "d", paths: ["src/required.ts"] }],
        acceptanceCriteria: ["it works"],
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        evidence: [],
        verdict: "proceed",
        rationale: "",
      },
    },
  };
}

// --------------------- 1. a killed corrective routes as a kill, not a mismatch

for (const cause of ["timeout", "loop", "token-budget", "abort"] as const) {
  const dir = mkdtempSync(path.join(tmpdir(), `plan-corrective-kill-${cause}-`));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      // Primary: a plan with a shape defect, so the quality gate fires and the
      // corrective is dispatched. Corrective: KILLED.
      if (seen.length === 1) return mkResult(TRIGGER_PLAN);
      return mkResult("", {
        ok: false,
        exitCode: 143,
        killCause: cause,
        killBudgetMs: cause === "timeout" ? 2 * 60 * 60_000 : 30 * 60_000,
        usage: { input: 10, output: 20, cacheRead: 100, cacheWrite: 0, cost: 0.1, turns: 12 },
      });
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(819, 1_000_000)), 1_000_000);
    assert(
      seen.length === 2 && seen[1] === "plan:corrective",
      `killed corrective (${cause}): the quality gate dispatched exactly one corrective`,
    );
    const correctiveFail = next.eventLog.find(
      (e) => e.kind === "dispatch-failed" && e.label === "plan:corrective",
    );
    assert(
      correctiveFail?.kind === "dispatch-failed" && correctiveFail.killCause === cause,
      `killed corrective (${cause}): the tail is a dispatch-failed carrying the kill cause`,
    );
    assert(
      !next.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "plan-spec-mismatch"),
      `killed corrective (${cause}): NOT judged as plan-spec-mismatch (a killed child has no plan)`,
    );
    const routed = await routeStepOutcome(
      mkCtx(dir, undefined),
      next,
      "plan",
      { num: 2, total: 9 },
      1,
      Date.now() - 100,
    );
    const capHit = routed.state.eventLog.slice().reverse().find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" &&
        capHit.cap !== "plan-spec-mismatch" &&
        ["loop-detected", "token-budget", "step-failed:plan"].includes(capHit.cap),
      `killed corrective (${cause}): the router caps on the kill's own family (got ${capHit?.kind === "cap-hit" ? capHit.cap : "none"})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Invariant: a corrective that COMPLETES but leaves the spec uncovered still
  // caps as plan-spec-mismatch — the kill carve-out must not have disabled the
  // gate for the case it was built for (#818).
  const dir = mkdtempSync(path.join(tmpdir(), "plan-corrective-mismatch-"));
  try {
    const ctx = mkCtx(dir, async (_pi, _spec, opts) =>
      (opts as { label?: string })?.label === "plan:corrective"
        ? mkResult(WORKSTREAMS) // src/a.ts — does not cover src/required.ts
        : mkResult(TRIGGER_PLAN),
    );
    const next = await runPlan(ctx, stateWithSpec(initialState(819, 1_000_000)), 1_000_000);
    const capHit = next.eventLog.slice().reverse().find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "plan-spec-mismatch",
      "invariant: a completed corrective that misses the spec still caps as plan-spec-mismatch",
    );
    assert(
      next.pipelineState.planQuality?.reason === "plan-spec-mismatch",
      "invariant: that halt also records planQuality.reason",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------- 2. the cap writes reason + bounded evidence

{
  const mismatch: PlanSpecMismatch = {
    kind: "uncovered-deliverables",
    evidence: `no workstream declares: ${Array.from(
      { length: 40 },
      (_, i) => `d${i} (src/${"x".repeat(80)}.ts)`,
    ).join("; ")}`,
    uncovered: [{ id: "d1", paths: ["src/required.ts"] }],
  };
  const capped = planSpecMismatchCap(
    initialState(819, 1_000_000),
    mismatch,
    "this is the one-shot corrective plan",
  );
  const hit = capped.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    hit?.kind === "cap-hit" && hit.cap === "plan-spec-mismatch",
    "planSpecMismatchCap emits the plan-spec-mismatch cap-hit",
  );
  assert(
    hit?.kind === "cap-hit" && (hit.evidence ?? "").length <= 500,
    `planSpecMismatchCap caps the persisted evidence at 500 chars (got ${hit?.kind === "cap-hit" ? (hit.evidence ?? "").length : "n/a"})`,
  );
  assert(
    capped.pipelineState.planQuality?.reason === "plan-spec-mismatch",
    "planSpecMismatchCap also writes pipelineState.planQuality.reason (the cap alone left it absent)",
  );
  assert(
    capped.pipelineState.planQuality?.redispatched === false &&
      capped.pipelineState.planQuality?.findingsCount === 0,
    "planSpecMismatchCap fills the planQuality fields the step had not set",
  );
  const carried = planSpecMismatchCap(
    {
      ...initialState(819, 1_000_000),
      pipelineState: {
        ...initialState(819, 1_000_000).pipelineState,
        planQuality: { findingsCount: 6, redispatched: true },
      },
    },
    mismatch,
    "x",
  );
  assert(
    carried.pipelineState.planQuality?.findingsCount === 6 &&
      carried.pipelineState.planQuality?.redispatched === true &&
      carried.pipelineState.planQuality?.reason === "plan-spec-mismatch",
    "planSpecMismatchCap does not clobber findingsCount/redispatched when writing the reason",
  );
}

// ------------------------------- 3. the recovery lines are actually runnable

{
  const state: WorkState = {
    ...initialState(337, 1),
    pipelineState: {
      ...initialState(337, 1).pipelineState,
      status: "handoff",
      currentStep: "handoff",
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 1,
        cap: "plan-spec-mismatch",
        reviewRound: 0,
        nextStep: "handoff",
        evidence: "no workstream declares src/required.ts",
      },
    ],
  };
  const gh = recoveryStepsForCap(state, "github")
    .steps.flatMap((s) => s.lines);
  const gl = recoveryStepsForCap(state, "gitlab")
    .steps.flatMap((s) => s.lines);

  assert(
    !gl.some((l) => l.includes("glab issue edit")),
    "gitlab recovery: no `glab issue edit` (glab has no such subcommand)",
  );
  assert(
    gl.some((l) => l.includes("glab api -X PUT") && l.includes("projects/:id/issues/337")),
    "gitlab recovery: the issue edit goes through `glab api -X PUT projects/:id/issues/<N>`",
  );
  assert(
    !gh.some((l) => /^\s*PI_ENSEMBLE_PLAN_QUALITY=0\s+\/work/.test(l)),
    "github recovery: no `VAR=0 /work …` line (a shell prefix in front of a slash command is not a command)",
  );
  assert(
    gh.some((l) => l.startsWith("#") && l.includes("PI_ENSEMBLE_PLAN_QUALITY=0")),
    "github recovery: the env var is a # comment telling the operator to set it in the pi process",
  );
  assert(
    gh.some((l) => l === "/work 337 --restart"),
    "github recovery: the restart is its own runnable line",
  );
  assert(
    gl.some((l) => l.startsWith("#") && l.includes("PI_ENSEMBLE_PLAN_QUALITY=0")),
    "gitlab recovery: same split (the comment is forge-independent)",
  );
}

console.log(exit === 0 ? "\nAll #819 round-2 assertions passed." : "\nFAILURES above.");
process.exit(exit);
