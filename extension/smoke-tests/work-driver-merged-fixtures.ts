/**
 * Side-effect-free fixtures shared by the work-driver merged smoke tests
 * (test-work-driver-merged-mechanized.ts, test-work-driver-merged-postverify.ts).
 *
 * Extracted so postverify can import the typed state fixture WITHOUT executing
 * the mechanized test's top-level assertions and `process.exit` — importing an
 * executable test file runs it, which masked postverify's own suite (issue #356).
 *
 * This module MUST stay free of assertions, top-level execution, and process.exit.
 */

import type { PipelineState, WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";

// Builds a valid WorkState at the `merged` step by spreading a typed object —
// no `as any`/double-cast erasure of the WorkState shape.
export function mkStateMerged(
  issue: number,
  pr: number,
  branch: string,
  extra: Partial<PipelineState> = {},
): WorkState {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "merged",
      lastCompletedStep: "ci",
      branchName: branch,
      prNumber: pr,
      ...extra,
    },
  };
}
