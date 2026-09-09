/**
 * plan-driver-halt — the one builder for the pipeline's early-return halts.
 *
 * Five deterministic halts share this shape (needs-clarification,
 * skipped-all-angles-failed, duplicate-risk, draft-invalid,
 * body-too-large): nothing filed, zero gaps, a spec text that explains and
 * names the remedy, and a DISCRIMINATED FilingFailure the renderer turns
 * into the NOT-FILEABLE head + FILING STATUS block (on dryRun too — the
 * #647 rule). One builder so a field added to the halt shape cannot be
 * forgotten at four of five sites. Split from plan-driver.ts along the
 * 500-line seam (AGENTS.md §12).
 */
import type { FilingFailure } from "./plan-filing.ts";
import type { PlanPhaseTiming, PlanResult, PlanType } from "./plan-types.ts";

export function haltResult(args: {
  type: PlanType;
  title: string;
  /** The operator-visible explanation (rendered as the SPEC section). */
  spec: string;
  priorContext: { source: string; fact: string }[];
  failure: FilingFailure;
  timings: PlanPhaseTiming[];
  capHit?: boolean;
  failedAngles?: { name: string; detail: string }[];
}): PlanResult {
  return {
    type: args.type,
    title: args.title,
    spec: args.spec,
    gaps: [],
    priorContext: args.priorContext.slice(0, 15),
    filed: false,
    ...(args.capHit ? { capHit: true } : {}),
    filingFailure: args.failure,
    ...(args.failedAngles && args.failedAngles.length > 0
      ? { failedAngles: args.failedAngles }
      : {}),
    timings: args.timings,
  };
}

/**
 * The corrective re-draft failure with its writeback DISCLOSURE: names what
 * was computed (and whether each splice landed) before the throw, so a
 * crash cannot silently lose carried gap decisions.
 */
export function correctiveRedraftError(
  computed: { description: string; resolution: string }[],
  writtenOutcomes: { applied: boolean; heading: string }[],
  e: unknown,
): Error {
  const disclosed = computed.length
    ? computed
        .map((d, i) => {
          const o = writtenOutcomes[i];
          return o
            ? o.applied
              ? `• written back to ${o.heading}: ${d.description} → ${d.resolution}`
              : `• NOT written back (open, decision owner operator): ${d.description} → ${d.resolution}`
            : `• not yet applied: ${d.description} → ${d.resolution}`;
        })
        .join("\n")
    : "(no decisions computed — the throw preceded the re-draft)";
  const err = e instanceof Error ? e : new Error(String(e));
  return new Error(
    `corrective re-draft failed AFTER computing ${computed.length} carried gap decision(s) (the writeback decisions are disclosed here so the loss is visible):\n${disclosed}\noriginal error: ${err.message}`,
    { cause: err },
  );
}
