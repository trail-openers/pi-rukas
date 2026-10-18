#!/usr/bin/env bun
/**
 * #754 / #819 round-2 — the plan step's CORRECTIVE dispatch, in its own file.
 *
 * Split out of test-plan-timeout-bound.ts for the AGENTS.md §12 500-line gate:
 * the #819 round-2 assertions (a killed corrective must route as a kill, not be
 * judged as a plan) pushed the parent past the cap. The parent keeps the bound
 * itself (30-min default, env override, primary-only) and the happy-path kill;
 * everything that exercises what the CORRECTIVE does or fails to do lives here.
 *
 * What the round fixed, and what would silently regress without these:
 *
 *  A corrective dispatch that was KILLED (backstop timeout, loop detector,
 *  token budget, abort) or that THREW used to produce no failure event that
 *  survived. `planTimeoutCorrective` appends the corrective's `dispatch-failed`
 *  to the state it returns and reports `ok: false`; `runPlan`'s
 *  `if (recovered.ok)` then discarded that state — so the step ended on a
 *  `step-completed` with an empty workstream map, the router saw no failure,
 *  and the cycle walked into branch. The quality-gate corrective had the mirror
 *  defect: its reply went straight to the plan-to-spec gate, which read a dead
 *  child's empty text and capped the cycle as `plan-spec-mismatch` — a finding
 *  about a silence the driver caused. "Silence is not a wrong plan" (#378) is
 *  the rule both halves now honour.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SPAWN_BACKSTOP_MS } from "../src/spawn-support.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { planDispatchTimeoutMs, runPlan } from "../src/work-driver-plan.ts";
import { routeStepOutcome } from "../src/work-driver-step-router.ts";
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

/** One workstream, NO paths → `planQualityReason` returns `empty-paths`, which
 * is the trigger that dispatches the quality-gate corrective. */
const SHAPE_DEFECT_PLAN = [
  "## Workstreams",
  "",
  "### task-a — the fix",
  "- out-of-scope: docs/",
  "",
].join("\n");

const WORKSTREAMS = ["## Workstreams", "", "### task-a — the fix", "- paths: src/a.ts", ""].join(
  "\n",
);

function mkCtx(dir: string, dispatchFn?: DriverContext["dispatchFn"]): DriverContext {
  return { host: fakePi, repoRoot: dir, issue: 754, dispatchFn };
}

