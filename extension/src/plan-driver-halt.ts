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
import { PLAN_REPORTER_PATH } from "./plan-investigate.ts";
import type { PlanPhaseTiming, PlanResult, PlanType } from "./plan-types.ts";
import { reporterMissingError } from "./reporter-preflight.ts";

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
 * The all-angles-failed spec text (#893). When EVERY failed angle carries
 * the named reporter-missing error, the preflight failed: nothing was
 * dispatched, so the generic "Dispatched angles … prose only /
 * schema-invalid" text would be false — render the honest preflight text
 * instead. Moved from plan-driver.ts along the 500-line seam (AGENTS.md §12);
 * the sentences are verbatim from the driver's original builder.
 */
export function allAnglesFailedSpec(angleNames: string, allReporterMissing: boolean): string {
  return allReporterMissing
    ? `(spec not drafted — the plan-reporter extension is missing)\n\nNo angles were dispatched — ${reporterMissingError(PLAN_REPORTER_PATH)}.`
    : `(spec not drafted — all investigation angles returned zero structured items)\n\nDispatched angles: ${angleNames}\n\nEach angle returned either prose only (no report_plan_item tool calls) or schema-invalid calls only. This usually means the reporter extension was not loaded, or the model did not make the tool calls. Re-run start_plan_driver — the investigation children are re-dispatched; if this recurs, check the plan-reporter extension registration (PLAN_REPORTER_PATH).`;
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
