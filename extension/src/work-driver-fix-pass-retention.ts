/**
 * work-driver-fix-pass-retention — the tail of the adversarial fix pass: the
 * disclosures and the origin/main comment-retention check that decide whether a
 * green develop pass is cleared.
 *
 * Its own module because the two halves answer different questions and read
 * different things. `work-driver-adversarial-fix.ts` owns the event-log reads,
 * the round interpretation and the dispatch of the pass itself; this file runs
 * only after the develop gates and the stray rewind are settled, and reads only
 * the diffs and admissions those produced. The seam is the one the AGENTS.md §12
 * size gate asks for, and it is a real one: nothing here dispatches a child.
 */

import { neutraliseEvidence, roundComments } from "./comment-evidence.ts";
import { commentRetentionEnabled } from "./comment-retention.ts";
import { trace } from "./trace.ts";
import type { PassPlan, PostPass } from "./work-driver-adversarial-fix-scope.ts";
import { noteFixPass, parkFixPass } from "./work-driver-adversarial-plumb.ts";
import type { PendingFix } from "./work-driver-adversarial-types.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * The disclosure notes and the comment-retention gate for a fix pass whose
 * develop gates and stray handling are already resolved.
 *
 * Every park here reads `afterRevert` — the state that carries the rewind
 * record when the driver performed one — so the record is visible on every
 * handoff this function can produce.
 */
export async function runFixPassRetention(
  ctx: CycleContext,
  afterRevert: WorkState,
  pending: PendingFix[],
  plans: readonly PassPlan[],
  post: PostPass,
  cleared: PostPass,
  now: number,
): Promise<WorkState> {
  let kept = afterRevert;
  // #1725 round 3 — one disclosure note per spec-slot admission made during
  // this pass. An authorisation that only reached PI_ENSEMBLE_DEBUG is a
  // fence that widened invisibly; these notes ride the state to the PR body,
  // where the develop gate's own admission notes already surface.
  for (const admission of cleared.admissions) kept = noteFixPass(kept, admission, now);
  if (!commentRetentionEnabled()) {
    const note =
      "comment retention NOT CHECKED (PI_ENSEMBLE_COMMENT_RETENTION=0) — the pass proceeded without the origin/main comment check";
    trace(`work-driver: ${note}`);
    kept = noteFixPass(kept, note, now);
  } else {
    for (const p of plans) {
      const read = (diff: string) =>
        roundComments(diff, undefined, p.worktree, verifyTimeoutMs(), ctx.verifyExecFn);
      // #1846 PM decision 6 — the retention read is the POST-REVERT diff: a
      // comment line inside a reverted stray is no longer part of the pass, and
      // judging the pass on content it no longer contains would park it for a
      // removal the driver itself just reverted.
      const lost = await read(cleared.diffs[p.id] ?? "");
      // A lost line whose hunk adds a comment was reworded or replaced. That is
      // the reviewers' call (#1056) and the next review round lists it; only a
      // comment dropped with nothing written in its place can park.
      const dropped = lost.ok ? lost.lost.filter((l) => l.addedNearby.length === 0) : [];
      // The diff is against the base, so it also carries what earlier passes
      // removed: the pre-pass diff, read at the same head, tells those apart.
      const prior = dropped.length > 0 ? await read(p.before.diff) : lost;
      // A check that could not run reads NOT CHECKED, never silence (AGENTS.md §7 principle 2).
      if (!lost.ok || !prior.ok) {
        // #1760 — the admissions this pass made are disclosed on this park too,
        // not only on the green path: a park that shows the refusals and hides
        // the authorisations reads as a fence that never widened.
        return parkFixPass(
          afterRevert,
          pending,
          `comment retention could not be checked for ${p.id} (NOT CHECKED) — the fix pass is not cleared`,
          now,
          post.admissions,
        );
      }
      const before = new Set(prior.lost.map((l) => `${l.file}\n${l.text}`));
      const fresh = dropped.filter((l) => !before.has(`${l.file}\n${l.text}`));
      if (fresh.length > 0) {
        const named = fresh.slice(0, 3).map((l) => neutraliseEvidence(`${l.file}: ${l.text}`));
        return parkFixPass(
          afterRevert,
          pending,
          `the fix pass removed ${fresh.length} origin/main comment line(s) in ${p.id} and wrote no comment in their place (${named.join(" | ")})`,
          now,
          post.admissions,
        );
      }
    }
  }
  const applied: WorkEvent[] = pending.map((p) => ({
    kind: "adversarial-fix-applied" as const,
    at: Date.now(),
    workstreamId: p.workstreamId,
    round: p.round,
    headBefore: plans.find((x) => x.id === p.workstreamId)?.headBefore,
  }));
  return appendEvent(kept, ...applied);
}
