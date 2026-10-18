#!/usr/bin/env bun
/**
 * #754 — the plan step's own wall-clock bound.
 *
 * Incident: a /work cycle's primary plan dispatch ran to the full 2-hour
 * global spawn backstop — 266 turns, ~38 MB of cache reads, 120 of the
 * cycle's 140 minutes — for a four-file change whose corrective re-plan
 * then produced the identical decomposition in 37 s. Nothing bounded the
 * planner short of the absolute backstop, and the operator saw no signal
 * that planning had stopped converging.
 *
 * This test is fully offline: `runPlan` takes an injected `dispatchFn`,
 * `beginDispatch`/`writeState` no-op under `PI_ENSEMBLE_RESUME=0`, and the
 * path-claim registry is an empty file in a tmp dir. No real provider, no
 * live spawn, no wall-clock hazard.
 *
 * What it pins:
 *  1. The PRIMARY plan dispatch receives `timeoutMs` — the 30-min default
 *     and the PI_ENSEMBLE_PLAN_TIMEOUT_MS override (the same bound the
 *     compiled /plan pipeline adopts via PLAN_DISPATCH_TIMEOUT_MS).
 *  2/3 (the corrective dispatch itself — its bound, its steer, whether its
 *     kill survives) moved to test-plan-corrective-dispatch.ts for the §12
 *     line cap. This file keeps the bound's arithmetic and the ROUTER side of
 *     the kill: a plan-timeout tail → the `plan-timeout` cap, and explainCap's
 *     operator sentence.
 *  4. explainCap renders an operator sentence naming the step, the bound
 *     and the turn count — without blaming the issue.
 *  5. The global backstop is untouched: the plan bound is a separate knob,
 *     shorter than the 2 h backstop, and develop's dispatch is not given
 *     the tighter number.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeOutcome } from "../src/async-jobs-report.ts";
import { killDetail } from "../src/kill-detail.ts";
import { SPAWN_BACKSTOP_MS } from "../src/spawn-support.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { classifyFailureCause, failureCauseReason } from "../src/work-driver-failure-taxonomy.ts";
import { planDispatchTimeoutMs, runPlan } from "../src/work-driver-plan.ts";
import { routeStepOutcome } from "../src/work-driver-step-router.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The offline suite must never pay for resume bookkeeping or the gh calls
// the path-claim registry would make.
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

const WORKSTREAMS = ["## Workstreams", "", "### task-a — the fix", "- paths: src/a.ts", ""].join(
  "\n",
);

/** The primary plan dispatch timed out (killCause "timeout", no text — a
 * killed child returns a report, never structured output). */
function primaryKill(): DispatchResult {
  return mkResult("", {
    ok: false,
    exitCode: 143,
    killCause: "timeout",
    killBudgetMs: 30 * 60_000,
    usage: { input: 100, output: 200, cacheRead: 38_000_000, cacheWrite: 5, cost: 1.2, turns: 266 },
  });
}

/** A healthy primary reply (the invariant half of the bound). */
function primaryOk(): DispatchResult {
  return mkResult(WORKSTREAMS);
}

function mkCtx(dir: string, dispatchFn: DriverContext["dispatchFn"]): DriverContext {
  return {
    host: fakePi,
    repoRoot: dir,
    issue: 754,
    dispatchFn,
  };
}

function stateWithWorkstream(state: WorkState): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      workstreams: { a: { id: "a", scope: "s", paths: ["src/a.ts"], outOfScope: [] } },
    },
  };
}

// ---------------------------------------------------------------- the bound

{
  const withEnv = <T>(v: string | undefined, fn: () => T): T => {
    const prev = process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS;
    if (v === undefined) delete process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS;
    else process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = v;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS;
      else process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = prev;
    }
  };

  assert(
    withEnv(undefined, () => planDispatchTimeoutMs()) === 30 * 60_000,
    "default plan bound is 30 min (the bound the compiled /plan pipeline already adopts)",
  );
  assert(
    withEnv("900000", () => planDispatchTimeoutMs()) === 900_000,
    "PI_ENSEMBLE_PLAN_TIMEOUT_MS overrides the default",
  );
  assert(
    withEnv("junk", () => planDispatchTimeoutMs()) === 30 * 60_000,
    "a garbage override falls back to the default, not NaN",
  );
  assert(
    planDispatchTimeoutMs() < SPAWN_BACKSTOP_MS,
    "the plan bound is shorter than the 2 h global backstop — the point of the ticket",
  );
}

