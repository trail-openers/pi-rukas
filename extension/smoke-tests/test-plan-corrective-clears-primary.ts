#!/usr/bin/env bun
/**
 * #1756 — a clean corrective plan clears a refused primary plan.
 *
 * The defect: `primaryGateRefused` was a const computed from `input.redispatched`
 * BEFORE the one-shot corrective dispatch, and the corrective set the local flag
 * only afterwards. So a corrective whose own plan-to-spec gate passed still fell
 * through to the tail halt and parked as `plan-spec-mismatch` with the false
 * clause "no corrective plan replaced it" (infra-one #327: 38.3M tokens, no work).
 * The halt also registered cross-group path claims for a plan nobody develops.
 *
 * Cases (all offline: `runPlan` with an injected `dispatchFn`):
 *   1. a refused spec-mismatched primary + a covering corrective -> NO cap-hit,
 *      the corrective's workstreams reach pipelineState, `planQuality.redispatched`
 *      is true, exactly 2 dispatches;
 *   2. primary mismatch + a corrective that still mismatches -> halts on the
 *      corrective's OWN verdict with the corrective's own why-clause, and the
 *      persisted verdict records that the corrective ran;
 *   3. a halting tail registers no path claims, asserted against the raw
 *      registry (an unreadable file is reported, never read as "no claims");
 *   4. a live sibling's claim still parks the tail (`cross-group-conflict`);
 *   5. a kill-recovered primary with a mismatch parks and dispatches NO second
 *      corrective (#754 one-corrective-per-cycle);
 *   6. a claims-lock refusal AFTER a covering corrective still halts the step
 *      with `claims-lock-unavailable` — the halt is decided by the gate's own
 *      return, not by the shape of the event tail — and still records that the
 *      corrective ran;
 *   7. a corrective dispatch that returns `ok: false` still records
 *      `planQuality.redispatched: true` and invents NO reason (r2: the record
 *      is set at the dispatch, not at the return — the three failure returns
 *      all happen before the old assignment could run).
 *
 * Case 8 — the claim gate's OWN parks (including the unreadable-conflict branch
 * this round fixed) — lives in `test-work-driver-claims-gate-parks.ts`, which
 * drives `checkAndRegisterClaims` directly (split for the 500-line cap).
 *
 * PI_ENSEMBLE_PLAN_QUALITY is deliberately left UNSET — with the gate off the
 * bug is unreachable, so a run that set it would prove nothing.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { checkAndRegisterClaims } from "../src/work-driver-path-claims.ts";
import type { SpecCoverageSpec } from "../src/work-driver-plan-spec-coverage.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { type WorkState, initialState, workStateDir } from "../src/workflow-state.ts";
import {
  type PathClaimEntry,
  makeState,
  rawClaims,
  seedClaims,
  spawnLivePid,
} from "./lib/claims-test-helpers.ts";
import {
  COVERING_CORRECTIVE,
  REFUSED_PRIMARY,
  SPEC_819,
  mkPlanCtx,
  stubDispatchResult,
} from "./lib/plan-819-fixtures.ts";
import { planResultFromCalls } from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_RESUME = "0";
// The claim registry is ON for this file: cases 1, 3, 4 and 6 are about who owns
// the paths, case 4 needs the real conflict check, and case 6 the real lock.
// The fixtures declare no depends-on edges, and the contract pass would fold ids.
process.env.PI_ENSEMBLE_PLAN_CONTRACT = "0";

const mkResult = stubDispatchResult;
/** Every case in this file runs the cycle AS #1756 — the claim registry keys its
 * entry by `ctx.issue`, so a context left at the shared fixture's 819 would make
 * every "did #1756 register?" assertion below vacuously true. */
const CYCLE_ISSUE = 1756;
const mkCtx = (dir: string, dispatchFn?: DriverContext["dispatchFn"]) =>
  mkPlanCtx(dir, dispatchFn, CYCLE_ISSUE);

/** The spec whose single deliverable lives at src/required.ts (or the override). */
function stateWithSpec(state: WorkState, specOverride?: SpecCoverageSpec): WorkState {
  return {
    ...state,
    pipelineState: { ...state.pipelineState, normalisedSpec: specOverride ?? SPEC_819 },
  };
}

/** A corrective that still misses `SPEC_819`'s deliverable. */
const STILL_WRONG_CORRECTIVE = planResultFromCalls([
  { id: "default", scope: "the fix", paths: ["src/other.ts"], outOfScope: [] },
]);

/** A corrective whose dispatch came back not-ok (a provider error, a non-zero exit). */
const FAILED_CORRECTIVE = mkResult(STILL_WRONG_CORRECTIVE, {
  ok: false,
  exitCode: 1,
  errorTail: "provider request error",
});

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

/**
 * Read the claim registry raw — the driver's own liveness rules are not what
 * these cases assert, so the file is what answers "did we register?". An
 * unreadable file is reported as `null` rather than as "no claims": a case that
 * asserts NOTHING was registered must be able to tell an empty registry from a
 * file it could not read, which is exactly what the old swallow-everything
 * reader could not.
 */
