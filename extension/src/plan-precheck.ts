/**
 * plan-precheck — deterministic under-specification triage, run BEFORE any
 * dispatch in the /plan pipeline.
 *
 * The research base (outputs/spec-driven-plan-driver-gap.md, G1) puts
 * under-specification at the top of the spec-defect literature: it is the
 * most severe task-description defect class (SpecValidator,
 * arXiv:2604.24703), the main driver of multi-agent coordination collapse
 * (arXiv:2603.24284), and what makes agents guess (arXiv:2607.02294) —
 * while clarification recovers most of the gap (Ambig-SWE, arXiv:2502.13069,
 * up to +74%). The old pipeline discovered it LAST, via the LLM gap gate,
 * after burning the full investigation fan-out.
 *
 * This check is deliberately DETERMINISTIC (no model call): the routing
 * decision is identical on every run (operator decision 2026-09-09 — two
 * runs of the driver should ideally deliver identical specs), it costs
 * nothing, and it fires only on the strongest signal so a legitimately
 * terse descriptor is never blocked: ALL THREE must hold — below the word
 * floor AND zero code identifiers AND no operator context. Anything softer
 * (ambiguity, contradiction) stays with the LLM gap gate, which is built
 * for judgment calls.
 *
 * On fire, the pipeline returns targeted questions instead of a spec —
 * the operator answers by re-running with a fuller descriptor or a
 * `context` param. Total cost of the round-trip: seconds, versus the
 * 10+ minutes of fan-out the old shape spent before telling the operator
 * the same thing.
 */
import { codeIdentifiersIn } from "./plan-draft.ts";
import type { PlanType } from "./plan-types.ts";

/**
 * Descriptors under this many words, with no code identifier and no
 * context param, cannot ground an investigation: the angles would search
 * the codebase for a topic the descriptor never names.
 */
export const PRECHECK_WORD_FLOOR = 6;

export interface PrecheckVerdict {
  ok: boolean;
  /** Targeted questions for the operator (empty when ok). */
  questions: string[];
}

export function precheckDescriptor(
  type: PlanType,
  descriptor: string,
  context: string | undefined,
): PrecheckVerdict {
  const words = descriptor.trim().split(/\s+/).filter(Boolean);
  const hasContext = typeof context === "string" && context.trim().length > 0;
  if (
    words.length >= PRECHECK_WORD_FLOOR ||
    codeIdentifiersIn(descriptor).length > 0 ||
    hasContext
  ) {
    return { ok: true, questions: [] };
  }
  return {
    ok: false,
    questions: [
      `Which code area does this ${type} touch? Name at least one file, module or symbol (e.g. \`extension/src/foo.ts\` or \`resolveModel\`).`,
      type === "bug"
        ? "What is the observed wrong behaviour, and what should happen instead? One sentence each."
        : "What observable behaviour or outcome is expected when this is done? One sentence.",
      "What is explicitly OUT of scope (if anything)? Anything you already know the implementer must not touch.",
    ],
  };
}
