#!/usr/bin/env bun
/**
 * #819 round-3 — the plan step's failure accounting, and the halt that must
 * survive it.
 *
 * The findings this pins, in the order they appear below:
 *
 * 1. **One `dispatch-failed` per corrective kill.** A quality-gate corrective
 *    went through `buildCompletionEvent` (which turns any `killCause` into its
 *    own `dispatch-failed`) AND `planKillFailureEvent`, so a killed corrective
 *    left TWO failure events with the same `label` — two plausible tails for
 *    the router. The kill check now runs before any append, and returns.
 * 2. **`planKillDetail` cannot be handed an uncaused result.** Its `default`
 *    branch interpolated `${result.killCause}`, so an uncaused result read
 *    `"killed after undefinedms undefined"`; the parameter type now makes that
 *    shape unrepresentable.
 * 3. **A failed corrective ends the step.** `runPlan` fell through to the
 *    gates, the cross-group claims and the synthetic `default` workstream, so a
 *    cycle whose only honest tail was the corrective's `dispatch-failed` still
 *    advertised a workstream for develop to build.
 * 4. **A `plan-spec-mismatch` halt persists `planQuality.reason`** — the halt
 *    paths return before the tail's fresh `planQuality`, the tail preserves the
 *    field, and a primary the spec gate refused halts rather than continuing.
 * 5. **`measurable()` has no unreachable clause** and its docblock describes
 *    the code that exists.
 * 7. **Evidence truncation keeps the WHY.** The 500-char cap applied to
 *    `evidence + whyNotReplanned` together, so on a wide spec the clause
 *    explaining why the cycle stopped was what fell off the end.
 *
 * Offline: `runPlan` with an injected `dispatchFn`; `PI_ENSEMBLE_RESUME=0`
 * no-ops the resume bookkeeping, the claim registry is off, `verifyExecFn`
 * stubs the coupling merge's grep. No provider, no git, no wall clock.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { planKillDetailForTest, planSpecMismatchCap } from "../src/work-driver-plan-helpers.ts";
import { findUncoveredDeliverables } from "../src/work-driver-plan-spec-coverage.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import {
  type PlanResultShape,
  planResultFromCalls,
  planResultFromRawCalls,
} from "./lib/plan-workstream-calls.ts";

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
// #819 round-3 — the coupling fold joins any workstream that declares a
// depends-on edge into its dependency. These fixtures declare dropped edges on
// purpose (they drive the #849 path), so the contract pass is off here; the
// stub `verifyExecFn` already silences rule 3's grep.
process.env.PI_ENSEMBLE_PLAN_CONTRACT = "0";

const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

/** A dispatch result carrying a plan's report_workstream calls (#1652). */
function mkResult(plan: PlanResultShape, patch: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    ...plan,
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-plan-transcript.json",
    ...patch,
  };
}

/** Two workstreams, the second with NO paths → `planQualityReason` returns
 * `empty-paths`: the trigger that dispatches the quality-gate corrective. */
const TRIGGER_PLAN = planResultFromCalls([
  { id: "task-a", scope: "the fix", paths: ["src/a.ts"], outOfScope: [] },
  { id: "task-b", scope: "the stub", paths: [], outOfScope: ["docs/"] },
]);

/** One workstream with paths: a clean plan the gates have no reason to reject. */
const CLEAN_PLAN = planResultFromCalls([
  { id: "default", scope: "the fix", paths: ["src/a.ts"], outOfScope: [] },
]);

/** A spec whose single deliverable neither plan above covers, so the
 * plan-to-spec gate has a real mismatch to act on. */
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

function mkCtx(dir: string, dispatchFn?: DriverContext["dispatchFn"]): DriverContext {
  return {
    host: fakePi,
    repoRoot: dir,
    issue: 819,
    dispatchFn,
    verifyExecFn: (async () => ({
      stdout: "",
      code: 0,
    })) as unknown as DriverContext["verifyExecFn"],
  };
}

const KILL_CAUSES = ["timeout", "loop", "token-budget", "abort", "inactivity"] as const;

/** A primary that misses the spec (src/other.ts) and carries a duplicate-id
 * refusal; no shape defect, so no corrective is spent on it. */
