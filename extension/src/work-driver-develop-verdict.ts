/**
 * work-driver-develop-verdict — #1667: the ONE place a develop verify verdict is
 * recorded.
 *
 * runDevelopTopological (the first pass) and the corrective round's re-verify
 * both hand their verify gate result here, so a corrected cycle records and
 * routes exactly as an uncorrected passing one does: comment evidence, the gate
 * events, the fence verdict flip, the fence merge-and-retry, the flake-recovered
 * marker and the converge gate. The failure branch is the caller's: the first
 * pass may run the corrective round (work-driver-corrective-round.ts), the
 * re-verify parks as the first failure did.
 */

import { recordCommentEvidence } from "./comment-evidence.ts";
import { trace } from "./trace.ts";
import { runMergeRetryFlow } from "./work-develop-fence-merge-retry.ts";
import { siblingDeclaredViolators } from "./work-develop-fence-recovery.ts";
import {
  applyFenceVerdicts,
  replaceDevelopConvergedVerdicts,
} from "./work-develop-fence-verdicts.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { recordDevelopGateEvents } from "./work-driver-verify-events.ts";
import type { verifyStepOutcome } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** The verify gate's result, as the develop step reads it. */
export type DevelopGate = Awaited<ReturnType<typeof verifyStepOutcome>>;
/** One workstream's develop verdict, as the fan-out collects it. */
export type DevelopVerdict = { id: string; ok: boolean; reason?: string; claimed?: true };
type Dispatch = NonNullable<DriverContext["dispatchFn"]>;
type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;

export interface DevelopVerdictInput {
  ctx: CycleContext;
  /** The state the gate ran against. */
  state: WorkState;
  stateRef: { current: WorkState };
  ids: string[];
  verdicts: DevelopVerdict[];
  gate: DevelopGate;
  execFn: ExecFn;
  dispatch: Dispatch;
  /** The failure branch: the caller decides what a failed verify does next. */
  onVerifyFailed: (state: WorkState, gate: DevelopGate) => Promise<WorkState>;
  /**
   * #1667 — set by the corrective round's re-verify. The cycle's one corrective
   * round is already spent, so the recovery paths that re-dispatch a developer
   * (the fence merge-and-retry, the converge corrective re-dispatch) are skipped:
   * a failing re-verify goes to `onVerifyFailed`, and a passing one is recorded.
   */
  afterCorrectiveRound?: true;
}

/** Record a develop verify verdict and route it (see the header). */
export async function recordDevelopVerdict(a: DevelopVerdictInput): Promise<WorkState> {
  const { ctx, gate, ids, verdicts, stateRef, execFn, dispatch } = a;
  // #1040 — lost-comment evidence persists from the develop note (handoff even with no reviewer).
  let next = recordCommentEvidence(a.state, gate.commentEvidence);
  // #1240 — the consolidated verify skipped its run because the probe tree
  // is the tree the single workstream's own verify just judged. Recorded as
  // an event so a fast `develop` is explainable from the state file rather
  // than inferred from the absence of a 20-minute gap. Appended here, where
  // the caller owns the event log, so the log stays append-only; the helper
  // is shared with the three gate RE-RUN paths so a skip is never lost.
  next = recordDevelopGateEvents(next, gate);
  stateRef.current = next;
  // #814 — a fence violator must not report a bare "ok" here: replace the
  // event with the flipped verdicts via replaceDevelopConvergedVerdicts
  // (invariant named there; see work-develop-fence-verdicts.ts).
  if (gate.fenceViolations && ids.length > 1) {
    const flipped = applyFenceVerdicts(
      verdicts.map((v) => ({ ...v })),
      gate.fenceViolations,
    );
    const changed = flipped.some((v, i) => {
      const o = verdicts[i];
      return o === undefined || o.ok !== v.ok || o.reason !== v.reason;
    });
    if (changed) {
      next = replaceDevelopConvergedVerdicts(next, flipped);
    }
  }
  // #1005 — the fence merge-and-retry (replaces the #849 fence recovery,
  // which re-ran the same split and failed the same way every time): when
  // the gate recorded a BLOCKING sibling-declared violation (and no
  // issue-fenced one, which still blocks as today), the driver MERGES the
  // coupled workstreams (owner keeps its id; violator absorbed), re-dispatches
  // ONCE on the merged one, and re-runs the fence + verify gates (the full
  // flow lives in work-develop-fence-merge.ts / work-develop-fence-
  // merge-retry.ts). A second failure after merging hands off, naming the
  // merge. `issue-fenced` and `undeclared` records never merge: the
  // condition is exactly "sibling-declared only". The gate runs on
  // `stateRef.current` (the flip above wrote the verdicts there), not the
  // local `next`.
  const recoverableFence =
    gate.fenceViolations !== undefined &&
    siblingDeclaredViolators(gate.fenceViolations).length > 0 &&
    !gate.fenceViolations.some((f) => f.kind === "issue-fenced");
  if (gate.ok === false && recoverableFence && a.afterCorrectiveRound !== true) {
    // #849 — the gate's fence records are not yet on `pipelineState`
    // (the develop step writes them only on a failure path, after the
    // gate returns). Stash them so `recoverFenceViolations` (which reads
    // `stateRef.current.pipelineState.verifyEvidence`) sees the first
    // attempt's records for the cycle check and the discard evidence.
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        verifyEvidence: {
          step: "develop",
          failures: gate.failures,
          at: Date.now(),
          fenceViolations: gate.fenceViolations ?? [],
        },
      },
    };
    stateRef.current = next;
    return runMergeRetryFlow(ctx, next, stateRef, ids, verdicts, execFn, dispatch);
  }
  if (gate.ok) {
    // #782 — the consolidated verify's single re-run passed: the driver
    // proceeds. Emit the recovery marker BEFORE the converge gate so the
    // event log carries the audit trail even if the cycle parks later.
    if (gate.flakeRecovered) {
      next = appendEvent(next, {
        kind: "verify-flake-recovered",
        at: Date.now(),
        step: "develop",
      });
    }
    // #741 — the verify gate proves the diff BUILDS; the converge gate
    // proves it is COMPLETE. Runs only after the verify gate passes (the
    // issue's stated ordering) — a diff that doesn't build never reaches
    // the completeness check. Skips silently when disabled, when there is
    // no normalised spec, or when the diff is unreadable.
    if (a.afterCorrectiveRound === true) {
      // #1667 — the converge corrective re-dispatch is a second developer round.
      trace("work-driver: converge gate not re-run after the corrective develop round");
      return next;
    }
    return runConvergeGateHandler(ctx, next, dispatch);
  }
  return a.onVerifyFailed(next, gate);
}
