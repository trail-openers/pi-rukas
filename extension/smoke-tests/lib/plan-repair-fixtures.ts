/**
 * Shared fixtures for the single-workstream plan-repair tests.
 *
 * The behaviour is tested in two files, split by the half of
 * `work-driver-plan-repair.ts` each one judges:
 * `test-plan-spec-mismatch-repair.ts` runs the cases through the real plan
 * quality tail (`repairOmittedDeliverablePaths` reached via the gate), and
 * `test-plan-repair-assumption.ts` judges `withOmittedPathAssumption` on the
 * state it returns. Both need the same spec, workstream, and host fixtures, and
 * a third copy of the #1439 spec shape in each file is how the two drift apart
 * on the detail a case actually asserts.
 */

import type { NormalisedSpec } from "../../src/work-driver-intent.ts";
import type { PlanQualityHost } from "../../src/work-driver-plan-quality-pass.ts";
import type { Workstream } from "../../src/workflow-state-schema.ts";
import { initialState } from "../../src/workflow-state-update.ts";

/** The two test files one deliverable named, which the planner omitted (#1439 run 5). */
export const T1 = "extension/smoke-tests/test-vipune.ts";
export const T2 = "extension/smoke-tests/test-secret-patterns.ts";

/** The #1439 shape: one deliverable naming a source file and two tests. */
export const SPEC: NormalisedSpec = {
  intent: "vipune and secret-pattern coverage",
  deliverables: [{ id: "d5", description: "tests", paths: ["src/a.ts", T1, T2] }],
  acceptanceCriteria: [],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "",
};

export const WS = (id: string, paths: string[], outOfScope: string[] = []): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/** A plan host whose corrective must never resolve: a repaired plan never reaches it. */
export const HOST: PlanQualityHost = {
  dispatch: async () => {
    throw new Error("corrective dispatch — expected only where the repair refuses");
  },
  prompt: "primary plan prompt",
  slow: () => undefined,
  deck: () => ({}),
};

/**
 * A state carrying `spec` as its normalised spec. `withOmittedPathAssumption`
 * reads the spec off the state, so the state and the spec the gate judged must
 * be the same object rather than two fixtures that happen to agree.
 */
export function stateWithSpec(spec: NormalisedSpec) {
  const base = initialState(1439, 1);
  return {
    ...base,
    pipelineState: { ...base.pipelineState, normalisedSpec: spec },
  };
}
