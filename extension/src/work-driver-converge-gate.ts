/**
 * work-driver-converge-gate — the end-of-develop converge gate handler
 * (issue #741, P2). The DRIVER-side glue that wires the converge verdict
 * into the state machine.
 *
 * Classification (work-driver-converge.ts) is deterministic path presence
 * over the end-of-develop diff; this handler owns the ROUTING the issue
 * specifies:
 *
 *   - first absent set  → exactly one corrective developer re-dispatch
 *     naming the missing deliverables (the plan-quality one-shot pattern:
 *     a bounded corrective dispatch, never a loop); the safety net +
 *     verify gate + converge pass all re-run once on the new diff.
 *   - second absent set → cap-hit `develop-incomplete-deliverables` (a
 *     DISTINCT cap, not a reuse of verify-failed) → handoff.
 *   - partial only      → recorded on `pipelineState.convergeEvidence` and
 *     surfaced in the handoff/PR body as a WARNING; it never blocks (the
 *     58.9% figure counts partials as the upper bound — blocking on
 *     partials is a policy decision the issue defers to review).
 *
 * Escape hatch: PI_ENSEMBLE_CONVERGE=0 (checked in runConvergeGate).
 */

import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  type ConvergeVerdict,
  buildConvergeCorrectivePrompt,
  runConvergeGate,
} from "./work-driver-converge.ts";
import { applySafetyNet } from "./work-driver-safety-net.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Run the converge gate at end-of-develop, after the existing verify gate
 * has passed. Returns the (possibly mutated) state.
 */
export async function runConvergeGateHandler(
  ctx: DriverContext,
  state: WorkState,
  dispatchFn: NonNullable<DriverContext["dispatchFn"]>,
): Promise<WorkState> {
  let next = state;

  const recordConverge = (verdict: ConvergeVerdict) => {
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        convergeEvidence: {
          at: Date.now(),
          deliverables: verdict.deliverables.map((d) => ({
            id: d.id,
            status: d.status,
            reason: d.reason,
          })),
        },
      },
    };
  };

  const converge = await runConvergeGate(ctx, next);
  if (!converge) return next;
  recordConverge(converge);

  if (converge.absent.length === 0) return next;

  // One-shot corrective re-dispatch naming exactly what is missing. A
  // failed re-dispatch (provider error) does not hide the verdict — the
  // original absent set stands and is routed to the cap below.
  const prompt = buildConvergeCorrectivePrompt(next, converge);
  const retry = await dispatchFn(ctx.pi, {
    role: "developer",
    prompt,
    cwd: firstWorktreeDir(next),
  }).catch((err) => {
    trace(
      `work-driver: converge corrective re-dispatch failed: ${(err as Error).message?.slice(0, 200)}`,
    );
    return undefined;
  });

  if (!retry) {
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "develop-incomplete-deliverables",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence: convergeEvidence(converge),
    });
    return next;
  }

  next = appendEvent(next, {
    kind: "converge-redispatch",
    step: "develop",
    at: Date.now(),
  });

  // The corrective child left new work in the worktree and the diff
  // changed, so the evidence gates must judge the NEW state: safety net
  // first (commit the uncommitted work), then the verify gate.
  next = await applySafetyNet(ctx, next);
  const gate2 = await verifyStepOutcome(ctx, next, "develop");
  if (!gate2.ok) {
    const cap2 = gate2.failures.find((f) =>
      /cherry-pick \/ apply conflict|could not combine the workstreams/.test(f),
    )
      ? ("consolidated-verify-conflict" as const)
      : ("verify-failed:develop" as const);
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        verifyEvidence: { step: "develop", failures: gate2.failures, at: Date.now() },
      },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: cap2,
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
    return next;
  }

  // Second converge pass. One retry, never a loop — the second absent set
  // raises the distinct cap.
  const converge2 = await runConvergeGate(ctx, next);
  if (converge2) {
    recordConverge(converge2);
    if (converge2.absent.length > 0) {
      trace(`work-driver: develop-incomplete-deliverables — ${convergeEvidence(converge2)}`);
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "develop-incomplete-deliverables",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
        evidence: convergeEvidence(converge2),
      });
    }
  }
  return next;
}

/** The operator-facing evidence line for the cap-hit event. */
function convergeEvidence(verdict: ConvergeVerdict): string {
  return `missing deliverable(s): ${verdict.absent
    .map((a) => `${a.id} (${a.missing.join(", ")})`)
    .join("; ")}`;
}

/** The corrective child's cwd: the first worktree (N=1) or the repo root. */
function firstWorktreeDir(state: WorkState): string | undefined {
  const worktrees = state.pipelineState.worktrees ?? {};
  const first = Object.values(worktrees)[0];
  if (first && first !== "repoRoot") return first;
  return undefined;
}
