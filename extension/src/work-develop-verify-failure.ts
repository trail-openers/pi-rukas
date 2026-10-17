/**
 * work-develop-verify-failure — #669/#777/#841: the develop step's cap for a
 * consolidated verify that FAILED (the else-branch of the verify gate in
 * work-develop-topological.ts). Split out to keep that file under the 500-line
 * gate; the behaviour is unchanged. Maps the gate's failures onto one of three
 * caps (conflict, consolidation-created, generic verify-failed) and appends the
 * cap-hit with its evidence, the fence attribution and any log path.
 */
import { trace } from "./trace.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { describeSiblingFenceViolations } from "./work-develop-fence-verdicts.ts";
import { verifyCapFor } from "./work-driver-verify-develop-helpers.ts";
import type { verifyStepOutcome } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** The verify gate's result, as the develop step reads it. */
type DevelopVerifyGate = Awaited<ReturnType<typeof verifyStepOutcome>>;

/** Append the develop verify-failure cap-hit (and its verifyEvidence) to `next`. */
export function appendDevelopVerifyFailure(state: WorkState, gate: DevelopVerifyGate): WorkState {
  let next = state;
  // #669 — a cherry-pick conflict during the develop-time consolidated
  // verify is a consolidation error (two workstreams' changes cannot
  // combine), not a verify failure: retrying the verify command cannot
  // fix it. Route it to its own cap so the operator sees the conflict
  // with its evidence instead of being told the verify failed. #794 —
  // explainCap (not this message) distinguishes a stacked cycle from an
  // independent fanout overlap; the stacked distinction belongs there
  // because the cap is the operator-facing explanation seam.
  const conflictFailure = gate.failures.find((f) =>
    /cherry-pick \/ apply conflict|could not combine the workstreams/.test(f),
  );
  // #814 — when the consolidated-verify-conflict cap fires on a
  // sibling-declared fence violation, the cap-hit EVIDENCE carries the
  // shared attribution sentence (describeSiblingFenceViolations — the
  // same wording as the handoff's explainConsolidation fence branch), so
  // the operator sees "workstream X touched F, declared by workstream Y"
  // at the cap itself, not only in the rendered explanation. (The
  // gate's failure string, recorded on verifyEvidence.failures, carries
  // the full attribution too; the evidence is the tail-visible seam.)
  const fenceProse = gate.fenceViolations
    ? describeSiblingFenceViolations(gate.fenceViolations)
    : undefined;
  // #777 — a consolidation-created verify failure (per-workstream pass,
  // combined fail on a specific assertion) is a THIRD distinct cap,
  // separate from both the conflict cap and the generic verify-failed:
  // develop. The failure message carries the classification label, the
  // specific assertion, and both workstream ids — the operator gets a
  // precise handoff instead of "consolidated tree fails verify".
  const consolidationCreatedFailure = gate.failures.find((f) =>
    /\[consolidation-created\]/.test(f),
  );
  const cap = conflictFailure
    ? "consolidated-verify-conflict"
    : consolidationCreatedFailure
      ? "consolidated-verify-consolidation-created"
      : verifyCapFor(
          "develop",
          gate.failures,
          gate.baselineRedOnly,
          // #1421 fix round — the structured decline from the consolidated
          // gate, not a `[build-residue]` substring of the failure prose.
          gate.buildResidueOnly === true,
        ); // #1324 — a run killed at its bound is not a code failure
  trace(`work-driver: ${cap} — ${gate.failures.join(" | ")}`);
  // #782 — when the consolidated verify recovered from a flake but the
  // converge gate then parks, record the retry so the handoff shows
  // "retried once, recovered" even though the cycle stops here.
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      verifyEvidence: {
        step: "develop",
        failures: gate.failures,
        at: Date.now(),
        origin: "outcome-gate",
        // #1421 fix round — the structured decline, persisted so the queue's
        // park reason does not have to re-derive it from the failure prose.
        ...(gate.buildResidueOnly === true ? { buildResidueOnly: true } : {}),
        ...(gate.fenceViolations ? { fenceViolations: gate.fenceViolations } : {}),
        ...(gate.flakeRecovered ? { retries: 1, recovered: true } : {}),
      },
    },
  };
  // #841 — the verify-failed:develop cap always carries evidence. The
  // pre-fix spread attached it only for the conflict and
  // consolidation-created branches, so the generic N=1 shape (issue
  // #840) parked with NO evidence field at all — the handoff had
  // nothing to name beyond verifyEvidence.failures, and the raw verify
  // output (persisted to the scratch dir by the consolidated gate, the
  // failure strings below) was unreferenceable. Every verify failure is
  // now named at the cap itself; the fence prose suffixes the conflict /
  // consolidation-created wording (the attribution belongs on both caps).
  // Each failure is bounded before the join, and the join itself is
  // capped (the #841 unbounded-evidence fix).
  const failureEvidence =
    conflictFailure ?? consolidationCreatedFailure ?? boundJoinFailures(gate.failures);
  // #841 — the log path the gate actually wrote, carried STRUCTURALLY on
  // the cap event (the explain renderer renders it without regexing the
  // evidence prose); absent when the gate wrote no log.
  const logPaths = gate.logPath !== undefined ? [gate.logPath] : undefined;
  next = appendEvent(next, {
    kind: "cap-hit",
    at: Date.now(),
    cap,
    reviewRound: next.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence:
      failureEvidence +
      (conflictFailure || consolidationCreatedFailure
        ? fenceProse
          ? ` [fence: ${fenceProse}]`
          : ""
        : ""),
    ...(logPaths !== undefined ? { logPaths } : {}),
  });
  return next;
}
