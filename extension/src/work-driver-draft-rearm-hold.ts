/**
 * work-driver-draft-rearm-hold — the two records a draft re-arm leaves behind
 * when it could not do its job: the plumb-report row that reaches the handoff,
 * and the cap-hit + `prDraft` hold that stops the cycle.
 *
 * Split from `work-driver-draft-rearm.ts` for the §12 500-line cap. The seam is
 * "decides" vs "records": the re-arm module asks the forge and chooses a
 * decision; everything in here takes that decision's `reason` and writes the
 * pair of artefacts the operator and the router read. They are kept together
 * because they are always written together and must carry the same string — a
 * hold whose `holdReason` and cap `evidence` disagree is the #1398 class of bug
 * in miniature.
 *
 * Both writers append, so both are tail-sensitive: `nextStep()` routes on the
 * LAST event, which is why the re-arm calls `declineUndisclosedRearm()` BEFORE
 * `halt()` rather than after (docs/troubleshooting.md → tail-invariance).
 */

import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { withPrDraft } from "./work-driver-draft-pr.ts";
import type { RearmOutcome } from "./work-driver-draft-rearm.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * The cap a failed re-arm records. Exported from the re-arm module's public
 * surface (it re-exports this) so the router, the explainer and the tests name
 * the same string the writer writes — the same discipline `REVIEW_INCOMPLETE_CAP`
 * enforces on the lens cap.
 */
export const DRAFT_REARM_CAP = "draft-rearm-failed";

/**
 * Record a decline the driver could not act on, so it reaches the handoff.
 *
 * `plumbReports` is the field the handoff renderers read (an event alone is not
 * rendered), and the event is appended too so `/work-status` shows it.
 *
 * #1398 round 3 — a body already recorded verbatim is not recorded twice. The
 * lens step can ask the same question twice in one cycle (a resume replays the
 * entry, and the forge-undetectable decline fires on each), and the renderers
 * print one paragraph per row, so an identical second row is not more
 * information — it reads as two distinct problems. Keyed on step + role + body:
 * two declines with different reasons for the same step are two facts and both
 * stay. The event log is consulted as well as the field, because the event is
 * what `appendEvent` guarantees survives a resume.
 */
export function declineUndisclosedRearm(
  state: WorkState,
  now: number,
  opts: { reason: string },
): WorkState {
  const pr = state.pipelineState.prNumber ?? "<N>";
  const body =
    `Draft re-arm declined: ${opts.reason}. The PR may be mergeable while the review runs — ` +
    `check it (\`gh pr view ${pr} --json isDraft\`) and make it a draft by hand if it is not.`;
  const existing = state.pipelineState.plumbReports ?? [];
  const said =
    existing.some((r) => r.step === "lens-review" && r.role === "driver" && r.body === body) ||
    state.eventLog.some(
      (e) =>
        e.kind === "plumb-report" &&
        e.step === "lens-review" &&
        e.role === "driver" &&
        e.body === body,
    );
  if (said) return state;
  const withEvent = appendEvent(state, {
    kind: "plumb-report",
    at: now,
    step: "lens-review",
    role: "driver",
    body,
  });
  return {
    ...withEvent,
    pipelineState: {
      ...withEvent.pipelineState,
      plumbReports: [...existing, { step: "lens-review", role: "driver", body, at: now }],
    },
  };
}

/**
 * The halt a failed re-arm produces, in `runMerged`'s draft-hold shape: the
 * reason on `evidence` (the handoff prints it) and on `prDraft.holdReason` (so
 * `draftPrHandoffLines` says the PR is a draft and why). The cap routes to
 * `handoff`, so the cycle never advances to `ci` on this failure.
 */
export function rearmHold(
  ctx: DriverContext,
  state: WorkState,
  now: number,
  opts: { reason: string },
): RearmOutcome {
  trace(`work-driver: the draft re-arm halted the cycle — ${opts.reason}`);
  const draft = state.pipelineState.prDraft;
  // #1398 round 3 — the re-arm's reason goes on `rearmError`, never on `error`.
  // `error` is the `pr ready` record, and both renderers that read it say "a
  // `pr ready` attempt also failed" — which is a true statement about a failed
  // ready and a false one about a re-arm, and told the operator the driver had
  // been trying to make the PR mergeable when it had been trying to make it a
  // draft. The forge command here issues no `pr ready` at all.
  const held = withPrDraft(state, {
    ...(draft ?? { status: "draft" as const }),
    status: "ready-failed" as const,
    holdReason: opts.reason,
    rearmError: opts.reason,
  });
  return {
    state: appendEvent(held, {
      kind: "cap-hit",
      at: now,
      cap: DRAFT_REARM_CAP,
      reviewRound: state.pipelineState.reviewRound,
      evidence: opts.reason,
      nextStep: "handoff",
    }),
    decision: { halted: true, reason: opts.reason },
  };
}
