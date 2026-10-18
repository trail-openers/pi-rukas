/**
 * plan-driver-phases — the /plan run's early halts, extracted from
 * plan-driver.ts at the AGENTS.md §12 size cap.
 *
 * Each is a "the run stopped, nothing was filed" result the operator reads,
 * so their wording is load-bearing: every one carries the recovery path the
 * incident taught us (C6's acknowledged-duplicate recipe is the whole reason a
 * HIGH verdict is not a dead end). The pre-gate halts — the precheck, the
 * duplicate-risk stop, and the phase-3b draft validation — sit together here,
 * and the corrective re-draft's halt sits beside them because it shares their
 * shape and their reason for existing.
 */
import { haltResult } from "./plan-driver-halt.ts";
import type { GapGateLoopCapReason } from "./plan-gaps.ts";
import type { PlanPhaseTiming, PlanResult, PlanType } from "./plan-types.ts";
import { planTitle } from "./plan-types.ts";

/**
 * Phase 0b — the deterministic under-specification halt. Fires only on the
 * strongest signal (under the word floor, no code identifier, no context param)
 * and BEFORE any dispatch, so an unusable descriptor costs no child tokens. The
 * questions are the recovery path: answer them and re-call.
 */
export function needsClarificationHalt(args: {
  type: PlanType;
  descriptor: string;
  questions: string[];
  timings: PlanPhaseTiming[];
}): PlanResult {
  return haltResult({
    type: args.type,
    title: planTitle(args.descriptor, args.type),
    spec: `(spec not drafted — the descriptor is too thin to ground an investigation)\n\nAnswer these and re-run start_plan_driver with a fuller descriptor or a context param:\n${args.questions.map((q) => `- ${q}`).join("\n")}`,
    priorContext: [],
    failure: {
      reason: "needs-clarification",
      detail:
        "the descriptor is under the word floor with no code identifier and no context param — investigation was deliberately skipped before any dispatch",
    },
    timings: args.timings,
  });
}

/**
 * C6 — the duplicate-risk HIGH halt. A structured not-filed result instead of a
 * bare throw: the operator gets the rationale AND the recovery path (acknowledge
 * the named issue via the context param; the risk child reads it and a
 * reconciled issue cannot raise the risk above medium).
 */
export function duplicateRiskHalt(args: {
  type: PlanType;
  descriptor: string;
  rationale: string;
  priorContext: { source: string; fact: string }[];
  failedAngles: { name: string; detail: string }[];
  timings: PlanPhaseTiming[];
}): PlanResult {
  return haltResult({
    type: args.type,
    title: planTitle(args.descriptor, args.type),
    spec: `(spec not drafted — duplicate risk HIGH)\n\nRationale from the risk check:\n${args.rationale}\n\nIf this ticket deliberately reverses or extends the named issue, re-run start_plan_driver with a context param acknowledging it (e.g. "this deliberately reverses #103 because …") — an acknowledged issue is reconciled, not a duplicate. Full rationale: /runs → plan-duplicate-risk.`,
    priorContext: args.priorContext,
    failure: {
      reason: "duplicate-risk",
      detail: `duplicate risk HIGH — ${args.rationale.slice(0, 300)}`,
    },
    failedAngles: args.failedAngles,
    timings: args.timings,
  });
}

/**
 * Phase 3b — the deterministic body-validation halt. A draft whose load-bearing
 * sections fell back to placeholders never pays a reviewer dispatch and never
 * reaches the forge.
 */
export function draftInvalidHalt(args: {
  type: PlanType;
  title: string;
  spec: string;
  priorContext: { source: string; fact: string }[];
  problems: string[];
  failedAngles: { name: string; detail: string }[];
  timings: PlanPhaseTiming[];
}): PlanResult {
  return haltResult({
    type: args.type,
    title: args.title,
    spec: args.spec,
    priorContext: args.priorContext,
    failure: {
      reason: "draft-invalid",
      detail: `the drafted body failed deterministic validation, so it was not reviewed or filed: ${args.problems.join("; ")}. Re-run start_plan_driver (the angles are re-dispatched), or supply the missing content via the context param (e.g. an ACCEPTANCE CRITERIA block).`,
    },
    failedAngles: args.failedAngles,
    timings: args.timings,
  });
}

/**
 * Phase 4 — the corrective re-draft threw. `correctiveRedraft` (plan-driver-redraft.ts)
 * rethrows a wide catch as `correctiveRedraftError`, whose message is the
 * DISCLOSURE of which carried gap decisions had been computed (and whether each
 * splice landed) before the throw. The run must still halt as a PLAN halt: a
 * bare throw out of the pipeline reaches the async job's generic fail report and
 * the operator loses the plan-specific rendering — the same reasoning as the
 * sibling gate failure modes (`gate-unavailable`, `review-unparseable`) that
 * stop the loop without ever reaching `startJob`'s rejection path. The
 * capReason is `gate-unavailable`: the reviewer never saw the re-drafted body,
 * which is exactly what that reason means, and it is what routes Phase 5 to a
 * deliberate not-filed skip on both the dry-run and filing paths.
 */
export function correctiveRedraftHalt(args: {
  type: PlanType;
  descriptor: string;
  priorContext: { source: string; fact: string }[];
  failedAngles: { name: string; detail: string }[];
  error: unknown;
  timings: () => PlanPhaseTiming[];
}): PlanResult {
  const detail = args.error instanceof Error ? args.error.message : String(args.error);
  return haltResult({
    type: args.type,
    title: planTitle(args.descriptor, args.type),
    spec: `(spec not filed — the corrective re-draft threw)\n\nThe gap gate returned blocking findings and the re-draft that was meant to carry their resolutions failed. What had been computed before the throw is disclosed below verbatim, so the loss is visible:\n\n${detail}\n\nRe-run start_plan_driver (the angles and the gate are re-dispatched); if it recurs, the disclosure above names which decision's writeback the re-draft died on.`,
    priorContext: args.priorContext,
    capHit: true,
    // The PlanResult-level capReason is what Phase 5 routes on and what the
    // renderer's cap block branches on; `failure.reason` is the same token
    // because FilingFailure's own union has no capReason field.
    capReason: "gate-unavailable",
    failure: {
      reason: "gate-unavailable",
      detail: `the corrective re-draft threw after the gate returned blocking findings, so the re-drafted body was never reviewed and was not filed: ${detail}`,
    },
    failedAngles: args.failedAngles,
    timings: args.timings(),
  });
}
