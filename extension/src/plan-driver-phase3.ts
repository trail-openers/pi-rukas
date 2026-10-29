/**
 * plan-driver-phase3 — Phase 3 of the compiled /plan pipeline: draft the body
 * within the forge's character budget.
 *
 * Split out of plan-driver.ts along the 500-line seam (AGENTS.md §12). Owns the
 * `fitDraftToBudget` call — the twelve positional args of `draftSpec`, the
 * provenance reservation, and the `body-too-large` halt the fitter's `tooLarge`
 * branch produces — so the driver keeps the orchestration and this file keeps
 * one deterministic, pure rendering step. The accumulators (`openQuestions`,
 * `outOfScope`) are returned so the Phase-4 corrective re-draft appends to the
 * same arrays it did when the code sat inline.
 */
import type { OperatorDirectives } from "./plan-directives.ts";
import type { AngleFindings } from "./plan-draft.ts";
import { draftSpec } from "./plan-draft.ts";
import { haltResult } from "./plan-driver-halt.ts";
import { appendPiSpecSection, piSpecReservation } from "./plan-pi-spec.ts";
import { type PlanProvenance, provenanceReservation } from "./plan-provenance.ts";
import type { PlanPhaseTiming, PlanResult, PlanType } from "./plan-types.ts";
import { planTitle } from "./plan-types.ts";
import type { OperatorOmission, RenderBudget } from "./plan-validate.ts";
import { FORGE_BODY_MAX, RENDER_BUDGETS, fitDraftToBudget } from "./plan-validate.ts";
import { trace } from "./trace.ts";

/** The Phase-3 inputs: what the drafted body is built from. */
export interface Phase3Args {
  type: PlanType;
  descriptor: string;
  findings: AngleFindings[];
  inventoryContext: { source: string; fact: string }[];
  directives: OperatorDirectives;
  depth: number;
  /** The caller's provenance (#1377) — its rendered size is reserved out of the budget. */
  provenance?: PlanProvenance;
  /** Only for the halt result's shape. */
  priorContext: { source: string; fact: string }[];
  failedAngles: { name: string; detail: string }[];
  timings: () => PlanPhaseTiming[];
}

/** What the fitter chose: the draft, the budget that fitted it, and the note. */
export interface Phase3Fitted {
  title: string;
  body: string;
  operatorOmitted: OperatorOmission[];
  chosenBudget: RenderBudget;
  compacted: boolean;
  /** Shared with the Phase-4 re-draft: it appends to the same arrays. */
  openQuestions: string[];
  outOfScope: string[];
}

export type Phase3Outcome = { halt: PlanResult } | ({ halt?: undefined } & Phase3Fitted);

/**
 * Draft within the forge body budget (vipune session: four filings hit the
 * 65,536-char wall after clean gates; plan-validate.ts owns the stage-0 /
 * compaction / tooLarge policy).
 *
 * #1377: the caller's provenance lines are appended by code AFTER this fitter,
 * so compaction can never trim them — and to keep the FINAL body inside the
 * forge cap, their rendered size is reserved out of the budget up front
 * (`fitDraftToBudget` compares against BODY_BUDGET minus the reservation). The
 * reservation is 0 with no provenance, so the budget the fitter sees — and
 * therefore the body it picks — is byte-identical for every existing caller. The
 * compaction note and the `filedBodyOf` sections are budgeted exactly as today
 * (BODY_BUDGET's 4,096-char headroom covers them; `validateFinalSpec`'s existing
 * `body-too-large` halt is their bound).
 *
 * #1883: the `## Spec (pi-spec v1)` block is reserved exactly like the marker —
 * code places it AFTER the fitter (plan-pi-spec.ts, at `finalDraftBody`) and
 * compaction never sees it, so nothing can trim it; its rendered width comes out
 * of the budget up front so the FINAL body still fits the forge cap.
 */
