import { trace } from "./trace.ts";
/**
 * work-driver-lens-fix-reposition-park — #981 (task-b) — the terminal park
 * for the round-2+ lens-fix reposition guard.
 *
 * When {@link repositionLensFixWorktree} cannot verify a safe base for the
 * fixer (a dirty worktree, round-1 work that never landed, or a diverged
 * tree), the driver MUST NOT dispatch the fixer — a fix built on a base the
 * branch does not have would not integrate cleanly (the #978 shape). This
 * helper builds the `lens-fix-reposition` cap-hit (routed to `handoff` by
 * nextStep) and persists it, WITHOUT dispatching. The kind + git detail
 * ride on `evidence`; a backup ref (unlanded / diverged) rides on
 * `restoredToRef`.
 */
import type { DriverContext } from "./work-driver-context.ts";
import type { RepositionResult } from "./work-driver-lens-fix-reposition-gate.ts";
import { type WorkState, appendEvent, writeState } from "./workflow-state.ts";

/**
 * Build + persist the `lens-fix-reposition` cap-hit for a reposition-guard
 * failure and route the cycle to `handoff`. `rep` is a failure-kind result
 * (dirty / unlanded / diverged / git-failed). The caller returns this state
 * and does NOT dispatch the fixer.
 */
export async function parkLensFixReposition(
  ctx: DriverContext,
  state: WorkState,
  now: number,
  fixTree: string,
  rep: Extract<RepositionResult, { detail: string }>,
): Promise<WorkState> {
  // #981: record the backup ref for EVERY failure kind that carries one —
  // not just unlanded / diverged. A `git-failed` result (e.g. the cherry
  // path made a backup ref, then the checkout failed) must not lose it: the
  // operator needs the ref to recover the tree. `backupRef` is present on
  // the unlanded / diverged / git-failed variants of RepositionResult.
  const backupRef = "backupRef" in rep ? rep.backupRef : undefined;
  const evidence = `${rep.kind}: ${rep.detail}${backupRef ? ` (backed up to ${backupRef})` : ""}`;
  trace(`work-driver: lens-fix reposition guard parked the cycle — ${evidence}`);
  let next: WorkState = appendEvent(state, {
    kind: "cap-hit",
    at: now,
    cap: "lens-fix-reposition",
    lensWorktreePath: fixTree,
    reviewRound: state.pipelineState.reviewRound,
    ...(backupRef ? { restoredToRef: backupRef } : {}),
    evidence,
    nextStep: "handoff",
  });
  next = {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: "handoff" },
  };
  await writeState(ctx.repoRoot, next);
  return next;
}