function claimsOrNull(dir: string): PathClaimEntry[] | null {
  try {
    return rawClaims(dir);
  } catch {
    return null;
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
    const ours = (claimsOrNull(dir) ?? []).filter((c) => c.issue === 1756);
    assert(
      ours.length === 1 && ours[0]?.paths?.includes("src/required.ts") === true,
      `a cycle that develops the corrective owns the CORRECTIVE's paths in the registry (got ${
        ours[0]?.paths?.join(",") ?? "no entry for #1756"
      })`,
    );
    assert(
      (ours[0]?.paths ?? []).every((p) => !p.includes("||")),
      `and no registered path is an either/or disjunct (${ours[0]?.paths?.join(",")})`,
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
    const claims = claimsOrNull(dir);
    assert(
      claims === null ? false : !claims.some((c) => c.issue === 1756),
      `a halting tail registers no path claims for #1756${sibling ? " (sibling present)" : ""} — ${
        claims === null ? "the registry file could not be read (UNREADABLE)" : "no entry for #1756"
      }`,
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

// ---- 6. a claims-lock refusal after a COVERING corrective still halts, and
//         still records the corrective

{
  // The tail-sniffing bug this case pins: the claim gate's parks used to be
  // detected by reading `eventLog.at(-1)?.kind === "cap-hit"`, which asks the
  // tail who appended it rather than asking the gate. The gate now returns
  // `parked`. `.pi/work-state` is made unwritable (the field shape
  // test-work-driver-claims-refusal.ts reproduces), so `registerClaim` fails
  // closed AFTER the corrective covered the spec: the state must be a handoff
  // with the named cap and `planQuality.redispatched: true`, not a clean plan.
  const dir = mkdtempSync(path.join(tmpdir(), "plan-1756-claimslock-"));
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  const lockDir = workStateDir(dir);
  mkdirSync(lockDir, { recursive: true });
  try {
    chmodSync(lockDir, 0o500); // r-x: no write bit — EACCES creating the lock
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      return mkResult(seen.length === 1 ? REFUSED_PRIMARY : COVERING_CORRECTIVE);
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(1756, 1_000_000)), 1_000_000);
    const last = next.eventLog[next.eventLog.length - 1];
    assert(
      last?.kind === "cap-hit" && last.cap === "claims-lock-unavailable",
      `a refused registration halts the step with the named cap (got ${
        last?.kind === "cap-hit" ? last.cap : last?.kind
      })`,
    );
    assert(
      next.pipelineState.status === "handoff" && next.pipelineState.currentStep === "plan",
      `and the cycle parks at plan as a handoff (got ${next.pipelineState.status}/${next.pipelineState.currentStep})`,
    );
    assert(seen.length === 2, `the corrective ran before the refusal (${seen.length})`);
    assert(
      next.pipelineState.planQuality?.redispatched === true,
      `the park records the corrective that ran (got ${next.pipelineState.planQuality?.redispatched})`,
    );
    assert(
      next.pipelineState.planQuality?.reason === undefined,
      `and invents no reason for a filesystem fault (got ${next.pipelineState.planQuality?.reason})`,
    );
    // #1756 r2 — the gate's OWN report is what the caller branches on, so the
    // case reads it too: a handoff state whose gate said `parked: false` would
    // be halted by the tail shape by luck, not by contract.
    const gate = await checkAndRegisterClaims(
      { repoRoot: dir, issue: CYCLE_ISSUE } as unknown as Parameters<
        typeof checkAndRegisterClaims
      >[0],
      makeState(CYCLE_ISSUE, dir),
      { default: { paths: ["src/required.ts"], outOfScope: [] } },
    );
    assert(
      gate.parked === true,
      `the claim gate REPORTS the refused registration as a park (got ${String(gate.parked)})`,
    );
  } finally {
    try {
      chmodSync(lockDir, 0o700);
    } catch {
      /* already restored, or never created */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 7. a corrective that returns not-ok still records that it ran

{
  // r2 — `correctiveRan` was set only AFTER the `!retry` / killCause /
  // `!retry.ok` returns, so each of those three halted with
  // `planQuality.redispatched: false` — the record denied the dispatch the
  // cycle paid for. The record is now `correctiveAttempted`, set at the
  // dispatch. The halt PREDICATE is untouched: this cycle still parks (the
  // primary's verdict stands, because a corrective that never produced a plan
  // clears nothing), still on its `dispatch-failed` tail, and still invents no
  // reason for a provider error.
  const dir = mkdtempSync(path.join(tmpdir(), "plan-1756-failed-corrective-"));
  try {
    const seen: string[] = [];
    const ctx = mkCtx(dir, async (_pi, _spec, opts) => {
      seen.push((opts as { label?: string })?.label ?? "");
      return mkResult(seen.length === 1 ? REFUSED_PRIMARY : FAILED_CORRECTIVE);
    });
    const next = await runPlan(ctx, stateWithSpec(initialState(1756, 1_000_000)), 1_000_000);
    assert(seen.length === 2, `the corrective was dispatched once (got ${seen.length})`);
    assert(
      next.eventLog.at(-1)?.kind === "dispatch-failed",
      `the failed corrective still ends on its own dispatch-failed tail (got ${next.eventLog.at(-1)?.kind})`,
    );
    assert(
      next.pipelineState.planQuality?.redispatched === true,
      `the halt records the corrective the cycle paid for (got ${next.pipelineState.planQuality?.redispatched})`,
    );
    assert(
      next.pipelineState.planQuality?.reason === undefined,
      `and invents no plan-quality reason for a provider error (got ${next.pipelineState.planQuality?.reason})`,
    );
    assert(
      !next.eventLog.some((e) => e.kind === "cap-hit"),
      "and the halt is the dispatch failure, not an invented cap",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 8 lives in test-work-driver-claims-gate-parks.ts: the gate's OWN parks
// are asserted at the gate, not only through runPlan (500-line cap, §12).

console.log(
  exit === 0 ? "\nAll #1756 corrective-clears-primary assertions passed." : "\nFAILURES above.",
);
process.exit(exit);
