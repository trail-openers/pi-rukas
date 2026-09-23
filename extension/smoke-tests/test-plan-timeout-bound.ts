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
 *  2. The corrective re-dispatch is NOT bounded (decision 1: it is the
 *     recovery path; bounding it could kill the 37-second corrective).
 *  3. A primary timeout kill is routed to ONE corrective re-dispatch, the
 *     kill event carries the plan-specific cause + usage (turns), and the
 *     corrective's workstreams are adopted.
 *  4. When the corrective does not recover, the step ends on a
 *     dispatch-failed with `plan-timeout`, which the step router maps to
 *     the `plan-timeout` cap (named plan step, not generic), and
 *     explainCap renders an operator sentence naming the step, the bound
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
    pi: fakePi,
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
    if (v === undefined) process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = undefined;
    else process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = v;
    try {
      return fn();
    } finally {
      if (prev === undefined) process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = undefined;
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
      process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS = undefined;
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
    // under-decomposed steer: a timeout says nothing about decomposition,
    // and steering a killed planner toward MORE workstreams is the forced-split
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

// --------------------------- a corrective kill leaves the plan-timeout tail

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-bound-norecover-"));
  try {
    const seen: Array<{ label?: string; timeoutMs?: number }> = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push(opts);
      // Both the primary AND the corrective time out — the corrective is the
      // one dispatch that is never re-dispatched again (decision 1).
      return mkResult("", {
        ok: false,
        exitCode: 143,
        killCause: "timeout",
        killBudgetMs: SPAWN_BACKSTOP_MS,
      });
    });
    const next = await runPlan(ctx, initialState(754, 1_000_000), 1_000_000);
    assert(seen.length === 2, "a failed corrective is never re-dispatched — exactly one per cycle");
    assert(
      seen[1]?.timeoutMs === undefined,
      "the corrective rides the global backstop, not the tight plan bound",
    );
    // The corrective's own timeout keeps the generic cause — the plan-specific
    // rewrite is reserved for the primary (the step router keys the cap on the
    // TAIL, which is the corrective's failure).
    const correctiveFail = next.eventLog.find(
      (e) => e.kind === "dispatch-failed" && e.label === "plan:corrective",
    );
    assert(
      correctiveFail?.kind === "dispatch-failed" &&
        correctiveFail.killCause === "timeout" &&
        (correctiveFail.killBudgetMs === SPAWN_BACKSTOP_MS ||
          correctiveFail.killBudgetMs === undefined),
      "a corrective that exceeds the GLOBAL backstop is recorded as a generic timeout kill (the plan-specific rewrite is reserved for the primary)",
    );

    // The step router: plan + tail dispatch-failed (generic timeout, the
    // corrective's) → the plan step halts via the router. The corrective
    // deliberately rides the global backstop, so its kill keeps the generic
    // cause — the router's plan-timeout special case fires only when the
    // step's OWN bound expired on the tail.
    const routed = await routeStepOutcome(
      mkCtx(dir, undefined),
      next,
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
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:plan",
      "a corrective-stage tail (generic timeout) still halts the plan step via the router",
    );
    assert(routed.retry === true, "the routed cap re-enters the loop for handoff");
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
      "plan + plan-timeout kill → cap 'plan-timeout' (named plan step, mirroring developer-timeout)",
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
      "explainCap: no 'split the work' developer-timeout wording leaks in",
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