const REFUSED_PRIMARY_PLAN = planResultFromRawCalls([
  {
    id: "task-a",
    args: { id: "task-a", scope: "the fix", paths: ["src/other.ts"], outOfScope: [] },
  },
  { id: "task-a", args: { id: "task-a", scope: "dup", paths: ["src/other.ts"], outOfScope: [] } },
]);

/** A corrective that declares the spec's deliverable, so `correctiveMismatch`
 * stays silent and the flow reaches the tail with the PRIMARY's refusal. */
const COVERING_PLAN = planResultFromCalls([
  { id: "default", scope: "the fix", paths: ["src/required.ts"], outOfScope: [] },
]);

function killed(cause: (typeof KILL_CAUSES)[number]): DispatchResult {
  return mkResult(planResultFromCalls([]), {
    ok: false,
    exitCode: 143,
    killCause: cause,
    killBudgetMs: cause === "timeout" ? 2 * 60 * 60_000 : 30 * 60_000,
    usage: { input: 10, output: 20, cacheRead: 100, cacheWrite: 0, cost: 0.1, turns: 12 },
  });
}

// ------------- 1. a killed quality-gate corrective appends EXACTLY ONE event

for (const cause of KILL_CAUSES) {
  const dir = mkdtempSync(path.join(tmpdir(), `plan-r3-single-${cause}-`));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      // Primary: a plan with a shape defect → the quality gate dispatches the
      // corrective. Corrective: KILLED by one of the driver's own caps.
      return seen.length === 1 ? mkResult(TRIGGER_PLAN) : killed(cause);
    });
    const next = await runPlan(ctx, initialState(819, 1_000_000), 1_000_000);
    const failures = next.eventLog.filter(
      (e) => e.kind === "dispatch-failed" && e.label === "plan:corrective",
    );
    assert(
      seen.length === 2 && seen[1] === "plan:corrective",
      `(${cause}) the corrective dispatched exactly once`,
    );
    assert(
      failures.length === 1,
      `(${cause}) exactly ONE dispatch-failed carries label plan:corrective (got ${failures.length})`,
    );
    assert(
      failures[0]?.kind === "dispatch-failed" && failures[0].killCause === cause,
      `(${cause}) that one event carries the structured kill cause`,
    );
    assert(
      next.eventLog[next.eventLog.length - 1]?.kind === "dispatch-failed",
      `(${cause}) the corrective's kill is the step's tail`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------- 2. planKillDetail is typed against an uncaused kill

{
  // The default branch interpolated `${result.killCause}`, so an uncaused result
  // read "killed after undefinedms undefined". The parameter is now narrowed, so
  // the prose is only reachable with a cause — and must name cause and bound.
  const caused = mkResult(planResultFromCalls([]), {
    killCause: "inactivity",
    killBudgetMs: 60_000,
  });
  const detail = planKillDetailForTest(caused);
  assert(
    detail.includes("inactivity") && detail.includes("60000ms"),
    `planKillDetail names the cause and the bound (${JSON.stringify(detail.slice(0, 60))})`,
  );
  assert(
    !detail.includes("undefined"),
    "planKillDetail never renders the literal `undefined` (the uncaused shape is unrepresentable)",
  );
  const loop = planKillDetailForTest(
    mkResult(planResultFromCalls([]), {
      killCause: "loop",
      loopEvidence: { kind: "repeat", tool: "bash", count: 9 },
    }),
  );
  assert(
    loop.includes("bash") && loop.includes("9"),
    "a loop kill names the tool and the streak count",
  );
}

// ------- 3. a corrective that failed ends the step: no gates, no claims, no default

for (const mode of ["killed", "threw"] as const) {
  const dir = mkdtempSync(path.join(tmpdir(), `plan-r3-early-${mode}-`));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      if (seen.length === 1) return mkResult(TRIGGER_PLAN);
      if (mode === "threw") throw new Error("corrective exploded");
      return killed("loop");
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(819, 1_000_000)), 1_000_000);
    const last = next.eventLog[next.eventLog.length - 1];
    assert(
      last?.kind === "dispatch-failed" && last.label === "plan:corrective",
      `(${mode}) the tail is the corrective's own failure`,
    );
    assert(
      next.eventLog.filter((e) => e.kind === "dispatch-failed" && e.label === "plan:corrective")
        .length === 1,
      `(${mode}) and there is exactly one such event`,
    );
    assert(
      !next.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "plan-spec-mismatch"),
      `(${mode}) the plan-to-spec gate never judged the killed primary's text`,
    );
    assert(
      next.pipelineState.workstreams === undefined ||
        Object.keys(next.pipelineState.workstreams).length === 0,
      `(${mode}) no synthetic \`default\` workstream was written (${
        next.pipelineState.workstreams
          ? Object.keys(next.pipelineState.workstreams).join(",")
          : "undefined"
      })`,
    );
    let claims: unknown[] = [];
    try {
      claims = JSON.parse(
        await Bun.file(path.join(dir, ".pi", "work-state", "path-claims.json")).text(),
      );
    } catch {
      claims = [];
    }
    assert(
      claims.length === 0,
      `(${mode}) no cross-group path claim was registered for a plan nobody made`,
    );
    assert(seen.length === 2, `(${mode}) the corrective was still dispatched exactly once`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------- 4. a plan-spec-mismatch halt persists planQuality.reason

{
  // The corrective completes but its plan does not cover the spec: the gate
  // halts. The halt must survive runPlan's final `planQuality` write.
  const dir = mkdtempSync(path.join(tmpdir(), "plan-r3-halt-persist-"));
  try {
    const ctx = mkCtx(dir, async (_pi, _spec, opts) =>
      (opts as { label?: string })?.label === "plan:corrective"
        ? mkResult(CLEAN_PLAN) // src/a.ts — does not cover src/required.ts
        : mkResult(TRIGGER_PLAN),
    );
    const next = await runPlan(ctx, stateWithSpec(initialState(819, 1_000_000)), 1_000_000);
    const hit = next.eventLog
      .slice()
      .reverse()
      .find((e) => e.kind === "cap-hit");
    assert(
      hit?.kind === "cap-hit" && hit.cap === "plan-spec-mismatch",
      "a completed corrective that misses the spec halts with the cap",
    );
    assert(
      next.pipelineState.planQuality?.reason === "plan-spec-mismatch",
      `the halt's reason survives runPlan's final return (got ${next.pipelineState.planQuality?.reason})`,
    );
    assert(
      next.eventLog[next.eventLog.length - 1]?.kind === "cap-hit",
      "the cap-hit is the step's tail — nothing ran after the halt",
    );
    assert(
      next.eventLog.filter((e) => e.kind === "dispatch-failed").length === 0,
      "the halt emits no failure event — a rejected plan is a cap, not a dispatch failure",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // The assertion side: a state that arrives at the tail ALREADY carrying the
  // halt's reason must not be quietly rewritten. Simulated by seeding the state
  // the corrective returns with the reason (the shape a future edit that moved
  // a cap return below the tail would produce).
  const dir = mkdtempSync(path.join(tmpdir(), "plan-r3-halt-assert-"));
  try {
    const ctx = mkCtx(dir, async (_pi, _spec, opts) =>
      (opts as { label?: string })?.label === "plan:corrective"
        ? mkResult(CLEAN_PLAN)
        : mkResult(TRIGGER_PLAN),
    );
    // A state whose planQuality already carries a HALT's reason — the shape a
    // future edit that moved a cap return below the tail would produce. Either the
    // guard THROWS or the flow halts earlier; the tail never drops the reason.
    const seeded = stateWithSpec(initialState(819, 1_000_000));
    seeded.pipelineState.planQuality = {
      findingsCount: 1,
      redispatched: false,
      reason: "plan-spec-mismatch",
    };
    let threw = "";
    let finished: WorkState | undefined;
    try {
      finished = await runPlan(ctx, seeded, 1_000_000);
    } catch (err) {
      threw = (err as Error).message;
    }
    assert(
      threw.includes("plan-spec-mismatch") ||
        finished?.pipelineState.planQuality?.reason === "plan-spec-mismatch",
      `runPlan never loses a halt's reason at the tail (threw=${JSON.stringify(threw.slice(0, 60))}, reason=${finished?.pipelineState.planQuality?.reason})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // The tail's halt: the primary's accepted calls miss the spec and no corrective
  // replaced them, and the primary also carried a refused call (a duplicate id).
  // The refusal is recorded; the tail halts on the spec gate. (Was a
  // two-`## Workstreams`-block reply; that condition is gone by design.)
  const dir = mkdtempSync(path.join(tmpdir(), "plan-r3-primary-refused-"));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      return mkResult(REFUSED_PRIMARY_PLAN);
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(819, 1_000_000)), 1_000_000);
    const hit = next.eventLog
      .slice()
      .reverse()
      .find((e) => e.kind === "cap-hit");
    assert(
      next.eventLog.some((e) => e.kind === "workstream-calls-refused"),
      "the primary's duplicate-id call is recorded as refused",
    );
    assert(
      hit?.kind === "cap-hit" && hit.cap === "plan-spec-mismatch",
      `a refused primary that misses the spec still halts at the tail (got ${hit?.kind === "cap-hit" ? hit.cap : "none"})`,
    );
    assert(
      next.pipelineState.planQuality?.reason === "plan-spec-mismatch",
      "and the halt persists planQuality.reason from runPlan's tail",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------- 5. measurable() has no unreachable branch, and no lies

{
  // `measurable()`'s third clause tested `paths.length === 0` AFTER line 1 had
  // returned for exactly that. Deleting it changes no verdict, so the three
  // #792 shapes are re-asserted here against the two-clause function.
  const ws = (m: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(m).map(([k, paths]) => [k, { paths }])) as Record<
      string,
      { paths: string[] }
    >;
  const honoured = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [
      { id: "d1", paths: ["src/a.ts"] },
      { id: "d2", paths: [], noDiff: true, noDiffEvidence: "settings toggle" },
    ],
  });
  assert(
    honoured.checkedCount === 1 && honoured.uncovered.length === 0,
    "an honoured no-diff deliverable stays excluded (clause 1 covers it — the deleted clause was dead)",
  );
  const contradictory = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/z.ts"], noDiff: true, noDiffEvidence: "because" }],
  });
  assert(
    contradictory.checkedCount === 1 && contradictory.uncovered.length === 1,
    "noDiff + real paths + real evidence is still MEASURABLE — the paths win (what the dead clause pretended to do)",
  );
  const emptyEvidence = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/z.ts"], noDiff: true, noDiffEvidence: "   " }],
  });
  assert(
    emptyEvidence.checkedCount === 1 && emptyEvidence.uncovered.length === 1,
    "a marker with no evidence judges by paths too",
  );
}

