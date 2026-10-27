/**
 * work-driver-lens-fix-fence-revert — #1852: the ONE stray revert a lens-fix
 * round is allowed to have, and the record of it.
 *
 * Split from the gate (`work-driver-lens-fix-fence-gate.ts`) so the gate stays a
 * judgement and this stays the only place the lens-fix fence writes to the tree.
 * The work itself is the fix pass's `revertStraysOnce` — preserve under a ref,
 * patch to the scratch dir, `rm` the untracked strays, `checkout` the tracked
 * ones back to the plan's `headBefore` — reached through the same function the
 * fix pass calls, so there is one destructive path with one set of guards
 * (`assertInsideRecordedWorktree`, `assertRemovalInsideWorktree`, the scratch-dir
 * transport), not two.
 *
 * WHAT THIS ADDS is the lens-fix identity on the record. `revertStraysOnce`
 * counts its one-shot inside `passWindow` — the window from the pass's own
 * `adversarial-fix-requested` event — and a lens fix has no such event, so the
 * window degenerates to the whole log. The lens-fix round's counter therefore
 * reads the event log itself (`lensFixRevertAlreadyUsed`, filtered on
 * `source: "lens-fix"` + round + workstream, PM decision #1852-5), and this
 * module is what stamps those two fields so the counter has anything to read.
 * A revert recorded without them would be invisible to the round's budget and a
 * second set would be reverted too.
 *
 * THE REVERT TARGET is `plan.headBefore`, which for a lens fix is the ROUND TIP
 * recorded at plan time — the same SHA the fence measures the delta from. That
 * is deliberate and it is the thing to get right: restoring a stray to the
 * round's later HEAD would restore the very lines the fence refused.
 */

