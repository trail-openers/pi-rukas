/**
 * work-driver-verify-events — #1240: the recorder that turns a consolidated
 * verify skip into its event-log entry.
 *
 * Lives on the VERIFY side, not in `workflow-state-events-verify-flake.ts`.
 * That module is a pure type fragment — every sibling `workflow-state-events-*`
 * file imports types only, and `workflow-state-events.ts` composes the closed
 * `WorkEvent` union from them. A VALUE import of `appendEvent` from
 * `workflow-state.ts` inside that fragment closes a real require cycle
 * (`workflow-state.ts → workflow-state-events.ts → the fragment →
 * workflow-state.ts`), and a cycle through a module that runs top-level code
 * is exactly the shape that produced the TDZ crash in 9 CI tests on PR #1412.
 * The factory and the event type stay where the union can reach them; the
 * mutation lives here, where importing `workflow-state.ts` is ordinary.
 */
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { makeConsolidatedVerifySkippedEvent } from "./workflow-state-events-verify-flake.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Record the skip on the state: the single place that turns a gate's
 * `consolidatedVerifySkipped` into the event, so EVERY path that re-runs the
 * develop gate records it. The gate runs at four seams (the topological
 * develop pass, the #1005 fence merge-and-retry, the #1323 sibling-symbol
 * merge, and the #741 converge corrective re-run) and each one owns its own
 * append; a skip recorded only at the first would make the gate look like it
 * ran on the three re-run paths, which is the opposite of what #1240's
 * "never silent" promise means. `workstreamCount` is read from the state here
 * for the same reason — one rule for the count cannot drift per caller.
 */
export function recordConsolidatedVerifySkip(
  state: WorkState,
  gate: { consolidatedVerifySkipped?: AlreadyVerifiedTree },
): WorkState {
  if (gate.consolidatedVerifySkipped === undefined) return state;
  return appendEvent(
    state,
    makeConsolidatedVerifySkippedEvent(
      "develop",
      gate.consolidatedVerifySkipped,
      // The degenerate N=1 shape carries no `worktrees` map (the one
      // workstream's worktree IS repoRoot), so count that as one.
      Object.keys(state.pipelineState.worktrees ?? {}).length || 1,
    ),
  );
}
