import { type PlanResultFields, buildPlanResult } from "./plan-driver-halt.ts";
/**
 * plan-driver-result — the final PlanResult of one /plan run.
 *
 * Split out of plan-driver.ts at the AGENTS.md §12 size cap. `buildPlanResult`
 * (plan-driver-halt.ts) is the one normalising builder every path shares; this
 * file owns the two decisions the FINAL return adds on top of it, both of which
 * are about what the run authorised rather than what it produced:
 *
 *   - **the digest** — the bytes a verbatim filing must echo. It covers the body,
 *     the labels, the provenance (#1377) and, since #1854, the target repository:
 *     the destination is part of what the operator was shown, so a dry run
 *     reviewed for repository A cannot authorise filing the same bytes into B.
 *     Only a run that reached the end WITHOUT a filing failure reports one — a
 *     halting run has no reviewed spec to echo, and offering a digest it cannot
 *     honour is the #647-class defect the "NOT FILEABLE" head exists to prevent.
 *   - **the destination** — the canonical identity the launch notice and the
 *     rendered report name. Absent unless the caller supplied a target, which is
 *     what keeps an omitted input's output byte-identical to the pre-#1854 text.
 */
import { reviewedDigestOf } from "./plan-filing-claim.ts";
import type { PlanProvenance } from "./plan-provenance.ts";
import type { PlanResult } from "./plan-types.ts";

/** The driver's final-return inputs, plus the two the builder does not decide. */
export interface FinalPlanResultArgs extends PlanResultFields {
  /** #1854: the canonical target identity; undefined for a session-repo run. */
  targetIdentity?: string;
  /** The labels the filing would send — a digest input, not a body input. */
  labels?: string[];
  /** The provenance lines appended after the reviewed body — also a digest input. */
  provenance?: PlanProvenance;
  /** True when this run is a dry run (explicit, or a held re-draft). */
  asDryRun: boolean;
}

export function buildFinalPlanResult(a: FinalPlanResultArgs): PlanResult {
  const { targetIdentity, labels, provenance, asDryRun, ...fields } = a;
  return buildPlanResult({
    ...fields,
    ...(targetIdentity ? { targetRepository: targetIdentity } : {}),
    reviewedDigest:
      asDryRun && !fields.filingFailure
        ? reviewedDigestOf(fields.title, fields.spec, {
            labels,
            provenance,
            ...(targetIdentity ? { target: targetIdentity } : {}),
          })
        : undefined,
  });
}
