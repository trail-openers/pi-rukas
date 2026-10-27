/**
 * work-driver-adversarial-lens-land — #1852: the lens-fix landing arms, and the
 * scope fence that gates them.
 *
 * Extracted from `work-driver-adversarial.ts` for the 500-line cap. It is the
 * whole `lastCompletedStep === "lens-fix"` branch of Step 5: the fence runs once,
 * before ANY arm, and then one of the landing arms commits and pushes.
 *
 * THE ONE CHOKE POINT is what makes this safe to lift out. Every lens-fix push in
 * the driver is reached from this branch — the worktree arm, the repoRoot arm,
 * the no-committed-fix re-land, and the bound-kill conversion (which routes back
 * through the same step) — so one check here fences the step and no arm needs to
 * know the fence exists. Moving the branch must not move that property: the
 * caller still calls this exactly once, on the same predicate.
 *
 * THE FENCE JUDGES THE ROUND; THE RECORD MAKES THE REVERT VISIBLE. When the fence
 * reverts one out-of-fence set and the re-judged delta comes back clean, the
 * round is allowed to land — and `recordLensFixRevert` appends the revert event
 * and PERSISTS it before the first destructive call, so the operator can find the
 * deleted content and a retried step cannot spend the round's one revert twice
 * (#1852 review round 2).
 *
 * `Outcome` is the discriminated answer the caller needs: `parked` means this
 * handler already appended the terminal event and the caller returns the state;
 * `continued` means the arms ran (or there was nothing to land) and the caller
 * falls through to the rest of Step 5's tail.
 */

import path from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { integrateLensFix } from "./work-driver-adversarial-lensfix.ts";
import { handleNoCommittedFix as handleNoCommittedFixBranch } from "./work-driver-adversarial-lensfix.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { repoRootOriginalRef } from "./work-driver-lens-fix-commit.ts";
import {
  type LensFixRevertOutcome,
  lensFixFenceCheck,
  lensFixRevertAlreadyUsed,
  lensFixWorkstreamId,
} from "./work-driver-lens-fix-fence-gate.ts";
import { restoredLocations, revertLensFixStrays } from "./work-driver-lens-fix-fence-revert.ts";
import { recordLensFixRevert } from "./work-driver-lens-fix-revert-record.ts";
import { lensWorktree } from "./work-driver-lens-fix.ts";
import { commitLensFixChanges } from "./work-driver-lens.ts";
import { runNetGit } from "./work-driver-net-git.ts";
import { endIfPrGone } from "./work-driver-pr-gone.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * `parked` — the fence (or a landing-arm failure) ended the round; the caller
 * returns this state. `continued` — the arms ran, or there was nothing to land;
 * the caller keeps going with this state.
 */
export type LensLandOutcome =
  | { kind: "parked"; state: WorkState }
  | { kind: "continued"; state: WorkState };

/**
 * Gate this lens-fix round's delta and land the fix. Called once, from Step 5,
 * when the approval followed a lens-fix round.
 */
