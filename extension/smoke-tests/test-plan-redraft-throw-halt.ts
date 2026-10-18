#!/usr/bin/env bun
/**
 * #1541 — a corrective re-draft that THROWS must halt the plan run, not crash it.
 *
 * `correctiveRedraft` (plan-driver-redraft.ts) wraps its work in a wide catch
 * and rethrows via `correctiveRedraftError`, whose message discloses which
 * carried gap decisions had been computed (and whether each splice landed).
 * That disclosure is only half the job: before the fix the throw escaped
 * `runGate`, escaped `runPlanPipeline`, and landed in `startJob`'s generic
 * rejection path — a FAILED report with no `capReason`, no NOT-FILEABLE head
 * and no FILING STATUS. The operator lost the plan-specific rendering the
 * sibling gate failure modes (`gate-unavailable`, `review-unparseable`) produce.
 *
 * `draftSpec` cannot be made to throw from a dispatch stub — every one of its
 * helpers is defensive (this is stated in test-plan-gap-writeback.ts's own
 * ERROR_HANDLING note), so the wide catch is a guard for a future refactor
 * rather than a reachable path. The re-draft is therefore injected through the
 * seam plan-driver-gate.ts reads (`setPlanRedraft`, same shape as the
 * dispatch/stat seams) and the REAL pipeline runs: the round-1 reviewer returns
 * a CRITICAL, the corrective fires, it throws via `correctiveRedraftError`
 * exactly as the production re-draft does, and everything asserted here is what
 * the pipeline returned to the tool — including the rendered report.
 */
import { correctiveRedraftError } from "../src/plan-driver-halt.ts";
import { runPlanPipeline, setPlanDispatch, setPlanRedraft } from "../src/plan-driver.ts";
import { renderPlanResult } from "../src/plan-report.ts";
import type { PlanGap } from "../src/plan-types.ts";
import {
  forgeStub,
  gatePrompts,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  makeDispatchStub,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

installForgeStub();
installOfflineVipuneStub();
installNoPlanCacheStub();

const DESCRIPTOR = "add a start_plan_driver tool for the plan pipeline in extension";
const RETRY_STATEMENT =
  "in the Acceptance criteria section, the retry path stops after three attempts";

{
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  // `gatePrompts` is the shared stub's module-level log; this run's own rounds
  // are what the array looks like AFTER the run — `slice(before)`, not `.length`.
  const gatePromptsBefore = gatePrompts.length;
  setPlanDispatch(
    makeDispatchStub([
      `GAP: CRITICAL no failure-mode criterion — proposed resolution: ${RETRY_STATEMENT} — resolution-type: concrete\nVERDICT: NEEDS_ITERATION`,
    ]) as never,
  );
  setPlanRedraft((blocking: PlanGap[]) => {
    // The production disclosure builder, with the splice outcome the re-draft
    // had recorded before it died — so the halt is asserted on the message the
    // operator actually reads, not on a stand-in string.
    throw correctiveRedraftError(
      blocking.map((g) => ({ description: g.description, resolution: g.resolution })),
      [{ applied: true, heading: "Acceptance criteria" }],
      new Error("forced by test"),
    );
  });
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, dryRun: true },
    process.cwd(),
  );
  setPlanRedraft(null);
  setPlanDispatch(null);

  const ownPrompts = gatePrompts.slice(gatePromptsBefore);
  assert(
    ownPrompts.length >= 1 && ownPrompts[0]?.includes("GAP DETECTION") === true,
    `redraft-halt: the round that ran is the round-1 full review, so the corrective genuinely fired (this run's gate dispatches: ${ownPrompts.length})`,
  );
  // The throw is ABSORBED inside the loop (not rethrown) precisely so the loop's
  // own `timed("gap-gate")` entry still lands — which means the round-2 dispatch
  // can be *queued* in the same tick. What the halt guarantees is that its reply
  // is never awaited or parsed: round 2's SCOPED VERIFICATION prompt names the
  // carried resolutions, and there were none — the run never got a re-drafted
  // body to verify.
  assert(
    !ownPrompts.some((p) => p.includes("SCOPED VERIFICATION")),
    "redraft-halt: the round-2 SCOPED VERIFICATION is never awaited — the halt short-circuits before the re-drafted body is reviewed",
  );
  assert(r.filed === false, "redraft-halt: the halting spec is NOT filed");
  assert(
    forgeStub.created.length === 0,
    `redraft-halt: issueCreate was never called (forge calls: ${forgeStub.created.length})`,
  );
  assert(r.capHit === true, `redraft-halt: the halt is a cap hit (got capHit=${String(r.capHit)})`);
  assert(
    r.capReason === "gate-unavailable",
    `redraft-halt: capReason is 'gate-unavailable' — the sibling gate failure mode, never a silent pass (got ${String(r.capReason)})`,
  );
  assert(
    r.filingFailure?.reason === "gate-unavailable",
    `redraft-halt: the discriminated filing failure is gate-unavailable (got ${String(r.filingFailure?.reason)})`,
  );
  // The re-draft's disclosure survives: correctiveRedraftError names the carried
  // decisions, and the halt carries that message into the operator-facing text.
  assert(
    (r.filingFailure?.detail ?? "").includes("carried gap decision"),
    `redraft-halt: the halt detail carries the re-draft's decision disclosure (got ${String(r.filingFailure?.detail).slice(0, 120)})`,
  );
  assert(
    r.filingFailure?.detail?.includes("written back to Acceptance criteria") === true,
    "redraft-halt: the disclosure names WHICH decision's splice had landed",
  );
  assert(
    r.spec.includes("corrective re-draft") && r.spec.includes("carried gap decision"),
    "redraft-halt: the operator-facing spec names the failure and reproduces the disclosure",
  );
  // And the RENDERED report is a plan halt, not async-jobs' generic fail text.
  const rendered = renderPlanResult(r, true);
  assert(
    rendered.includes("NOT FILEABLE AS-IS (gate-unavailable)"),
    `redraft-halt: the rendered head is the plan halt, not a FAILED report (got ${rendered.slice(0, 110).replace(/\n/g, " ")})`,
  );
  assert(
    /=== FILING STATUS ===/.test(rendered) &&
      /Not filed \(by policy\)/.test(rendered.split("=== FILING STATUS ===")[1] ?? ""),
    "redraft-halt: FILING STATUS renders it as a deliberate skip, matching the sibling gate failures",
  );
  assert(
    /GAP GATE UNAVAILABLE/.test(rendered),
    "redraft-halt: the cap block renders the gate-unavailable branch (the operator sees WHY, not a bare cap hit)",
  );
}

console.log(exit === 0 ? "\nredraft-throw halt: PASS" : "\nFAILED");
process.exit(exit);
