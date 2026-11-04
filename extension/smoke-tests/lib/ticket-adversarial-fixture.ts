/**
 * lib/ticket-adversarial-fixture — drives the REAL adversarial step far enough
 * to reach a reviewer, and captures the `issueBody` the fan-out handed it.
 *
 * Split from `test-ticket-aware-review.ts` (AGENTS.md §12, the 500-line cap).
 * The step is what makes this a test rather than a unit test of the reader: it
 * takes two early exits — an unreadable diff read and the #286 empty-diff skip —
 * before it ever builds a reviewer prompt, so a fixture that only stubs its way
 * past them proves nothing about what the reviewer was handed. A real repo with
 * a real commit on a real branch, and NO `verifyExecFn` (a stub that answers the
 * diff too returns an empty tree and the pass skips), is the smallest state that
 * gets there. `adversarialLoopFn` is the sanctioned seam for the reviewer itself.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import type { DispatchResult } from "../../src/types.ts";
import type { CycleContext } from "../../src/work-driver-context.ts";
import { initialState } from "../../src/workflow-state.ts";
import { makeFakePi } from "./lens-fix-bound-land-fixture.ts";
import { adversarialFixture } from "./ticket-capture.ts";

/** The captured dispatch, or why the step never got there. */
export interface AdversarialRun {
  /** The `issueBody` the loop was handed (`undefined` = the param was absent). */
  received: string | undefined;
  /** Whether the step reached the reviewer at all. */
  approved: boolean;
}

export async function captureAdversarialIssueBody(label: string): Promise<AdversarialRun> {
  const { repoRoot, baseSha, artifact } = adversarialFixture(label);
  // The pass reads its diff as `git diff <baseSha>` against the working tree, so
  // a state with no base compares HEAD to itself: an empty read, the #286 skip,
  // and no reviewer reached at all. The base is the mainline commit the branch
  // was cut from.
  const s = initialState(2009, 1_000_000);
  s.pipelineState = {
    ...s.pipelineState,
    currentStep: "adversarial",
    lastCompletedStep: "develop",
    baseSha,
    worktrees: { default: repoRoot },
    branchName: "feature/issue-2009",
    issueBodyArtifact: artifact,
  };
  let received: string | undefined;
  const ctx = {
    host: makeFakePi(),
    emitSink: { emit: () => undefined, fingerprints: [] },
    repoRoot,
    issue: 2009,
    adversarialLoopFn: async (params: Record<string, unknown>) => {
      received = params.issueBody as string | undefined;
      return {
        role: "adversarial-loop",
        ok: true,
        text: "Adversarial APPROVED after round 1.",
        toolUses: [],
        ms: 1,
        exitCode: 0,
        loopOutcome: "approved",
        adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
      } as DispatchResult;
    },
    dispatchFn: async () =>
      ({
        role: "ops",
        ok: true,
        text: "pr: 9999",
        toolUses: [],
        ms: 1,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }) as DispatchResult,
  } as unknown as CycleContext;
  const { runAdversarial } = await import("../../src/work-driver-adversarial.ts");
  const after = await runAdversarial(ctx, s, Date.now());
  return {
    received,
    approved: after.eventLog.some((e) => e.kind === "adversarial-approved"),
  };
}

/** The artifact path the fixture cached its body at — the value the reviewer
 * must NEVER be shown in place of the body. */
export function adversarialArtifactPath(label: string): string {
  return adversarialFixture(label).artifact;
}
