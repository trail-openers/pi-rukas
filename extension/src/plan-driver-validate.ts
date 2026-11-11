import type { OperatorDirectives } from "./plan-directives.ts";
/**
 * plan-driver-validate — Phase 3b of the compiled /plan pipeline: the draft's
 * deterministic body check, and the halt it produces when the check refuses.
 *
 * Split out of plan-driver.ts at the AGENTS.md §12 size cap. The rule lives with
 * the checks themselves (plan-validate.ts); what lives here is the pair the
 * orchestrator owes them — run the check, and turn a refusal into the SAME halt
 * shape as the other deterministic skips, so a draft whose load-bearing sections
 * fell back to placeholders pays no reviewer dispatch and never reaches the forge.
 */
import { draftInvalidHalt } from "./plan-driver-phases.ts";
import type { PlanPhaseTiming, PlanResult, PlanType } from "./plan-types.ts";
import { validateDraft } from "./plan-validate.ts";
import type { OperatorOmission } from "./plan-validate.ts";
import { trace } from "./trace.ts";

export interface Phase3bArgs {
  type: PlanType;
  /** The drafted body, disclosures included — what the checks actually judge. */
  body: string;
  depth: number;
  /** The operator context; its presence relaxes the "no criteria" problem. */
  context?: string;
  directives: OperatorDirectives;
  pinnedSubIssues?: number;
  operatorOmitted: OperatorOmission[] | undefined;
  title: string;
  priorContext: { source: string; fact: string }[];
  failedAngles: { name: string; detail: string }[];
  finishTimings: () => PlanPhaseTiming[];
}

/** Either the run continues, or it halts with the draft-invalid result. */
export interface Phase3bOutcome {
  halt?: PlanResult;
}

export function validatePhase3Draft(args: Phase3bArgs): Phase3bOutcome {
  const check = validateDraft(args.type, args.body, args.depth, {
    operatorSupplied: !!args.context?.trim(),
    pinnedSubIssues: args.pinnedSubIssues,
    forbiddenPhrases: args.directives.neverClaim,
    operatorOmitted: args.operatorOmitted ?? [],
  });
  if (check.ok) return {};
  trace(`plan-driver: draft validation failed — ${check.problems.join("; ")}`);
  return {
    halt: draftInvalidHalt({
      type: args.type,
      title: args.title,
      spec: args.body,
      priorContext: args.priorContext,
      problems: check.problems,
      failedAngles: args.failedAngles,
      timings: args.finishTimings(),
    }),
  };
}