export async function landLensFix(
  ctx: CycleContext,
  state: WorkState,
  next: WorkState,
): Promise<LensLandOutcome> {
  const park = (s: WorkState): LensLandOutcome => ({ kind: "parked", state: s });
  const keep = (s: WorkState): LensLandOutcome => ({ kind: "continued", state: s });

  // The fix is pushed below; a PR merged or closed during the fix pass must not
  // receive it (work-driver-pr-gone.ts).
  const gate = await endIfPrGone(ctx, next, "adversarial");
  if (gate.ended) return park(gate.ended);
  let out = gate.state;
  const execFn = ctx.verifyExecFn ?? execp;
  const psFix: PipelineState = state.pipelineState;

  // #1852 — THE LENS-FIX SCOPE FENCE, run once here, before ANY of the landing
  // arms. It reads the fence the fixer's PROMPT printed (`lensFixFence`, recorded
  // at dispatch time) and measures the round's delta from the round tip recorded
  // beside it — never a fresh HEAD.
  const lensTree = lensWorktree(ctx, state);
  const lensSnap = psFix.lensFixFence;
  const lensRound = state.pipelineState.reviewRound;
  // The fence judges the round against one workstream's fence; the id is the key
  // the revert record, its allowance and the revert note all carry.
  const lensId = lensFixWorkstreamId(lensSnap, psFix, lensTree);
  // The persist issued at the revert's destructive boundary (#1852 round 3 item
  // 3). Awaiting it is what makes the write durable before the landing arm runs;
  // undefined means no revert happened, so nothing was issued.
  let revertEventPersisted: Promise<void> | undefined;
  // #1852 round 3 item 5 — `lensId` is the key the revert record, its one-revert
  // allowance and the revert note all carry. `lensFixRevertAlreadyUsed` matches
  // on it exactly, so a fallback `"default"` would ask the counter about a
  // workstream this round does not belong to: it would answer "not spent", the
  // revert would run, and its record would be stamped with an id no reader can
  // match — the round's single allowance would then be unenforceable. With no id
  // there is no revertible round: `onRevertible` stays undefined and the gate
  // parks on "the driver could not revert".
  const revertible = lensId === undefined ? undefined : lensId;
  const fenceCheck = await lensFixFenceCheck({
    execFn,
    ctx,
    state,
    snapshot: lensSnap,
    inWorktree: path.resolve(lensTree) !== path.resolve(ctx.repoRoot),
    tree: lensTree,
    round: lensRound,
    // #1852 round 2 MEDIUM — `fenceRecorded` and `revertAlreadyUsed` are read
    // from the state inside the gate: they are facts about the log and the
    // round, and a caller that passed them could pass a different round's answer.
    onRevertible:
      revertible === undefined || lensSnap === undefined
        ? undefined
        : (post, plan): Promise<LensFixRevertOutcome | undefined> =>
            revertLensFixStrays(
              ctx,
              state,
              execFn,
              plan,
              post,
              lensRound,
              // The revert asks its owner whether the allowance is spent, and the
              // gate answers from the same log and round (#1852 round 2 item 4:
              // one counter, not two that can disagree).
              lensFixRevertAlreadyUsed(state.eventLog, lensRound, revertible),
              // #1852 round 3 item 3 — the record is made durable at the
              // DESTRUCTIVE boundary, not after the call. `revertStraysOnce` raises
              // this hook the instant the preserve/patch/rm/checkout work has run
              // and before it returns the outcome, so a kill in the window between
              // "files are gone" and "the state says so" cannot happen: the
              // landing arm's own destructive calls come after this promise, and
              // by then the event is on disk. `recordLensFixRevert` below still
              // writes the operator's plumb note; it no longer appends the event
              // twice (it skips when the log already carries this round's record).
              (event) => {
                revertEventPersisted = persistCycle(ctx, appendEvent(out, event));
              },
            ),
  });
  if (!fenceCheck.ok) {
    // #1852 round 3 — the revert's record is durable on the REFUSAL path too.
    // The boundary hook ISSUED the write inside `onRevertible`; only this arm
    // used to skip the await, so a round that reverted one set and was then
    // refused for a SECOND one built its cap-hit and persisted a state that
    // could still lack the revert event — and an error in that write vanished
    // into an unhandled rejection. Awaiting here makes the record durable BEFORE
    // the cap-hit is built, so the state file always carries the revert the tree
    // already lost (`test-lens-fix-fence-landing-revert.ts`), and any failure in
    // it surfaces instead of disappearing.
    await revertEventPersisted;
    trace(
      `work-driver: lens-fix fence parked the round before landing — ${fenceCheck.reason.slice(0, 200)}`,
    );
    // Same shape as the #981 reposition park (`parkLensFixReposition`): one
    // cap-hit the router routes to the handoff, `lensWorktreePath` naming the
    // tree the operator must open, and the revert's preserved ref / patch riding
    // on `restoredToRef`/`restoredToPath` when the driver reverted a first set
    // before refusing this second one.
    out = appendEvent(out, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "lens-fix-scope",
      reviewRound: lensRound,
      nextStep: "handoff",
      evidence: fenceCheck.reason,
      lensWorktreePath: lensTree,
      ...(fenceCheck.revert
        ? {
            restoredToRef: fenceCheck.revert.preservedRef,
            restoredToPath: fenceCheck.revert.patchPath,
          }
        : {}),
      // #1852 round 2 — when this round's OWN revert is the one on the log
      // (the counter found it, so the gate refused the second set), the cap-hit
      // is built before `recordLensFixRevert` runs and carries no revert of its
      // own. Fall back to the round's recorded revert so the handoff still names
      // where that content survives.
      ...(fenceCheck.revert === undefined ? restoredLocations(state, lensRound) : {}),
    });
    out = { ...out, pipelineState: { ...out.pipelineState, currentStep: "handoff" } };
    // #1852 round 3 item 4 — persisted BEFORE the return. Every other park in
    // this step persists (`parkLensFixReposition`, and the revert record above):
    // a cap-hit that lives only in the returned state is lost if the process
    // dies on the way back, and the resume then finds a `lens-fix` round with no
    // cap on its log — which is the state the router reads as "nothing stopped
    // here, run the landing arms again".
    void revertEventPersisted;
    await persistCycle(ctx, out);
    return park(out);
  }
  for (const note of fenceCheck.notes) trace(`work-driver: lens-fix fence · ${note}`);
  // The persist the revert's boundary hook issued (#1852 round 3 item 3) is
  // awaited HERE — before the first landing arm, whose git calls are the next
  // destructive thing in this step. `revertStraysOnce` fires the hook synchronously
  // before it returns, so by this point the write has been issued; awaiting it is
  // what makes the bytes durable rather than merely promised. `persistCycle`
  // serialises through a per-file promise chain, so a later writer cannot overtake
  // it and this await is not optional bookkeeping.
  await revertEventPersisted;
  // #1852 review round 2 — a revert the gate PERFORMED is recorded here, BEFORE
  // any landing arm runs. The refusal path above already rides the event's
  // ref/patch onto the cap-hit; the `ok: true` path used to drop it, so the round
  // landed with a driver commit that had deleted the fixer's out-of-fence files,
  // no disclosure of the preserved ref or patch, and — because
  // `lensFixRevertAlreadyUsed` reads the event log — a retried adversarial step
  // that reverted a SECOND set in the same round. The EVENT itself is now written
  // at the revert's own destructive boundary (the `onReverted` hook above,
  // #1852 round 3 item 3); what remains here is the operator's plumb note and the
  // state it is appended to, and `recordLensFixRevert` does not append an event
  // the log already carries.
  out = await recordLensFixRevert(
    out,
    { round: lensRound, workstreamId: lensId, revert: fenceCheck.revert },
    (st) => persistCycle(ctx, st),
    Date.now(),
  );

  const fixWorktrees = psFix.worktrees ?? {};
  const inWorktree = Object.values(fixWorktrees).some(
    (p) => path.resolve(p) !== path.resolve(ctx.repoRoot),
  );
  const result = inWorktree
    ? await integrateLensFix(execFn, ctx, psFix, fixWorktrees)
    : await commitLensFixChanges(ctx.repoRoot, psFix.reviewRound, execFn);
  if (!result.committed) {
    const fixTree = inWorktree ? lensWorktree(ctx, state) : ctx.repoRoot;
    if (result.error) {
      // #797 — state the repoRoot condition either way.
      const preIntegrationRef = await repoRootOriginalRef(execFn, ctx.repoRoot);
      const rootCondition = result.error.includes("repoRoot was restored")
        ? "repoRoot was restored to the pre-integration ref (verified)"
        : result.error.includes("repoRoot was NOT restored")
          ? "repoRoot was NOT restored — manual repair required"
          : inWorktree
            ? `repoRoot restored to ${preIntegrationRef ?? "the pre-integration ref"} (integrate() claims the restore in its error text)`
            : `repoRoot unchanged (N=1 commit path never moves the checkout)${preIntegrationRef ? ` — on ${preIntegrationRef}` : ""}`;
      out = {
        ...out,
        pipelineState: {
          ...out.pipelineState,
          plumbReports: [
            ...(out.pipelineState.plumbReports ?? []),
            {
              step: "adversarial",
              role: "driver",
              body: `lens-fix: a diff existed but staging or integration failed (${result.error}) — worktree inspected: ${fixTree}. ${rootCondition}`,
              at: Date.now(),
            },
          ],
        },
      };
      out = appendEvent(out, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "lens-fix-not-integrated",
        reviewRound: psFix.reviewRound,
        nextStep: "handoff",
        lensWorktreePath: fixTree,
        restoredToRef: preIntegrationRef,
        evidence: `${result.error} ${rootCondition}`,
      });
      trace(`work-driver: lens-fix integration failed — ${result.error}`);
      return park(out);
    }
    const handled = await handleNoCommittedFixBranch(execFn, ctx, psFix, fixTree, result, out);
    if (handled !== null) return park(handled);
  }
  if (result.committed && !result.pushed) {
    try {
      await runNetGit(execFn, "git push origin HEAD -q", { cwd: ctx.repoRoot });
    } catch (err) {
      // #1095: a timeout is non-blocking too, and its message names the cause
      // ("network git timed out"). The fix is then not on the PR, and the
      // plumbReport below is where the operator sees it.
      const errMsg = `lens-fix push failed (non-blocking): ${(err as Error).message?.slice(0, 200)}`;
      trace(`work-driver: ${errMsg}`);
      out = {
        ...out,
        pipelineState: {
          ...out.pipelineState,
          plumbReports: [
            ...(out.pipelineState.plumbReports ?? []),
            { step: "adversarial", role: "driver", body: errMsg, at: Date.now() },
          ],
        },
      };
    }
  }
  return keep(out);
}

// The no-committed-fix re-land is owned by work-driver-adversarial-lensfix.ts;
// the alias above keeps this module's arms reading one import list.