// ---------------------------------------------- the primary dispatch bound

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-bound-primary-"));
  try {
    let primaryOpts: { label?: string; timeoutMs?: number } | undefined;
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      primaryOpts = opts;
      return primaryOk();
    });
    await runPlan(ctx, initialState(754, 1_000_000), 1_000_000);
    assert(
      primaryOpts?.timeoutMs === planDispatchTimeoutMs(),
      "the PRIMARY plan dispatch receives the bounded timeoutMs (default)",
    );
    assert(primaryOpts?.label === "plan", "the bounded dispatch is the primary (label 'plan')");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Env override flows into the dispatch opts.
  const dir = mkdtempSync(path.join(tmpdir(), "plan-bound-env-"));
  try {
    let primaryOpts: { timeoutMs?: number } | undefined;
    process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = "900000";
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      primaryOpts = opts;
      return primaryOk();
    });
    try {
      await runPlan(ctx, initialState(754, 1_000_000), 1_000_000);
      assert(
        primaryOpts?.timeoutMs === 900_000,
        "the env override reaches the primary dispatch (PI_ENSEMBLE_PLAN_TIMEOUT_MS=900000)",
      );
    } finally {
      delete process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------ a healthy plan is not disturbed

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-bound-fast-"));
  try {
    let calls = 0;
    const ctx = mkCtx(dir, async () => {
      calls += 1;
      return primaryOk();
    });
    const next = await runPlan(ctx, initialState(754, 1_000_000), 1_000_000);
    assert(calls === 1, "invariant: a plan under the bound is exactly one dispatch");
    assert(
      !next.eventLog.some((e) => e.kind === "dispatch-failed"),
      "invariant: a plan under the bound records no failure",
    );
    assert(
      Object.keys(next.pipelineState.workstreams ?? {}).length === 1,
      "invariant: a plan under the bound still yields its workstreams",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------- a primary plan-timeout kill routes to the cap

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-cap-route-"));
  try {
    // Direct fixture of the router's input: a plan step whose TAIL is a
    // dispatch-failed carrying the plan-specific cause (the shape runPlan
    // leaves when its one-shot corrective never produced a dispatch-failed
    // of its own — e.g. the corrective dispatch threw, so only the
    // primary's rewritten kill is on record).
    let s = stateWithWorkstream(initialState(754, 1_000_000));
    s = appendEvent(s, {
      kind: "step-started",
      step: "plan",
      at: 1_000_000,
    });
    s = appendEvent(s, {
      kind: "dispatch-failed",
      step: "plan",
      role: "explore",
      jobId: "job-plan-kill",
      label: "plan",
      ms: 30 * 60_000,
      at: 1_000_000 + 30 * 60_000,
      exitCode: 143,
      killCause: "plan-timeout",
      usage: {
        input: 100,
        output: 200,
        cacheRead: 38_000_000,
        cacheWrite: 5,
        cost: 1.2,
        turns: 266,
      },
    });
    const routed = await routeStepOutcome(
      mkCtx(dir, undefined),
      s,
      "plan",
      { num: 2, total: 9 },
      1,
      Date.now() - 100,
    );
    const capHit = routed.state.eventLog
      .slice()
      .reverse()
      .find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "plan-timeout",
      "plan + plan-timeout kill → cap 'plan-timeout' (named plan step, mirroring the develop backstop's spawn-backstop)",
    );

    // The taxonomy: an explicit no-retry branch — the crashed fallback's
    // shouldRetry:true must not apply to a budget kill.
    const cls = classifyFailureCause({
      kind: "dispatch-failed",
      killCause: "plan-timeout",
    });
    assert(cls.cause === "self-killed:plan-timeout", "taxonomy: explicit plan-timeout cause");
    assert(
      cls.shouldRetry === false && cls.maxRetries === 0,
      "taxonomy: a budget kill is never retried wholesale (the corrective is the retry)",
    );
    assert(
      failureCauseReason({ kind: "dispatch-failed", killCause: "plan-timeout" }).includes(
        "plan step's own",
      ),
      "taxonomy: the reason string names the plan step's bound",
    );

    // Operator-facing: explainCap names the step, the bound and the turn
    // count — and does not present the failure as a property of the issue.
    const explained = explainCap("plan-timeout", routed.state);
    assert(explained.includes("PI_ENSEMBLE_PLAN_TIMEOUT_MS"), "explainCap: names the bound's knob");
    assert(
      explained.includes("266"),
      "explainCap: names the turn count from the kill event's usage",
    );
    assert(/plan step's own wall-clock bound/i.test(explained), "explainCap: names the step");
    assert(
      /not on the issue|bound on planning/i.test(explained),
      "explainCap: does not present the failure as a property of the issue",
    );
    assert(
      !/issue.*(too large|needs splitting)/i.test(explained),
      "explainCap: no 'split the work' backstop wording leaks in",
    );

    // The kill-detail block the handoff renderers print.
    const lines = killDetail(routed.state).join("\n");
    assert(
      lines.includes("plan-timeout") || lines.includes("PI_ENSEMBLE_PLAN_TIMEOUT_MS"),
      "killDetail: the WHY entry for the plan bound renders (no undefined)",
    );
    assert(
      lines.includes("planning, not on the issue"),
      "killDetail: the bound is on planning, not the issue",
    );

    // The dispatch report headline is distinct from the generic timeout.
    const report = describeOutcome({
      role: "explore",
      ok: false,
      text: "",
      toolUses: [],
      ms: 30 * 60_000,
      exitCode: 143,
      killCause: "plan-timeout",
      killBudgetMs: 30 * 60_000,
    });
    assert(
      report.status.includes("plan-step") && !report.status.includes("wall-clock timeout), 120s"),
      "dispatch report: the plan-bound kill has its own headline",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------- the global backstop is unchanged

{
  assert(
    SPAWN_BACKSTOP_MS === 2 * 60 * 60_000,
    "invariant: SPAWN_BACKSTOP_MS is still 2 h (no step's bound was lowered)",
  );
  const { readFileSync } = await import("node:fs");
  const developSrc = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-driver-branch-develop.ts"),
    "utf8",
  );
  const developRunSrc = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-develop-run.ts"),
    "utf8",
  );
  assert(
    !developSrc.includes("planDispatchTimeoutMs") &&
      !developRunSrc.includes("planDispatchTimeoutMs"),
    "invariant: develop's dispatch does not pick up the tighter plan bound",
  );
}

console.log(exit === 0 ? "\nAll plan-timeout-bound assertions passed." : "\nFAILURES above.");
process.exit(exit);