// --------------------- 7. the WHY survives the evidence cap, the list does not

{
  const longEvidence = `no workstream declares: ${Array.from(
    { length: 60 },
    (_, i) => `d${i} (src/${"x".repeat(40)}_${i}.ts)`,
  ).join("; ")}`;
  const mismatch = {
    kind: "uncovered-deliverables" as const,
    evidence: longEvidence,
    uncovered: [{ id: "d1", paths: ["src/required.ts"] }],
  };
  const why =
    "this is the one-shot corrective plan — it was not re-dispatched and develop never ran";
  const capped = planSpecMismatchCap(initialState(819, 1_000_000), mismatch, why);
  const hit = capped.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    hit?.kind === "cap-hit" && (hit.evidence ?? "").length <= 500,
    `evidence stays within the 500-char cap (got ${hit?.kind === "cap-hit" ? (hit.evidence ?? "").length : "n/a"})`,
  );
  assert(
    hit?.kind === "cap-hit" && (hit.evidence ?? "").includes("develop never ran"),
    "the whyNotReplanned clause SURVIVES the cap (the old order clipped it away on a wide spec)",
  );
  assert(
    hit?.kind === "cap-hit" && (hit.evidence ?? "").includes("…"),
    "the truncated half is marked with an ellipsis rather than cut mid-word",
  );
  const short = planSpecMismatchCap(
    initialState(819, 1_000_000),
    {
      kind: "uncovered-deliverables",
      evidence: "no workstream declares src/required.ts",
      uncovered: [],
    },
    why,
  );
  const shortHit = short.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    shortHit?.kind === "cap-hit" &&
      (shortHit.evidence ?? "").startsWith("no workstream declares src/required.ts — ") &&
      !(shortHit.evidence ?? "").includes("…"),
    "a short evidence string is passed through verbatim with no ellipsis",
  );
}

console.log(exit === 0 ? "\nAll #819 round-3 plan assertions passed." : "\nFAILURES above.");
process.exit(exit);
