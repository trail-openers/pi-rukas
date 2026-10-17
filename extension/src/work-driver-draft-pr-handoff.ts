/**
 * work-driver-draft-pr-handoff — what the handoff comment says about the PR's
 * draft state.
 *
 * The rendering half of the draft family, split from `work-driver-draft-pr.ts`
 * (500-line cap): the mark-ready module issues forge commands and this one turns
 * the persisted `prDraft` record into operator prose. They share the record and
 * nothing else, which is the seam.
 *
 * Two rules the renderer carries:
 *
 *  - **The command is the forge's real one.** A known forge renders its actual
 *    CLI (`gh pr ready 42` / `glab mr update 42 --ready`); an unknown one names
 *    BOTH, because an operator with no handoff and no command cannot finish a
 *    cycle the driver stopped.
 *  - **The direction follows the hold, not the status.** #1398: when the hold
 *    came from a failed RE-ARM the advice is the draft command (`--undo`), not
 *    `pr ready` — telling someone to mark ready a PR the driver just failed to
 *    make a draft is the opposite of what the hold asks for.
 *
 * A corrupt persisted status renders, never throws: the handoff is the one place
 * the operator learns what the cycle thinks its PR is.
 */

import { prDraftCmd, prReadyCmd } from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * The handoff comment's lines about the draft (empty when there is nothing to
 * say). `forge` picks the real ready command; unknown, both are named.
 */
export function draftPrHandoffLines(ps: WorkState["pipelineState"], forge?: ForgeType): string[] {
  const draft = ps.prDraft;
  const pr = ps.prNumber;
  if (!draft || pr === undefined) return [];
  const readyCmd =
    forge === "github" || forge === "gitlab"
      ? `\`${prReadyCmd(forge, pr)}\``
      : `\`gh pr ready ${pr}\` (GitHub) or \`glab mr update ${pr} --ready\` (GitLab)`;
  // #1398 round 3 — an absent `status` is a legal record (a disclosure the
  // driver noted on a PR it never opened as a draft). It is not "the review is
  // done and the ready failed", and it is not "the PR is a draft": the driver
  // holds nothing, so it says nothing rather than guessing a heading.
  const status = draft.status ?? "unknown";
  switch (status) {
    case "unknown":
      if (draft.findingsPosted?.length) {
        // The honest line for a disclosure-only record: the findings are on the
        // PR, and the driver never took the PR into a draft hold.
        return [
          "### Review findings were disclosed on the PR",
          "",
          `PR #${pr} carries the disclosure of the review's residual findings (${draft.findingsPosted.length} patch record(s)); the driver never held this PR as a draft, so it did not mark it ready.`,
          "",
        ];
      }
      return [];
    case "ready":
      if (!draft.holdReason) return [];
      return [
        "### Review window was open",
        "",
        `PR #${pr} was opened ready: ${draft.holdReason}. The driver does not convert it back to a draft.`,
        "",
      ];
    case "draft":
      return [
        "### Pull request is still a draft",
        "",
        `PR #${pr} was opened as a draft and stays one: ${draft.holdReason ?? "the driver did not mark it ready"}. Mark it ready with ${readyCmd} once the work is finished.`,
        "",
      ];
    case "ready-failed":
      if (draft.holdReason) {
        // #1398 — when the hold came from the RE-ARM (a draft-direction
        // failure), the operator's fix is the draft direction, not `pr ready`:
        // telling them to mark a PR ready that the driver just failed to make a
        // draft is the opposite of what the hold asks for.
        //
        // #1398 round 3 — a re-arm hold is recognised by its OWN field, not by
        // pattern-matching the prose. `rearmError` is written by `halt()` and by
        // nothing else, so the regex below is the fallback for a state written
        // before the field existed, never the primary signal. With it the
        // "a `pr ready` attempt also failed" clause is omitted entirely: on this
        // path the driver never attempted a ready, and `draft.attempts` /
        // `draft.error` belong to some other attempt — printing them here
        // invented a ready failure and charged the merge for a draft failure.
        const rearm =
          draft.rearmError !== undefined ||
          /draft conversion|back to a draft|draft re-arm/.test(draft.holdReason);
        const undoCmd =
          forge === "github" || forge === "gitlab"
            ? `\`${prDraftCmd(forge, pr)}\``
            : `\`gh pr ready ${pr} --undo\` (GitHub) or \`glab mr update ${pr} --draft\` (GitLab)`;
        const readyTried = draft.error !== undefined || (draft.attempts ?? 0) > 0;
        const triedClause =
          !rearm && readyTried
            ? ` A \`pr ready\` attempt also failed (${draft.attempts ?? 0} attempt(s) this cycle; ${draft.error}).`
            : "";
        const cmd = rearm ? undoCmd : readyCmd;
        const advice = rearm
          ? `The driver could not make it a draft again, so make it one with ${cmd} before the review is trusted.`
          : `Mark it ready with ${cmd} once the work is finished.`;
        return [
          "### Pull request is still a draft",
          "",
          `PR #${pr} stays a draft: ${draft.holdReason}.${triedClause} ${advice}`,
          "",
        ];
      }
      return [
        "### Marking the pull request ready FAILED",
        "",
        `The review is done, but marking PR #${pr} ready failed (${draft.attempts ?? 0} attempt(s) this cycle), so it is still a draft. Reason: ${draft.error ?? "no reason recorded"}`,
        "",
        `Run ${readyCmd} to mark it ready.`,
        "",
      ];
    default: {
      // Compile-time exhaustiveness only. A corrupt persisted status must render,
      // never throw: the handoff is the one place the operator learns the state.
      const _unhandled: never = status;
      return [
        "### Pull request draft state unrecognised",
        "",
        `PR #${pr}: draft state unrecognised: ${String(status)}. Check its draft state and mark it ready with ${readyCmd} once the work is finished.`,
        "",
      ];
    }
  }
}
