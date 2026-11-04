/**
 * adversarial-phase — one inner child of the adversarial loop (a review or a
 * fix dispatch): dispatch-deck lifecycle, the slow-run watch (#799, #907), and
 * the orchestrator's active-child bookkeeping so dispatch_peek / dispatch_steer
 * reach the running child.
 *
 * Split out of adversarial.ts (500-line cap). The loop calls the returned
 * `runPhase` for every review and fix dispatch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adversarialSkillPath } from "./adversarial-skill-path.ts";
import { childHandles, registerChildHandle } from "./async-jobs-registry.ts";
import { setOrchestratorActiveChild } from "./async-jobs.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { type SteerSource, steerChild } from "./dispatch-steer.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import type { RunningState } from "./progress.ts";
import { adversarialChildBoundMs, isReviewerRole } from "./review-bounds.ts";
import { type OnSlowCallback, feedSlowProgress, watchSlowDispatch } from "./slow-notice.ts";
import { spawnSpecialist } from "./spawn.ts";
import type { DispatchResult } from "./types.ts";

export type RunPhase = (
  role: "adversarial-developer" | "developer",
  tag: string,
  prompt: string,
  cwd?: string,
) => Promise<DispatchResult>;

/** `makeRunPhase`'s options, declared apart so the function below is the flow. */
export type RunPhaseOpts = {
  runId: string;
  signal: AbortSignal;
  orchestratorJobId: string;
  /** #1024 — headless only: each inner child leads its own process group. */
  processGroup?: boolean;
  /** #1666 — a headless /work cycle's inner children run under trust. */
  workCycleTrust?: boolean;
  /** #799 — the slow-run recorder for this loop's inner children. */
  onSlow?: OnSlowCallback;
  /** The parent pi for the slow-run watch (the PM notice half). */
  pi?: ExtensionAPI;
  /**
   * #1978 — the step's budget arms, the three fields of `AdversarialLoopParams`
   * with these same names, forwarded verbatim by the loop. Read ONLY inside the
   * reviewer branch, so the fix-pass arm takes none of them: `childBoundMs` can
   * only tighten `adversarialChildBoundMs()`, `budgetSignal` joins the reviewer
   * child's abort, and `onProgress` composes with the deck / slow-run feed.
   * `budgetSignal` is named apart from {@link RunPhaseOpts.signal} because the
   * loop's own abort and the step's budget arms are two different clocks.
   */
  childBoundMs?: number;
  budgetSignal?: AbortSignal;
  onProgress?: (state: RunningState) => void;
};

/**
 * Run one phase, threading dispatch-deck lifecycle and onProgress so the deck
 * shows whichever phase is running now. Also registers the inner spawn as the
 * orchestrator's `activeChild` so PM can `dispatch_peek` / `dispatch_steer`
 * against the loop's jobId and reach the currently-running inner child.
 */
