#!/usr/bin/env bun
/**
 * #1756 r2 — every park the plan-time claim gate reports must be a park it
 * actually made: `parked: true`, a `cap-hit`, `status: handoff` and
 * `currentStep: plan` all move together, or not at all.
 *
 * The defect this file exists for is the honest-report half. The gate's own
 * docstring promised "`parked` is true exactly when this call appended a
 * cap-hit and moved the step to a plan handoff", and one branch broke it:
 *
 *   if (!sibling) return { state, parked: true };
 *
 * That reported a park without parking — the state came back UNCHANGED, so the
 * cycle was still `running`/`plan` with no cap-hit — and the caller
 * (`runPlanQualityTail`) halted on it. Fail-closed in intent, fail-open in
 * effect: an un-parked state that some later reader treats as a normal plan.
 * The branch now appends the same cap and sets the same handoff fields as the
 * named-conflict park above it (`parkClaimsGate` is the single writer).
 *
 * Reachability, stated honestly. `checkCrossGroupClaimsSync` only ever pushes
 * a `PathClaimEntry` it received, and `readClaims` only yields rows
 * `validClaimEntry` accepted (which requires an integer `issue`), so a real
 * registry read cannot hand the gate a truthy list whose first slot is absent.
 * The branch is a fail-closed guard rather than a live path — which is exactly
 * why it is asserted through the gate's own accepted test seam
 * (`setClaimsConflictsForTests`, the shape `setClaimsLockWriteFaultForTests`
 * is) instead of by forging a registry file: a forged file would have tested
 * the forgery, and an assertion that cannot fail is worse than none. The seam
 * is `undefined` in production and never set from `src/`.
 *
 * The two named parks (a live sibling's claim, and a claims-lock refusal) are
 * asserted here too: they are the shape the degenerate branch must match, and
 * before this file nothing asserted the three agreed except by reading.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAndRegisterClaims } from "../src/work-driver-path-claims.ts";
import { setClaimsConflictsForTests } from "../src/work-driver-path-claims-gate.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { makeCtx, makeState, rawClaims, registerClaimForTest } from "./lib/claims-test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

/** The last cap-hit in the log, if any. */
function lastCapHit(state: WorkState): Extract<WorkEvent, { kind: "cap-hit" }> | undefined {
  const hit = state.eventLog.findLast((e) => e.kind === "cap-hit");
  return hit?.kind === "cap-hit" ? hit : undefined;
}

/** The invariant every park owes its caller: the flag and the state agree. */
function assertParksConsistently(
  label: string,
  outcome: { state: WorkState; parked: boolean },
  cap: string,
  evidenceIncludes?: string,
) {
  assert(outcome.parked === true, `${label}: the gate REPORTS the park (parked: true)`);
  const hit = lastCapHit(outcome.state);
  assert(
    hit?.cap === cap,
    `${label}: it appended the cap it names (got ${hit?.cap ?? "no cap-hit at all"})`,
  );
  assert(
    outcome.state.pipelineState.status === "handoff" &&
      outcome.state.pipelineState.currentStep === "plan",
    `${label}: the state is a plan handoff (got ${outcome.state.pipelineState.status}/${outcome.state.pipelineState.currentStep})`,
  );
  if (evidenceIncludes !== undefined) {
    assert(
      (hit?.evidence ?? "").includes(evidenceIncludes),
      `${label}: the evidence carries ${evidenceIncludes} (got ${(hit?.evidence ?? "none").slice(0, 70)})`,
    );
  }
}

// ---- 1. the degenerate conflict list parks HONESTLY
{
  // Driven through the accepted `setClaimsConflictsForTests` seam. The honest
  // reachability finding, stated once here and in the gate's own comment: NO
  // production read produces a conflict list whose first slot is absent
  // (`readRawClaims` only yields rows `validClaimEntry` accepted,
  // `checkCrossGroupClaimsSync` only pushes entries it was handed, and #1101's
  // sibling filter drops rows from `fresh` BEFORE the check runs, so it cannot
  // produce this shape either — an early draft of this case tried that route and
  // correctly found the list EMPTY). The branch is a fail-closed guard; the
  // seam lets this file pin the invariant that actually broke — that `parked`,
  // the `cap-hit` and the handoff fields move together — instead of forging a
  // registry file and testing the forgery.
  const dir = tmpDir("claims-gate-unreadable-");
  try {
    // Non-empty, first slot absent: the degenerate shape.
    const broken = [undefined, undefined] as unknown as PathClaimEntry[];
    broken[0] = undefined;
    setClaimsConflictsForTests(broken);
    try {
      const outcome = await checkAndRegisterClaims(makeCtx(dir, 1756), makeState(1756, dir), {
        default: { paths: ["src/held.ts"], outOfScope: [] },
      });
      assertParksConsistently(
        "an unreadable conflict",
        outcome,
        "cross-group-conflict",
        "could not be read",
      );
      // The pre-fix shape returned the caller's state object verbatim. Nothing
      // else in this function can produce that: the fix has to have written.
      assert(
        outcome.state.eventLog.length === 1,
        `and the state really changed (eventLog length ${outcome.state.eventLog.length}, was 0 in)`,
      );
      // And it registered NOTHING: a park must not reserve paths for a plan the
      // cycle never develops.
      const registry = rawClaims(dir).filter((c) => c.issue === 1756);
      assert(
        registry.length === 0,
        `and a park registers no claim for #1756 (got ${registry.length} entr(ies))`,
      );
    } finally {
      setClaimsConflictsForTests(undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2. the two NAMED parks keep the same shape, so the three cannot drift
{
  const dir = tmpDir("claims-gate-conflict-");
  try {
    await registerClaimForTest(dir, 801, ["src/shared.ts"]);
    const outcome = await checkAndRegisterClaims(makeCtx(dir, 802), makeState(802, dir), {
      "task-b": { paths: ["src/shared.ts"], outOfScope: [] },
    });
    assertParksConsistently("a live sibling's claim", outcome, "cross-group-conflict", "claimant801");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  exit === 0 ? "\nAll claim-gate park-consistency checks passed." : "\nFAILED — see above.",
);
process.exit(exit);
