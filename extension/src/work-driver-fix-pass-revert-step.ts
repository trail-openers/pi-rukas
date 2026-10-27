/**
 * work-driver-fix-pass-revert-step — #1846: the fix pass's one-shot revert,
 * decided from state, executed through `work-driver-fix-pass-revert.ts`.
 *
 * Two modules rather than one because the two halves answer different questions
 * and are gated differently: the revert itself (`work-driver-fix-pass-strays.ts`)
 * is pure git work that needs a real repo to test, while this file is the driver
 * policy around it — *whether* a revert is allowed at all, which worktree and
 * head it targets, and what the caller parks on when it declines.
 *
 * The ATTEMPT COUNTER is read from the event log rather than stored on the
 * context: the revert's own `fix-pass-strays-reverted` event is the record that a
 * revert happened, so counting those events makes a SECOND stray set park without
 * any new state to keep in step — and a resumed cycle counts the revert it
 * already performed, which a counter field would have lost.
 */

import { runGit } from "./work-develop-git.ts";
import { defaultExec } from "./work-driver-adversarial-fix-git.ts";
import type { PassPlan, PostPass } from "./work-driver-adversarial-fix-scope.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { correctiveRoundFor, correctiveRoundsOf } from "./work-driver-corrective-admission.ts";
import { revertFixPassStrays } from "./work-driver-fix-pass-strays.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { FixPassStraysRevertedEvent } from "./workflow-state-events-fix-pass-strays.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** What the caller does with the outcome: continue and re-check, park on the
 *  reason, or (when `secondSet`) park on the reason *with* the second-set wording
 *  so the handoff does not tell the operator to revert by hand what the driver
 *  already reverted. `undefined` means a revert is not the right answer at all —
 *  the workstream had no recorded worktree, so there is no tree to revert. */
export type RevertStraysOutcome =
  | { ok: true; event: FixPassStraysRevertedEvent }
  | { ok: false; secondSet: boolean; reason: string };

/**
 * Preserve and revert one stray set, at most once per pass.
 *
 * Only a refusal the fence itself reached is offered here: `postPassFault` omits
 * `straysFor` for a fenced or protected stray, so a file the protected-path gate
 * refused never reaches this module — taking that decision away from the gate is
 * not what a revert is for.
 */
export async function revertStraysOnce(
  ctx: CycleContext,
  state: WorkState,
  plans: readonly PassPlan[],
  post: PostPass,
  now: number,
): Promise<RevertStraysOutcome | undefined> {
  const id = post.straysFor;
  const strays = post.strays;
  if (id === undefined || strays === undefined || strays.length === 0) return undefined;
  const plan = plans.find((p) => p.id === id);
  if (plan === undefined) return undefined;
  if (state.eventLog.some((e) => e.kind === "fix-pass-strays-reverted")) {
    // One stray set per pass is the driver's job; a second is a pass that will
    // not stay inside its fence, and reverting again would be looping on it.
    return {
      ok: false,
      secondSet: true,
      reason: `${id} produced a SECOND set of out-of-fence files after the driver reverted the first (${strays.map((s) => s.file).join(", ")}) — the pass is not staying inside its fence`,
    };
  }
  const result = await revertFixPassStrays({
    git: runGit(ctx.verifyExecFn ?? defaultExec),
    worktree: plan.worktree,
    repoRoot: ctx.repoRoot,
    issue: ctx.issue,
    workstreamId: id,
    // Always the first revert of a pass: the branch above already turned a second
    // attempt into a park, so the `-<n>` suffix on the ref and patch is `1` for
    // every revert this function performs.
    attempt: 1,
    // The revert target is the LATEST head this pass positively recorded, not
    // simply the head the pass started from. A corrective round dispatched inside
    // the pass records the HEAD it found (`headAtRound`, #1698(b)); when one ran,
    // that is the tree to go back to, because reverting to the pre-dispatch head
    // would undo the commits the driver itself ordered. With no round, the pass's
    // own recorded pre-pass head is the only referent — and neither exists, the
    // revert module refuses rather than guessing.
    headBefore: revertTarget(state, id, plans),
    strays: strays.map((s) => s.file),
    untracked: new Set(post.untracked ?? []),
    scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
  });
  if ("reason" in result) return { ok: false, secondSet: false, reason: result.reason };
  return {
    ok: true,
    event: {
      kind: "fix-pass-strays-reverted",
      at: now,
      workstreamId: id,
      paths: result.paths,
      preservedRef: result.preservedRef,
      patchPath: result.patchPath,
    },
  };
}

/**
 * The SHA this pass must revert TO: the latest head the driver positively
 * recorded for this workstream during this pass.
 *
 * Preferred: the HEAD a corrective round dispatched *inside* the pass found
 * (`headAtRound`, #1698(b)) — that round committed work on the driver's own
 * order, so going back past it would undo a commit the driver itself authored.
 * Otherwise: the pass's own pre-pass head, read positively at plan time.
 *
 * Never a guess. `HEAD~1`, `base` or the current HEAD are each a way to delete
 * the pass's real work, so when neither recorded head is a usable SHA this
 * returns `undefined` and `revertFixPassStrays` refuses rather than picking one.
 */
function revertTarget(
  state: WorkState,
  workstreamId: string,
  plans: readonly PassPlan[],
): string | undefined {
  const plan = plans.find((p) => p.id === workstreamId);
  // The pass-scoped window: only rounds dispatched by THIS pass count, so a head
  // an earlier pass recorded cannot become this revert's target.
  const round = correctiveRoundFor(correctiveRoundsOf(passWindow(state)), workstreamId);
  return usable(round?.headAtRound) ?? usable(plan?.headBefore);
}

/** The event-log window this pass produced — everything from its own request
 *  event on. The caller and this module must agree on what "this pass" means,
 *  because both bound their reads (rounds here, strays there) to it. */
export function passWindow(state: WorkState): WorkEvent[] {
  const events = state.eventLog;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind === "adversarial-fix-requested") return events.slice(i);
  }
  return events;
}

/** A recorded head is usable only as a full SHA — the same rule the develop paths
 *  apply (`isValidBaseSha`), so a truncated or empty field never becomes a rev. */
const usable = (sha: string | undefined): string | undefined =>
  sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;

/** The disclosure line the pass's notes and the PR body carry for a revert. A
 *  revert whose ref and patch the operator cannot find is a driver commit that
 *  quietly deleted their fixer's work. */
export function fixPassRevertNote(event: FixPassStraysRevertedEvent): string {
  return `reverted ${event.paths.length} out-of-fence file(s) (${event.paths.join(", ")}) — preserved at ${event.preservedRef}, patch ${event.patchPath}`;
}
