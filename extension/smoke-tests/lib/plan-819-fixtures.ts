/**
 * Shared fixtures for the #819 plan-step suites.
 *
 * `test-plan-round3-819.ts` and `test-plan-corrective-clears-primary.ts` both
 * drive `runPlan` with a canned `dispatchFn` against the same one-deliverable
 * spec (a deliverable at src/required.ts that a plan can miss or cover), and the
 * #1756 corrective case is only comparable to the #819 halt case while the two
 * share the fixture. A second copy of the spec shape is how the two drift apart
 * on the detail a case actually asserts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../../src/types.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import type { SpecCoverageSpec } from "../../src/work-driver-plan-spec-coverage.ts";
import type { PlanResultShape } from "./plan-workstream-calls.ts";

/** The issue both suites file their cycles under. */
export const PLAN_819_ISSUE = 819;

const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

/** A spec whose deliverable lives at src/required.ts, so a plan declaring only
 * src/other.ts gives the plan-to-spec gate a real mismatch to act on. */
export const SPEC_819: SpecCoverageSpec = {
  intent: "fix the thing",
  deliverables: [{ id: "d1", description: "d", paths: ["src/required.ts"] }],
  acceptanceCriteria: ["it works"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "",
};

/** A `DispatchResult` carrying a plan's report_workstream calls (#1652). */
export function stubDispatchResult(
  plan: PlanResultShape,
  patch: Partial<DispatchResult> = {},
): DispatchResult {
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

/** A driver context for an offline plan run: no provider, no git, and a stub
 * `verifyExecFn` so the coupling merge's grep never runs. */
export function mkPlanCtx(dir: string, dispatchFn?: DriverContext["dispatchFn"]): DriverContext {
  return {
    host: fakePi,
    repoRoot: dir,
    issue: PLAN_819_ISSUE,
    dispatchFn,
    verifyExecFn: (async () => ({
      stdout: "",
      code: 0,
    })) as unknown as DriverContext["verifyExecFn"],
  };
}
