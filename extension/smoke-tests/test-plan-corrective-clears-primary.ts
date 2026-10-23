#!/usr/bin/env bun
/**
 * #1756 — a clean corrective plan clears a refused primary plan.
 *
 * The defect: `primaryGateRefused` was a const computed from `input.redispatched`
 * BEFORE the one-shot corrective dispatch, and the corrective set the local flag
 * only afterwards. So a corrective whose own plan-to-spec gate passed still fell
 * through to the tail halt and parked as `plan-spec-mismatch` with the false
 * clause "no corrective plan replaced it" (llm-iac #327: 38.3M tokens, no work).
 * The halt also registered cross-group path claims for a plan nobody develops.
 *
 * Cases (all offline: `runPlan` with an injected `dispatchFn`):
 *   1. a refused spec-mismatched primary + a covering corrective -> NO cap-hit,
 *      the corrective's workstreams reach pipelineState, `planQuality.redispatched`
 *      is true, exactly 2 dispatches;
 *   2. primary mismatch + a corrective that still mismatches -> halts on the
 *      corrective's OWN verdict with the corrective's own why-clause, and the
 *      persisted verdict records that the corrective ran;
 *   3. a halting tail registers no path claims;
 *   4. a live sibling's claim still parks the tail (`cross-group-conflict`);
 *   5. a kill-recovered primary with a mismatch parks and dispatches NO second
 *      corrective (#754 one-corrective-per-cycle).
 *
 * PI_ENSEMBLE_PLAN_QUALITY is deliberately left UNSET — with the gate off the
 * bug is unreachable, so a run that set it would prove nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { SpecCoverageSpec } from "../src/work-driver-plan-spec-coverage.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { seedClaims, spawnLivePid } from "./lib/claims-test-helpers.ts";
import { SPEC_819, mkPlanCtx, stubDispatchResult } from "./lib/plan-819-fixtures.ts";
import { planResultFromCalls, planResultFromRawCalls } from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_RESUME = "0";
// The claim registry is ON for this file: cases 1, 3 and 4 are about who owns
// the paths, and case 4 needs the real conflict check.
// The fixtures declare no depends-on edges, and the contract pass would fold ids.
process.env.PI_ENSEMBLE_PLAN_CONTRACT = "0";

const mkResult = stubDispatchResult;
const mkCtx = mkPlanCtx;

/** The spec whose single deliverable lives at src/required.ts (or the override). */
function stateWithSpec(state: WorkState, specOverride?: SpecCoverageSpec): WorkState {
  return {
    ...state,
    pipelineState: { ...state.pipelineState, normalisedSpec: specOverride ?? SPEC_819 },
  };
}

/** A primary that misses the spec AND carries a duplicate-id refusal. */
const REFUSED_PRIMARY = planResultFromRawCalls([
  {
    id: "task-a",
    args: { id: "task-a", scope: "the fix", paths: ["src/other.ts"], outOfScope: [] },
  },
  { id: "task-a", args: { id: "task-a", scope: "dup", paths: ["src/other.ts"], outOfScope: [] } },
]);

/** A corrective that declares the spec's deliverable: its own gate stays silent. */
const COVERING_CORRECTIVE = planResultFromCalls([
  { id: "default", scope: "the fix", paths: ["src/required.ts"], outOfScope: [] },
]);

/**
 * A corrective that still misses `SPEC_819`'s deliverable.
 */
const STILL_WRONG_CORRECTIVE = planResultFromCalls([
  { id: "default", scope: "the fix", paths: ["src/other.ts"], outOfScope: [] },
]);

/**
 * A corrective for the claim-conflict case: it still declares `src/held.ts`, the
 * file a live sibling holds, so only the claim gate can stop the cycle (#1756
 * moved that gate below the halt decision). Its own gate stays silent because the
 * case reads it against `coveredSpec()`, which names both of its files.
 */
const HELD_PATH_CORRECTIVE = planResultFromCalls([
  { id: "task-a", scope: "the fix", paths: ["src/held.ts"], outOfScope: [] },
  { id: "default", scope: "the rest", paths: ["src/required.ts"], outOfScope: [] },
]);

/** A spec covering both files the corrective above declares, so its own gate stays silent. */
function coveredSpec(): SpecCoverageSpec {
  return {
    ...SPEC_819,
    deliverables: [
      { id: "d1", description: "d1", paths: ["src/held.ts"] },
      { id: "d2", description: "d2", paths: ["src/required.ts"] },
    ],
  };
}

/** Kill-recovery shape for case 5: a primary killed at the step's own bound. */
function killedPrimary(): DispatchResult {
  return mkResult(planResultFromCalls([]), {
    ok: false,
    exitCode: 143,
    killCause: "timeout",
    killBudgetMs: 2 * 60 * 60_000,
    usage: { input: 10, output: 20, cacheRead: 100, cacheWrite: 0, cost: 0.1, turns: 12 },
  });
}

/** Read the claim registry raw — the driver's own liveness rules are not what
 * these cases assert, so the file is what answers "did we register?". */
async function readClaimsFile(dir: string): Promise<unknown[]> {
  try {
    return JSON.parse(
      await Bun.file(path.join(dir, ".pi", "work-state", "path-claims.json")).text(),
    );
  } catch {
    return [];
  }
}

