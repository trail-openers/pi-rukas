import { trace } from "./trace.ts";
import { inlineCodeSafe } from "./work-driver-conflict-evidence.ts";
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
 *
 * #1391 — the `dirty` kind now knows whether the dirt is the driver's own. When
 * the cycle has already lost a lens-fix child into this tree, the park says so:
 * the operator reading the handoff must be able to tell "the driver parked on
 * work its own dead child left behind" from "someone's in-progress edits are in
 * the lens-fix worktree", because only the first is a bug in this harness and
 * only the first says the fix was never dispatched.
 */
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import type { RepositionResult } from "./work-driver-lens-fix-reposition-gate.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * Build + persist the `lens-fix-reposition` cap-hit for a reposition-guard
 * failure and route the cycle to `handoff`. `rep` is a failure-kind result
 * (dirty / unlanded / diverged / git-failed). The caller returns this state
 * and does NOT dispatch the fixer.
 */
export async function parkLensFixReposition(
  ctx: CycleContext,
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
  // #1391 — for a dirty park, the ATTRIBUTION and the SAVED COPY are the two
  // facts that make it actionable, and both come from the gate's own reads: the
  // gate decided (after its preserve-and-clean attempt) whether the dirt is
  // still the driver's, and where the preserved patch went. Never inferred
  // here.
  const attemptLost = rep.kind === "dirty" && rep.attemptLost === true;
  const preservedTo = rep.kind === "dirty" ? rep.preservedTo : undefined;
  const cleanFailed = rep.kind === "dirty" ? rep.cleanFailed : undefined;
  const attribution = attemptLost
    ? ` | #1391 attribution: the dirt is the driver's own — this cycle lost a lens-fix child into ${inlineCodeSafe(fixTree)} on an earlier attempt${preservedTo ? `, and its work is preserved at ${inlineCodeSafe(preservedTo)}` : ""}. The fixer was NOT dispatched, so the round's findings are still open on the branch.${cleanFailed ? ` The driver's attempt to clean the tree did not complete: ${inlineCodeSafe(cleanFailed)}.` : ""}`
    : "";
  const evidence = `${rep.kind}: ${rep.detail}${backupRef ? ` (backed up to ${backupRef})` : ""}${attribution}`;
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
  await persistCycle(ctx, next);
  return next;
}
