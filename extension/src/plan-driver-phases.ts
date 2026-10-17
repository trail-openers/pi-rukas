/**
 * plan-driver-phases — the /plan run's early halts, extracted from
 * plan-driver.ts at the AGENTS.md §12 size cap.
 *
 * Both are "the run stopped before drafting" results, and both are prose the
 * operator reads, so their wording is load-bearing: each carries the recovery
 * path the incident taught us (C6's acknowledged-duplicate recipe is the whole
 * reason a HIGH verdict is not a dead end).
 */
import { haltResult } from "./plan-driver-halt.ts";
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