/**
 * #1883 — what the budget fitter holds back for the TWO code appends that land
 * AFTER it: the caller's provenance lines (plan-provenance.ts) and the
 * `## Spec (pi-spec v1)` block (plan-pi-spec.ts). Both are placed by code at the
 * one home for the filed body, `finalDraftBody`, so compaction never sees either
 * and nothing can trim them; their width is paid for up front rather than
 * discovered afterwards — that is the whole of the budget story for the block,
 * and it is the same mechanism #1377 uses for the provenance marker. Exported for
 * the budget test, which asserts a fitted body plus its reservation stays under
 * BODY_BUDGET (a reservation nothing checks is a reservation that drifts).
 *
 * The block's reservation is its REAL rendered length, with no clamp: every
 * field is bounded in `piSpecFromDraft` (200-char title, at most 12 criteria at
 * 200 chars each), so the section has a hard ceiling far below the headroom a
 * body needs. The earlier clamp existed for an unbounded mapper and was itself
 * the failure — a clamp UNDER-counts, and an under-counted reservation is a
 * post-fit append that blows the forge cap.
 */
export function codeAppendReservation(
  provenance: PlanProvenance | undefined,
  type: PlanType,
  body: string,
  title: string,
): number {
  return provenanceReservation(provenance) + piSpecReservation(type, body, title);
}

/**
 * The stage-0 render, which the fitter produces anyway and which is never
 * SHORTER than the stage-1 render it may fall back to (both stages only shrink
 * the item cap and the item clip). Measuring the block on it means the
 * reservation never UNDER-counts — an under-count is what lets a post-fit append
 * blow the forge cap. Costs one extra pure `draftSpec` call per run.
 */
function stage0Probe(args: Phase3Args): { body: string; title: string } {
  return draftSpec(
    args.type,
    args.descriptor,
    args.findings,
    args.inventoryContext,
    [],
    [],
    args.depth,
    args.directives,
    [],
    undefined,
    RENDER_BUDGETS[0] as RenderBudget,
  );
}

export function phase3Draft(args: Phase3Args): Phase3Outcome {
  const openQuestions: string[] = [];
  const outOfScope: string[] = [];
  const fitted = fitDraftToBudget(
    (b) =>
      draftSpec(
        args.type,
        args.descriptor,
        args.findings,
        args.inventoryContext,
        openQuestions,
        outOfScope,
        args.depth,
        args.directives,
        [],
        undefined,
        b,
      ),
    // #1377 + #1883: both after-the-fitter appends (the provenance marker and
    // the spec block) are reserved at the one call site that computes them, so
    // neither can be forgotten. 0 for an epic, a spike, or a criteria-less draft.
    // Measured on ONE stage-0 probe (title + body), which is never SHORTER than
    // the stage-1 render the fitter may fall back to — so the reservation never
    // under-counts.
    (() => {
      const probe = stage0Probe(args);
      return codeAppendReservation(args.provenance, args.type, probe.body, probe.title);
    })(),
  );
  if ("tooLarge" in fitted) {
    trace(`plan-driver: body too large even after compaction (${fitted.size} chars) — halting`);
    return {
      halt: haltResult({
        type: args.type,
        title: planTitle(args.descriptor, args.type),
        spec: `(spec not rendered — the drafted body is ${fitted.size} chars even after compaction; the forge caps issue bodies at ${FORGE_BODY_MAX})\n\nPer-section sizes: ${fitted.breakdown}\n\nTrim the dominant section's source (usually the context param) and re-run start_plan_driver.`,
        priorContext: args.priorContext,
        failure: {
          reason: "body-too-large",
          detail: `the drafted body is ${fitted.size} chars after maximum compaction; the forge caps bodies at ${FORGE_BODY_MAX}. Per-section sizes: ${fitted.breakdown}`,
        },
        failedAngles: args.failedAngles,
        timings: args.timings(),
      }),
    };
  }
  return {
    ...fitted.result,
    chosenBudget: fitted.budget,
    compacted: fitted.compacted,
    openQuestions,
    outOfScope,
  };
}
