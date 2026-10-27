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
  lensFixFenceRecorded,
  lensFixRevertAlreadyUsed,
} from "./work-driver-lens-fix-fence-gate.ts";
import { revertLensFixStrays } from "./work-driver-lens-fix-fence-revert.ts";
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
  const lensId =
    lensSnap?.workstreamId ??
    Object.keys(psFix.workstreams ?? {}).find((id) => {
      const recorded = psFix.worktrees?.[id];
      return recorded !== undefined && path.resolve(recorded) === path.resolve(lensTree);
    });
  const fenceCheck = await lensFixFenceCheck({
    execFn,
    ctx,
    state,
    snapshot: lensSnap,
    inWorktree: path.resolve(lensTree) !== path.resolve(ctx.repoRoot),
    tree: lensTree,
    round: lensRound,
    // Did this round's lens-fix step actually dispatch a fixer? A round that
    // never did has no fence to be judged against (and a state file from before
    // #1852 never wrote the field), so the gate stands down; a round that did had
    // a fence, and losing it parks. Read from the step's own dispatch markers
    // rather than from `lastCompletedStep`, which a resume can leave pointing
    // here from a previous round.
    // Fail closed only on what the round RECORDS: a fence failure on the log
    // means this round had a fence and lost it. No record at all means an older
    // driver (or a pre-#1852 fixture) wrote the state and the gate does not run
    // — see `lensFixFenceRecorded`.
    fenceRecorded: lensFixFenceRecorded(state.eventLog, lensRound),
    revertAlreadyUsed:
      lensId !== undefined && lensFixRevertAlreadyUsed(state.eventLog, lensRound, lensId),
    onRevertible:
      lensId === undefined || lensSnap === undefined
        ? undefined
        : (post, plan): Promise<LensFixRevertOutcome | undefined> =>
            revertLensFixStrays(ctx, state, execFn, plan, post, lensRound),
  });
  if (!fenceCheck.ok) {
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
    });
    return park({ ...out, pipelineState: { ...out.pipelineState, currentStep: "handoff" } });
  }
  for (const note of fenceCheck.notes) trace(`work-driver: lens-fix fence · ${note}`);
  // #1852 review round 2 — a revert the gate PERFORMED is recorded here, BEFORE
  // any landing arm runs. The refusal path above already rides the event's
  // ref/patch onto the cap-hit; the `ok: true` path used to drop it, so the round
  // landed with a driver commit that had deleted the fixer's out-of-fence files,
  // no disclosure of the preserved ref or patch, and — because
  // `lensFixRevertAlreadyUsed` reads the event log — a retried adversarial step
  // that reverted a SECOND set in the same round. Persisted now rather than at
  // the next boundary: the calls after this one are the destructive ones, and a
  // crash between the revert and its record is the window this closes.
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