export function makeRunPhase(opts: RunPhaseOpts): RunPhase {
  const {
    runId,
    signal,
    orchestratorJobId,
    processGroup,
    workCycleTrust,
    childBoundMs: budgetChildBoundMs,
    budgetSignal,
    onProgress: onBudgetProgress,
  } = opts;
  return async (role, tag, prompt, cwd) => {
    const deckKey = `${runId}/${tag}`;
    const label = `${role}[${tag}]`;
    dispatchDeck.startEntry(deckKey, { label, role, tag });
    // #799 — the slow-run watch for this inner child: the deck key is the id
    // dispatch_peek shows, and it is what the PM notice names. The parent pi
    // is threaded so the notice reaches the PM (the watch site has no pi).
    // #907 — the CI-wait span feed for this inner child: the watch chains
    // its span tracker in front of the raw-event hook the spawn receives.
    const slowRaw: (event: PiJsonEvent) => void = () => {};
    const stopSlow = watchSlowDispatch({
      id: deckKey,
      role,
      label,
      ...(opts.onSlow ? { onSlow: opts.onSlow } : {}),
      ...(opts.pi ? { pi: opts.pi } : {}),
      onRawEvent: slowRaw,
      // #1827 ordering — once a killing bound has armed for this child, the
      // slow-run watch stops steering it. The flag is set by the spawn through
      // the `onBoundArmed` seam below; the watch is created first, so it reads
      // the closure rather than a snapshot.
      boundArmed: () => boundArmed,
    });
    // This child's own abort, so dispatch_kill <deckKey> can stop a hung
    // round — the driver passes a loop signal that nothing ever aborts.
    const kill = new AbortController();
    // #1978 — the step's budget abort ends THIS child too: `armBudget`'s turns /
    // tokens hook aborts its own controller, and without this listener that
    // abort reached nothing, which is the half of the bug that let a reviewer
    // run past `budgets.review.turns`.
    //
    // A budget that had ALREADY fired buys no reviewer child at all. The child
    // would see a signal aborted before it started, and an aborted child can
    // still come back `ok:true` carrying the verdict it had already printed —
    // so the gate read "no kill cause, VERDICT: APPROVED" as a clean pass and
    // merged a head the operator's ceiling had stopped.
    //
    // The refusal lives HERE and not as a pre-dispatch `break` in the loop, and
    // `ok:false` with a cause is what makes the false approval impossible: the
    // loop's break falls through to the exhausted-rounds tail, which speaks
    // `rejected` with the previous round's findings — a verdict nobody spoke,
    // which the gate routes into a fix wave. A returned kill cause travels
    // through the SAME shape a real kill travels: `failedByKill` refuses the
    // child's verdict, the loop's classifier ends the round, and the step names
    // the lever. `child-bound` is the cause the step's arms read as a minutes
    // breach; the turns / tokens levers, which leave no cause of their own, are
    // covered by the fallback in `armBudget`'s reader.
    const budgetAlreadyFired = budgetSignal?.aborted === true;
    const onBudgetAbort = () => kill.abort();
    if (budgetAlreadyFired) kill.abort();
    else budgetSignal?.addEventListener("abort", onBudgetAbort, { once: true });
    // #1827 — set true by the spawn the first time one of the reviewer's
    // killing bounds (the re-read kill, the post-verdict stop) arms.
    let boundArmed = false;
    const onLoopAbort = () => kill.abort();
    if (signal.aborted) kill.abort();
    else signal.addEventListener("abort", onLoopAbort, { once: true });
    try {
      // #1827 — the reviewer child is bounded; the fix pass is not. Before this,
      // neither `childBoundMs` nor `onSteer` reached either inner child, so the
      // only thing that ended a runaway reviewer was the 2-h spawn backstop —
      // measured at 476 turns / 80M tokens on one round. `childBoundMs` alone
      // is not enough: `armChildBound` writes its wrap-up steer straight to
      // `stdin` when no `onSteer` is given, so the pair is what makes the bound
      // observable in the lifecycle. The bound clamps to the cycle deadline
      // inside `armChildBound`, as every sibling bound does.
      const reviewer = isReviewerRole(role);
      if (reviewer && budgetAlreadyFired) {
        // The shape `spawn.ts` leaves on a child the caller's clock ended: no
        // output, no exit (nothing ran), and the cause the step's budget reader
        // consults. `ok` is false by `failedByKill`'s own rule.
        return {
          role,
          ok: false,
          text: "",
          toolUses: [],
          ms: 0,
          exitCode: null,
          killCause: "child-bound",
        };
      }
      return await spawnSpecialist(
        { role, prompt, cwd },
        {
          signal: kill.signal,
          processGroup,
          workCycleTrust,
          runId,
          tag,
          ...(reviewer
            ? {
                // #1978 — a budget may only TIGHTEN the wall clock, never lengthen
                // it: the operator's knob stays the single source of the default.
                childBoundMs: Math.min(
                  budgetChildBoundMs ?? Number.POSITIVE_INFINITY,
                  adversarialChildBoundMs(),
                ),
                // #1827 round 4 — OPT IN to the post-verdict stop: only this
                // dispatch speaks the `VERDICT_STATUSES` protocol (the plan gap
                // gate spawns the same role with `READY / NEEDS_ITERATION`). Set
                // beside the skill path so the bound and the protocol it reads
                // cannot drift apart from the caller.
                verdictStop: true,
                // The bound's wrap-up steer and the re-read cap's steer both
                // reach this child through the driver's steer seam (dispatch.ts
                // pairs the two for exactly this reason).
                onSteer: (message: string, source: SteerSource) => {
                  // The delivery answer is what lets a steer that could not land
                  // be retried rather than counted as said (#1991).
                  return steerChild(orchestratorJobId, message, source).delivered;
                },
                onBoundArmed: () => {
                  boundArmed = true;
                },
                // #1827 — the path to the reviewer's OWN skill, so the re-read
                // cap counts reads of that SKILL.md and no other skill file.
                // Derived here (not passed in) so the cap and the path it counts
                // cannot drift apart, and so the loop's call site is unchanged.
                reviewSkillPath: adversarialSkillPath(),
              }
            : {}),
          onProgress: (state) => {
            dispatchDeck.updateEntry(deckKey, state);
            feedSlowProgress(deckKey, state);
            // #1978 — COMPOSED, not substituted: the deck row and the slow-run
            // watch read this same feed, so replacing it with the budget's hook
            // would silently lose both while arming the turns/tokens lever.
            onBudgetProgress?.(state);
          },
          onRawEvent: stopSlow.onRawEvent ?? slowRaw,
          onStdin: (stdin) => {
            // Publish this inner spawn as the orchestrator's active child so
            // PM's peek/steer calls against the orchestrator jobId resolve
            // to this stdin. Updated on each round; cleared in the finally.
            setOrchestratorActiveChild(orchestratorJobId, {
              role,
              label,
              deckKey,
              stdin,
            });
            // #799 — also registered under the deck key (steer from the peek id).
            registerChildHandle(deckKey, stdin, label, role, () => kill.abort());
          },
        },
      );
    } finally {
      signal.removeEventListener("abort", onLoopAbort);
      budgetSignal?.removeEventListener("abort", onBudgetAbort);
      stopSlow.stop();
      dispatchDeck.clearEntry(deckKey);
      childHandles.delete(deckKey);
      setOrchestratorActiveChild(orchestratorJobId, null);
    }
  };
}