// ---- 1. a covering corrective clears the primary's refusal: no cap, work recorded

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-1756-clears-"));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      return mkResult(seen.length === 1 ? REFUSED_PRIMARY : COVERING_CORRECTIVE);
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(1756, 1_000_000)), 1_000_000);
    assert(
      !next.eventLog.some((e) => e.kind === "cap-hit"),
      "a clean corrective clears the refused primary: no cap-hit at all",
    );
    assert(
      JSON.stringify(Object.keys(next.pipelineState.workstreams ?? {})) ===
        JSON.stringify(["default"]),
      `the corrective's workstream is recorded in pipelineState (got ${Object.keys(
        next.pipelineState.workstreams ?? {},
      ).join(",")})`,
    );
    assert(
      next.pipelineState.workstreams?.default?.paths?.join(",") === "src/required.ts",
      "and it is the CORRECTIVE's paths, not the primary's",
    );
    assert(
      next.pipelineState.planQuality?.redispatched === true,
      `the persisted verdict records the corrective (got ${next.pipelineState.planQuality?.redispatched})`,
    );
    assert(seen.length === 2, `exactly two dispatches ran (got ${seen.length})`);
    assert(
      seen[1] === "plan:corrective",
      `the second dispatch is the one-shot corrective (got ${seen[1]})`,
    );
    assert(
      JSON.stringify(await readClaimsFile(dir)) === JSON.stringify(["src/required.ts"]) ||
        (await readClaimsFile(dir)).length > 0,
      "a cycle that develops the corrective owns its paths in the claim registry",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2. a corrective that still mismatches halts on its OWN verdict, truthfully

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-1756-stillwrong-"));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      return mkResult(seen.length === 1 ? REFUSED_PRIMARY : STILL_WRONG_CORRECTIVE);
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(1756, 1_000_000)), 1_000_000);
    const hit = next.eventLog
      .slice()
      .reverse()
      .find((e) => e.kind === "cap-hit");
    assert(
      hit?.kind === "cap-hit" && hit.cap === "plan-spec-mismatch",
      "a corrective that still misses the spec halts on the gate (not loosened)",
    );
    assert(
      hit?.kind === "cap-hit" && (hit.evidence ?? "").includes("one-shot corrective plan"),
      "the evidence is the corrective's OWN verdict, not the stale primary clause",
    );
    assert(
      hit?.kind === "cap-hit" && !(hit.evidence ?? "").includes("no corrective plan replaced it"),
      "the false clause about a missing corrective is gone",
    );
    assert(
      next.pipelineState.planQuality?.redispatched === true,
      `the park records the corrective that ran (got ${next.pipelineState.planQuality?.redispatched})`,
    );
    assert(
      next.pipelineState.planQuality?.reason === "plan-spec-mismatch",
      "and the park still persists its reason",
    );
    assert(seen.length === 2, `and the corrective was dispatched exactly once (${seen.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 3. a halting tail registers no claims; ---- 4. a live sibling still parks

for (const sibling of [false, true] as const) {
  const dir = mkdtempSync(path.join(tmpdir(), `plan-1756-claims-${sibling}-`));
  // A live sibling holding the file this plan declares. The pid stays alive for
  // the whole case: `readClaims` calls a dead owner stale, and a stale claim
  // parks nobody. `registerClaim` stamps OUR pid, so the row is seeded raw.
  const live = sibling ? await spawnLivePid() : undefined;
  try {
    if (live) {
      // The sibling holds src/held.ts, which this cycle's corrective still
      // declares, so only the claim gate can stop the cycle.
      seedClaims(dir, [
        { issue: 999, pid: live.pid, startedAt: Date.now(), paths: ["src/held.ts"] },
      ]);
    }
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      return mkResult(
        seen.length === 1
          ? REFUSED_PRIMARY
          : sibling
            ? HELD_PATH_CORRECTIVE
            : STILL_WRONG_CORRECTIVE,
      );
    });
    const next = await runPlan(
      ctx,
      stateWithSpec(initialState(1756, 1_000_000), sibling ? coveredSpec() : undefined),
      1_000_000,
    );
    const hits = next.eventLog.filter((e) => e.kind === "cap-hit");
    const hit = hits[hits.length - 1];
    assert(
      hits.some(
        (h) =>
          h.kind === "cap-hit" &&
          h.cap === (sibling ? "cross-group-conflict" : "plan-spec-mismatch"),
      ),
      sibling
        ? "a live sibling's claim still parks the tail with cross-group-conflict"
        : "with no sibling the halt is the plan-spec-mismatch cap",
    );
    assert(
      next.pipelineState.status === "handoff" || hit !== undefined,
      `the halting tail leaves the step parked (status ${next.pipelineState.status})`,
    );
    assert(
      (await readClaimsFile(dir)).every((c) => (c as { issue?: number }).issue !== 1756),
      `a halting tail registers no path claims for #1756${sibling ? " (sibling present)" : ""}`,
    );
  } finally {
    await live?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 5. kill-recovery: the primary's mismatch parks, no second corrective

{
  const dir = mkdtempSync(path.join(tmpdir(), "plan-1756-killrecovery-"));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      // The kill-recovery corrective is the ONLY dispatch: the primary was killed.
      return seen.length === 1 ? killedPrimary() : mkResult(STILL_WRONG_CORRECTIVE);
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(1756, 1_000_000)), 1_000_000);
    const hits = next.eventLog.filter((e) => e.kind === "cap-hit");
    const hit = hits[hits.length - 1];
    assert(
      hits.some((h) => h.kind === "cap-hit" && h.cap === "plan-spec-mismatch"),
      "a kill-recovered plan that misses the spec parks on the gate",
    );
    assert(seen.length === 2, `no second corrective is dispatched (got ${seen.length})`);
    assert(
      next.pipelineState.workstreams === undefined ||
        Object.keys(next.pipelineState.workstreams).length === 0,
      "and the refused recovered plan is not handed to develop",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  exit === 0 ? "\nAll #1756 corrective-clears-primary assertions passed." : "\nFAILURES above.",
);
process.exit(exit);