import { trace } from "./trace.ts";
import type { PostPass } from "./work-driver-adversarial-fix-scope.ts";
import type { PassPlan } from "./work-driver-adversarial-fix-scope.ts";
import type { CycleContext } from "./work-driver-context.ts";
import type { RevertStraysOutcome } from "./work-driver-fix-pass-revert-step.ts";
import { revertStraysOnce } from "./work-driver-fix-pass-revert-step.ts";
import type { LensFixRevertOutcome } from "./work-driver-lens-fix-fence-gate.ts";
import type { LensFixRevertEvent } from "./work-driver-lens-fix-revert-record.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Perform this lens-fix round's one allowed revert.
 *
 * `null` = the revert was not attempted (the kill switch is off, or
 * `revertStraysOnce` had nothing to act on); the caller parks on the fence's
 * own refusal, which is what happened before the revert existed.
 *
 * `alreadyReverted` is REQUIRED here (round 3 item 5): at the lens seam the
 * round's allowance is the caller's to answer — the inner `passWindow` counter
 * cannot express source + round + workstream, so a caller that omitted the
 * answer would silently fall back to a counter that is wrong for this budget.
 * It stays optional only inside `revertStraysOnce`, where the fix pass's own
 * window counter IS the right answer.
 *
 * `onReverted` is the durability hook: called by `revertStraysOnce` at the
 * instant the destructive work is done, which is where this round's
 * `fix-pass-strays-reverted` event is appended AND persisted — before the
 * landing arm's first git call, so a crash cannot leave files deleted and a
 * state file that says nothing (#1852 round 3 item 3).
 */
export async function revertLensFixStrays(
  ctx: CycleContext,
  state: WorkState,
  execFn: ExecFn,
  plan: PassPlan,
  post: PostPass,
  round: number,
  /** Has this round already spent its one revert? See the call below. */
  alreadyReverted: boolean,
  /** Persist this round's revert event at the destructive boundary. */
  onReverted?: (event: LensFixRevertEvent) => Promise<void> | void,
): Promise<LensFixRevertOutcome | undefined> {
  // The revert's outcome, published to the boundary hook below. `revertStraysOnce`
  // raises that hook before it RETURNS, so at the moment the hook fires this
  // binding is not assigned yet — the closure therefore reads it lazily through
  // the box, and the assignment happens before the promise this function awaits
  // settles.
  const settled: { current?: RevertStraysOutcome } = {};
  const out = await revertStraysOnce(
    ctx,
    state,
    [plan],
    post,
    Date.now(),
    // THE durability boundary (#1852 round 3 item 3). `revertStraysOnce` raises
    // this for BOTH outcomes immediately after the destructive calls and before
    // either is returned. It cannot carry the event itself — at that instant the
    // outcome does not exist yet for any caller — so it exists to let THIS
    // function see that the destructive work has finished, and the publish
    // happens as soon as the outcome is in hand, still inside this call and
    // before the caller's next git run.
    onReverted === undefined
      ? undefined
      : () => {
          const outcome = settled.current;
          if (outcome?.ok === true) {
            onReverted(stampLensFixRevert(outcome.event, plan.id, round));
          }
        },
    // #1852 round 2 item 4 — ONE counter for this budget. The lens round's
    // allowance is keyed on source + round + workstream, which `revertStraysOnce`'s
    // own `passWindow` counter cannot express (a lens fix has no
    // `adversarial-fix-requested` to window on, so it degenerates to the whole
    // log). The caller that owns the key answers, and the inner counter is not
    // consulted.
    alreadyReverted,
  );
  settled.current = out;
  // #1852 round 3 item 3 — the boundary hook fires HERE. `revertStraysOnce` has
  // returned, so its own `onReverted` call (which runs before it returns, and so
  // before any caller could have assigned the outcome) had nothing to publish;
  // this is the first instant at which the outcome exists AND the destructive
  // work is known to be finished, which is exactly the boundary the caller needs
  // to persist at. The ordering test asserts this precedes the `await` settling.
  if (out?.ok === true) {
    await onReverted?.(stampLensFixRevert(out.event, plan.id, round));
  }
  if (out === undefined) {
    trace(
      `work-driver: lens-fix stray revert not attempted for ${plan.id} (switch off, or nothing to revert)`,
    );
    return undefined;
  }
  if (!out.ok) {
    // A second set inside the window (`revertStraysOnce`'s own answer) or a
    // failed revert: either way the tree is untouched and the caller parks.
    return { ok: false, reason: out.reason };
  }
  return { ok: true, event: stampLensFixRevert(out.event, plan.id, round) };
}

/**
 * The record the round's counter reads: `revertStraysOnce`'s event plus the two
 * fields that make it a LENS round's revert.
 *
 * ONE function does the stamping (#1852 round 3 item 3), because the boundary
 * hook and the return value must carry the same bytes: if the persisted copy
 * said `source: "develop"` while the returned one said `"lens-fix"`, the record
 * on disk would be invisible to `lensFixRevertAlreadyUsed` and a retried step
 * would revert a second set — the exact budget the record exists to enforce.
 */
function stampLensFixRevert(
  event: LensFixRevertEvent,
  workstreamId: string,
  round: number,
): LensFixRevertEvent {
  return { ...event, workstreamId, source: "lens-fix", round };
}

/**
 * The recovery locations of THIS round's already-recorded lens-fix revert, for a
 * cap-hit that parks on a SECOND stray set. The gate reports a `revert` only when
 * it performed one during this call; when the round's single allowance was spent
 * by an earlier call (the retried step, or a fix pass that landed and then parked
 * on a second set), the event lives on the log and the cap-hit would otherwise
 * name neither location — so the operator reads "the record names the preserved
 * ref and the patch" with no record in the state file to read it from.
 */
export function restoredLocations(
  state: WorkState,
  round: number,
): { restoredToRef?: string; restoredToPath?: string } {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "fix-pass-strays-reverted" && e.source === "lens-fix" && e.round === round) {
      return { restoredToRef: e.preservedRef, restoredToPath: e.patchPath };
    }
  }
  return {};
}