// --------------------------------- the corrective dispatch is NOT bounded

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-bound-corrective-"));
  try {
    const seen: Array<{ label?: string; timeoutMs?: number; prompt?: string }> = [];
    const ctx = mkCtx(dir, async (_pi, spec, opts) => {
      seen.push({ ...opts, prompt: spec.prompt });
      // First call: the primary kill. Second: the corrective, which succeeds.
      return seen.length === 1 ? primaryKill() : mkResult(WORKSTREAMS);
    });
    const next = await runPlan(ctx, initialState(754, 1_000_000), 1_000_000);
    assert(seen.length === 2, "a primary kill produces exactly one corrective re-dispatch");
    assert(seen[0]?.timeoutMs === planDispatchTimeoutMs(), "primary carries the bound");
    assert(
      seen[1]?.timeoutMs === undefined,
      "the corrective (label plan:corrective) is NOT bounded — it is the recovery path",
    );
    assert(seen[1]?.label === "plan:corrective", "the unbounded dispatch is the corrective");
    // #754 — the timeout corrective carries the timeout steer, NOT the
    // under-decomposed steer: a timeout says nothing about decomposition, and
    // steering a killed planner toward MORE workstreams is the forced-split
    // pressure that produced the wrong-work shape #819.
    const correctivePrompt = seen[1]?.prompt ?? "";
    assert(
      correctivePrompt.includes("exceeded its wall-clock bound") ||
        correctivePrompt.includes("Corrective re-dispatch (plan timeout)"),
      "the corrective prompt carries the timeout steer (exceeded its wall-clock bound)",
    );
    assert(
      !correctivePrompt.includes("That is under-decomposed"),
      "the corrective prompt does NOT carry the under-decomposed steer",
    );
    const killed = next.eventLog.find((e) => e.kind === "dispatch-failed" && e.label === "plan");
    assert(
      killed?.kind === "dispatch-failed" && killed.killCause === "plan-timeout",
      "the primary kill event carries the plan-specific cause, not a generic timeout",
    );
    assert(
      killed?.usage?.turns === 266,
      "turn count rides the KILL event (decision 2: a killed dispatch never emits dispatch-completed)",
    );
    assert(
      (killed?.errorTail ?? "").includes("PI_ENSEMBLE_PLAN_TIMEOUT_MS"),
      "the kill event names the env knob that bounded it",
    );
    assert(
      Object.keys(next.pipelineState.workstreams ?? {}).length === 1,
      "the corrective's workstreams are adopted (the 37-second run's shape)",
    );
    assert(
      next.eventLog.filter((e) => e.kind === "dispatch-failed").length === 1,
      "a successful corrective leaves exactly the primary's kill on record — no second failure, no loop",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The primary plan dispatch timed out at the step's own bound. */
function primaryKill(): DispatchResult {
  return mkResult("", {
    ok: false,
    exitCode: 143,
    killCause: "timeout",
    killBudgetMs: 30 * 60_000,
    usage: {
      input: 100,
      output: 200,
      cacheRead: 38_000_000,
      cacheWrite: 5,
      cost: 1.2,
      turns: 266,
    },
  });
}

// ---------------- a corrective whose dispatch THREW still leaves a tail

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-corrective-throws-"));
  try {
    const seen: Array<{ label?: string; timeoutMs?: number }> = [];
    // PRIMARY: an EMPTY reply — no `## Workstreams` block, so the parse is
    // empty, no gate fires and there is no plan to compare. The corrective then
    // THROWS (the `.catch()` yields undefined): the pre-round-2 shape left the
    // step with no failure tail at all.
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push(opts);
      if (seen.length === 1) return primaryKill();
      throw new Error("corrective dispatch exploded");
    });
    const next = await runPlan(ctx, initialState(754, 1_000_000), 1_000_000);
    const threw = next.eventLog.find(
      (e) => e.kind === "dispatch-failed" && e.label === "plan:corrective",
    );
    assert(
      threw?.kind === "dispatch-failed",
      "#819 round-2: a corrective whose dispatch THREW still leaves a dispatch-failed tail (the returned state is adopted even when ok:false)",
    );
    assert(
      next.eventLog.filter((e) => e.kind === "cap-hit" && e.cap === "plan-spec-mismatch").length ===
        0,
      "a throwing corrective is never capped as plan-spec-mismatch",
    );
    // #819 round-2 — the corrective's failure is the LAST event: the plan step
    // ends on the failure itself (the `step-completed` a healthy plan gets is
    // emitted by the driver's `runSingleDispatch`, not by `runPlan`, which
    // returns the state and lets the router route). So `failureEventOf` reads
    // the corrective's event as the tail — the pre-round-2 state had no such
    // event at all, and the router saw no failure and moved on to `branch`
    // with an empty workstream map. That regression is what this pins.
    const last = next.eventLog[next.eventLog.length - 1];
    assert(
      last?.kind === "dispatch-failed" && last.label === "plan:corrective",
      "the corrective's dispatch-failed is the step's tail (the returned state is adopted even when ok:false)",
    );
    // The #308 transient-retry budget must be SPENT, so the router reaches the
    // HALT cap instead of asking for another attempt — the same fixture shape
    // test-plan-timeout-bound.ts uses for its router assertions.
    const attempts: Record<string, number> = {};
    attempts.plan = 5;
    const routed = await routeStepOutcome(
      mkCtx(dir, undefined),
      {
        ...next,
        pipelineState: { ...next.pipelineState, transientRetryAttempts: attempts },
      },
      "plan",
      { num: 2, total: 9 },
      1,
      Date.now() - 100,
    );
    const capHit = routed.state.eventLog.slice().reverse().find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:plan",
      "a throwing corrective halts the plan step via the router (not a silent success into branch)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------- a corrective kill leaves the plan-timeout tail

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-bound-norecover-"));
  try {
    const seen: Array<{ label?: string; timeoutMs?: number }> = [];
    // The PRIMARY has a shape defect (so the quality-gate corrective runs) and
    // the CORRECTIVE is killed by the global backstop. This is the exact shape
    // #819 round-2 fixed: the killed corrective used to reach the plan-to-spec
    // gate, whose verdict on a killed child's empty text was `plan-spec-mismatch`.
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push(opts);
      if (seen.length === 2) {
        return mkResult("", {
          ok: false,
          exitCode: 143,
          killCause: "timeout",
          killBudgetMs: SPAWN_BACKSTOP_MS,
        });
      }
      return mkResult(SHAPE_DEFECT_PLAN);
    });
    const next = await runPlan(ctx, initialState(754, 1_000_000), 1_000_000);
    assert(seen.length === 2, "a failed corrective is never re-dispatched — exactly one per cycle");
    assert(
      seen[1]?.timeoutMs === undefined,
      "the corrective rides the global backstop, not the tight plan bound",
    );
    const correctiveFail = next.eventLog
      .slice()
      .reverse()
      .find((e) => e.kind === "dispatch-failed" && e.label === "plan:corrective");
    assert(
      correctiveFail?.kind === "dispatch-failed" &&
        correctiveFail.killCause === "timeout" &&
        correctiveFail.errorTail?.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS"),
      "#819 round-2: a corrective killed by the GLOBAL backstop is recorded as a timeout kill naming the knob that killed it (the plan-specific rewrite is reserved for the primary)",
    );
    assert(
      next.eventLog.filter((e) => e.kind === "cap-hit" && e.cap === "plan-spec-mismatch").length ===
        0,
      "#819 round-2: a killed corrective is NOT judged as plan-spec-mismatch (a killed child produced no plan)",
    );

    // The router now sees the corrective's kill as the tail (it used to be
    // discarded), so the halt is attributed to the failure that happened.
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
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:plan",
      "a corrective-stage kill tail still halts the plan step via the router",
    );
    assert(routed.retry === true, "the routed cap re-enters the loop for handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll plan-corrective assertions passed." : "\nFAILURES above.");
process.exit(exit);
