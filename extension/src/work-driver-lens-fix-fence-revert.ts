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
import { revertStraysOnce } from "./work-driver-fix-pass-revert-step.ts";
import type { LensFixRevertOutcome } from "./work-driver-lens-fix-fence-gate.ts";
import type { LensFixFenceSnapshot } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Perform this lens-fix round's one allowed revert.
 *
 * `null` = the revert was not attempted (the kill switch is off, or
 * `revertStraysOnce` had nothing to act on); the caller parks on the fence's
 * own refusal, which is what happened before the revert existed.
 */
export async function revertLensFixStrays(
  ctx: CycleContext,
  state: WorkState,
  execFn: ExecFn,
  plan: PassPlan,
  post: PostPass,
  round: number,
  /** Has this round already spent its one revert? See the call below. */
  alreadyReverted = false,
): Promise<LensFixRevertOutcome | undefined> {
  const out = await revertStraysOnce(
    ctx,
    state,
    [plan],
    post,
    Date.now(),
    undefined,
    // #1852 round 2 item 4 — ONE counter for this budget. The lens round's
    // allowance is keyed on source + round + workstream, which `revertStraysOnce`'s
    // own `passWindow` counter cannot express (a lens fix has no
    // `adversarial-fix-requested` to window on, so it degenerates to the whole
    // log). The caller that owns the key answers, and the inner counter is not
    // consulted.
    alreadyReverted,
  );
  if (out === undefined) {
    trace(
      `work-driver: lens-fix stray revert not attempted for ${plan.id} (switch off, or nothing to revert)`,
    );
    return undefined;
  }
  if (!out.ok) {
    // A second set inside the window (`revertStraysOnce`'s own answer) or a
    // failed revert: either way the tree is untouched and the caller parks.
    //
    // `execFn` is threaded for the call-site contract only: the revert owns its
    // own git transport (`ctx.verifyExecFn ?? argvExecp`), and letting a caller
    // substitute a second one would put a different shell behind the destructive
    // calls than behind the ones the gate guards. It stays in the signature so a
    // reader of the call site sees the same exec every other lens-fix git read uses.
    void execFn;
    return { ok: false, reason: out.reason };
  }
  void execFn;
  return { ok: true, event: { ...out.event, source: "lens-fix", round } };
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

/**
 * The snapshot's round, read where the revert is stamped. A lens fix dispatched
 * in round N and gated in round N+1 must not spend round N+1's allowance, which
 * is why the round travels on the record rather than being read at revert time.
 */
export function lensFixRevertRound(snap: LensFixFenceSnapshot): number {
  return snap.round;
}
