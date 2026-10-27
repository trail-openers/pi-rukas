import type { OperatorDirectives } from "./plan-directives.ts";
/**
 * plan-driver-redraft — the gap gate's CRITICAL-only corrective re-draft
 * (round 2), extracted from plan-driver.ts at the AGENTS.md §12 size cap.
 *
 * PR #640: resolve destinations and re-draft in ONE site. The wide catch's
 * disclosure (plan-driver-halt.ts `correctiveRedraftError`) names what was
 * computed before the throw — a crash must not silently lose the decisions that
 * were already resolved, because the operator then sees a re-draft that appears
 * to have ignored findings the reviewer never got another look at.
 */
import { draftSpec } from "./plan-draft.ts";
import type { AngleFindings } from "./plan-draft.ts";
import { correctiveRedraftError } from "./plan-driver-halt.ts";
import type { CarriedCritical } from "./plan-gate-prompt.ts";
import type { PlanGap, PlanType } from "./plan-types.ts";
import type { RenderBudget } from "./plan-validate.ts";
import { type ResolvedDecision, buildResolvedDecisions } from "./plan-writeback.ts";

export interface CorrectiveRedraftCtx {
  type: PlanType;
  descriptor: string;
  findings: AngleFindings[];
  inventoryContext: { source: string; fact: string }[];
  openQuestions: string[];
  outOfScope: string[];
  depth: number;
  directives: OperatorDirectives;
  /** Same budget as the fitted round-1 draft: deterministic across rounds, and
   *  the round-2 body stays under the forge limit. */
  chosenBudget: RenderBudget;
  setCarried: (carried: CarriedCritical[]) => void;
  setTitleBody: (title: string, body: string) => void;
}

/**
 * The gate's CRITICAL-only corrective re-draft. Throws `correctiveRedraftError`
 * (plan-driver-halt.ts) on any failure, whose message carries the writeback
 * disclosure; plan-driver-gate.ts catches it and the orchestrator renders the
 * halt (plan-driver-phases.ts `correctiveRedraftHalt`).
 */
export function correctiveRedraft(blocking: PlanGap[], ctx: CorrectiveRedraftCtx): void {
  let computed: ResolvedDecision[] = [];
  let writtenOutcomes: { applied: boolean; heading: string }[] = [];
  try {
    const { decisions, writebackMap } = buildResolvedDecisions(blocking, ctx.type);
    computed = decisions;
    const redraft = draftSpec(
      ctx.type,
      ctx.descriptor,
      ctx.findings,
      ctx.inventoryContext,
      ctx.openQuestions,
      ctx.outOfScope,
      ctx.depth,
      ctx.directives,
      decisions,
      writebackMap,
      ctx.chosenBudget,
    );
    if (redraft.operatorOmitted.length) throw new Error("redraft truncated operator items");
    // Marked decisions (writtenBack from the splice, never predicted).
    writtenOutcomes = redraft.resolvedDecisions.map((d) => ({
      applied: d.writtenBack ?? false,
      heading: d.writebackHeading ?? "(no destination — status open)",
    }));
    ctx.setCarried(
      redraft.resolvedDecisions.map((d) => ({
        description: d.description,
        resolution: d.resolution,
        writtenBack: d.writtenBack ?? false,
        heading: d.writebackHeading ?? "Open Questions",
      })),
    );
    ctx.setTitleBody(redraft.title, redraft.body);
  } catch (e) {
    throw correctiveRedraftError(computed, writtenOutcomes, e);
  }
}
