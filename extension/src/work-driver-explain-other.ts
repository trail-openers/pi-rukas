/**
 * work-driver-explain-other — cap-hit explanations for the
 * adversarial-infra-failure and step-back-revise-spec caps. Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
 * bodies of work-driver-explain.ts.
 */

import { classifyFailureCause, failureCauseReason } from "./work-driver-failure-taxonomy.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * #79 — what the adversarial step's last failed dispatch actually died of,
 * classified by the taxonomy: `provider/transport error: Request timed out.
 * (×2 in a row …) [cause=provider-severed]`. Empty when the log holds none.
 */
export function adversarialFailureCause(state: WorkState): string {
  const ev = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "dispatch-failed" | "dispatch-failed-provider" }> =>
        (e.kind === "dispatch-failed" || e.kind === "dispatch-failed-provider") &&
        e.step === "adversarial",
    );
  return ev ? `${failureCauseReason(ev)} [cause=${classifyFailureCause(ev).cause}]` : "";
}

/**
 * Explains the `adversarial-infra-failure` and `step-back-revise-spec`
 * caps; the dispatch is exhaustive, so an unknown cap can never land
 * here.
 */
export function explainOther(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "adversarial-infra-failure": {
      const out = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
            e.kind === "adversarial-workstream-outcome" &&
            (e.outcome === "infra-failure" || e.outcome === "dispatch-failed"),
        );
      const which = out ? `workstream ${out.workstreamId}` : "a workstream";
      const cause = adversarialFailureCause(state);
      return `${which}'s adversarial loop failed on infrastructure${cause ? ` (${cause})` : ""} and was not retried further — NO verdict exists for it, and that is not a review rejection. The other workstreams' completed reviews are preserved in the state file (adversarial-workstream-outcome events); recover by re-running /work, which re-enters the adversarial step and re-runs ONLY the workstream(s) that never produced a verdict`;
    }
    case "adversarial-diff-unreadable": {
      // #1634 — the git error the read met, from the cap's own evidence — the
      // ONE field the single cap helper (`work-driver-adversarial-diff-cap.ts`)
      // writes. There is no second channel: a pipeline-state copy would be a
      // second source of truth for the same string, and the one that used to
      // exist was written by whichever sibling's read failed last.
      const why =
        [...state.eventLog]
          .reverse()
          .find(
            (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
              e.kind === "cap-hit" && e.cap === "adversarial-diff-unreadable",
          )?.evidence ?? "(no git error recorded)";
      return `The adversarial gate could not read the worktree diff it is supposed to review: ${why}. The driver halted rather than approving. Before #1634 the diff read returned an empty string for every failure — no worktree path, a directory that is not a repository, a \`git diff\` that threw or exited non-zero — and the empty-diff guard read that as a clean tree: skipped, then APPROVED with zero rounds, so a killed develop round's unreadable worktree merged unreviewed. Check that the worktree named above still exists and is a git worktree (\`git -C <path> rev-parse --show-toplevel\`), then re-run.`;
    }
    case "step-back-revise-spec": {
      const sb = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
            e.kind === "step-back-completed",
        );
      const elem = sb?.sddElement ?? "(spec element not specified)";
      // The figure this line used to print — "MAST 41.77%" — appears nowhere
      // in Cemri et al., arXiv 2503.13657; the paper's figure for this line's
      // own claim is step repetition FM-1.3 at 15.7%, the largest mode WITHIN
      // the FM-1.x list only (it makes no cross-category ranking). Full
      // taxonomy and intervention figures: AGENTS.md §7 — a pointer kept here,
      // in the comment a maintainer reads with the repo open, not in the
      // emitted line, which reaches the operator through `/work-status` with
      // no repository in front of them.
      return `explore stepped back and identified a spec-level gap in **${elem}**. The lens-review fix loop kept flagging the same shape across rounds — the fingerprint of a spec-level problem. The handoff body includes a proposed revision; after updating the issue (via /plan or \`gh issue edit\`), re-run with \`/work N --restart\` to start a fresh cycle against the revised spec — in MAST (arXiv 2503.13657) the largest single FM-1.x mode is step repetition FM-1.3 at 15.7%, and the paper reports tactical approaches get only limited results`;
    }
    default:
      return `unhandled explain-other cap: ${cap}`;
  }
}
