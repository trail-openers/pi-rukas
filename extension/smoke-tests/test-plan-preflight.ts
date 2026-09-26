#!/usr/bin/env bun
/**
 * #893 — plan pipeline reporter-preflight (setPlanStatFn).
 *
 * A rejecting plan stat seam fails the pipeline BEFORE any dispatch
 * (duplicate-risk included) with the existing all-angles-failed halt,
 * whose spec/detail names the missing reporter and ./install.sh — and
 * whose spec is the honest "No angles were dispatched" text (the
 * generic "Dispatched angles … prose only / schema-invalid" text would
 * be false when the preflight is what failed).
 *
 * Sits beside test-reporter-preflight.ts (research/policy/lens
 * coverage); split for the 500-line hard limit (AGENTS.md §12).
 */

import { PLAN_REPORTER_PATH } from "../src/plan-investigate.ts";
import {
  runPlanPipeline,
  setPlanDispatch,
  setPlanStatFn,
} from "../src/plan-driver.ts";
import { reporterMissingError } from "../src/reporter-preflight.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  // A rejecting stat makes the phase fail before ANY dispatch; the
  // counting dispatch stub below must never run.
  const rejectStat = async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };

  let dispatchCount = 0;
  setPlanDispatch(((
    _pi: unknown,
    _spec: { role: string; prompt: string },
    _opts?: { label?: string },
  ) => {
    dispatchCount++;
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "should not reach here",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }) as never);
  setPlanStatFn(rejectStat);

  const r = await runPlanPipeline(
    { registerTool: () => {} } as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  // Clear both seams afterwards.
  setPlanStatFn(null);
  setPlanDispatch(null);

  assert(dispatchCount === 0, `plan preflight: 0 dispatches (got ${dispatchCount})`);
  assert(
    r.filingFailure?.reason === "skipped-all-angles-failed",
    `plan preflight: halt is the all-angles-failed reason (got ${String(r.filingFailure?.reason)})`,
  );
  assert(
    r.spec.includes(reporterMissingError(PLAN_REPORTER_PATH)),
    `plan preflight: spec carries the named error (path + ./install.sh) (got "${r.spec.slice(0, 160)}")`,
  );
  assert(
    r.spec.includes("No angles were dispatched"),
    `plan preflight: spec is the honest preflight text, not the dispatched-angles text (got "${r.spec.slice(0, 80)}")`,
  );
  assert(
    (r.filingFailure?.detail ?? "").includes("reporter extension missing") ||
      (r.failedAngles?.[0]?.detail ?? "").includes("reporter extension missing"),
    "plan preflight: detail/failedAngles carry the named error",
  );
  assert(
    (r.failedAngles ?? []).length > 0 &&
      (r.failedAngles ?? []).every((a) => a.detail === reporterMissingError(PLAN_REPORTER_PATH)),
    "plan preflight: every failed angle carries the named reporter-missing error",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
