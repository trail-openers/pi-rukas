/**
 * work-driver-plan-inputs — #1642: the plan child's inputs, read from the cycle
 * state so the prompt builder never guesses a path.
 *
 * The three inputs are the cached issue body (`pipelineState.issueBodyArtifact`),
 * Step 1's explore report (the `dispatch-completed` event of the explore step:
 * `artifactPath` when it spilled to a file, else its inline `summary`), and the
 * resolved spec's deliverables (`pipelineState.normalisedSpec`). Each is optional:
 * an absent input is rendered as UNAVAILABLE by `planInputsLines`, which is the
 * honest answer for a state file that does not carry it.
 *
 * Pure over the state it is given; the repo root only anchors a relative path.
 */

import path from "node:path";
import type { PlanPromptInputs } from "./work-driver-prompts-plan.ts";
import type { WorkState } from "./workflow-state.ts";

/** The most recent explore completion in the cycle's event log, if any. */
function latestExploreCompletion(state: WorkState) {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "dispatch-completed" && e.step === "explore") return e;
  }
  return undefined;
}

export function planPromptInputsOf(state: WorkState, repoRoot: string): PlanPromptInputs {
  const ps = state.pipelineState;
  const explore = latestExploreCompletion(state);
  const spec = ps.normalisedSpec;
  return {
    ...(ps.issueBodyArtifact
      ? { issueBodyPath: path.resolve(repoRoot, ps.issueBodyArtifact) }
      : {}),
    ...(explore?.artifactPath
      ? { explorePath: path.resolve(repoRoot, explore.artifactPath) }
      : explore?.summary !== undefined
        ? { exploreSummary: explore.summary }
        : {}),
    ...(spec
      ? {
          deliverables: spec.deliverables.map((d) => ({
            id: d.id,
            description: d.description,
            paths: d.paths,
          })),
        }
      : {}),
  };
}
