/**
 * work-driver-plan-deferral-notice — #1642 review: a protected slot the
 * plan-to-spec gate deferred is DISCLOSED, not only traced.
 *
 * A deliverable whose protected half the cycle may not write (no
 * `--allow-protected` grant) is excluded from the coverage requirement. That is
 * the right gate behaviour, but a trace line is invisible to the PR reviewer:
 * the PR would read as if the whole deliverable had been built. So each
 * deferred path becomes one assumption on the resolved spec, and
 * `renderAssumptions` puts it in the PR body.
 *
 * Idempotent: an assumption whose text is already present is not appended
 * again, so a re-run of the plan tail does not duplicate the notice. Without a
 * normalised spec there is nowhere to write, and the trace stays the only record.
 */

import type { SpecAssumption } from "./work-driver-intent.ts";
import { type SpecCoverageSpec, protectedDeferralsOf } from "./work-driver-plan-spec-coverage.ts";
import type { WorkState } from "./workflow-state.ts";

/** The basis every deferral assumption carries; rendered beside its text. */
export const DEFERRAL_BASIS =
  "plan-to-spec gate (#1642): protected path, no --allow-protected grant";

/** The one line a reviewer reads for a deferred path. */
export function deferralAssumptionText(id: string, path: string): string {
  return `Deferred ${id} path ${path}: protected; this cycle has no --allow-protected grant for it, so it was not changed. Re-run with --allow-protected ${path} to include it.`;
}

/**
 * Returns `state` with one assumption per deferred protected path appended to
 * `pipelineState.normalisedSpec`, or `state` itself when there is nothing new
 * to record. A `proceed` verdict is promoted to `proceed-with-assumptions`, the
 * same rule the intent step applies, so the spec does not claim a clean proceed
 * while carrying a disclosed gap.
 */
export function withProtectedDeferralAssumptions(
  state: WorkState,
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
): WorkState {
  const ns = state.pipelineState.normalisedSpec;
  if (!ns) return state;
  const seen = new Set(ns.assumptions.map((a) => a.text));
  const added: SpecAssumption[] = [];
  for (const d of protectedDeferralsOf(spec, grant)) {
    for (const path of d.paths) {
      const text = deferralAssumptionText(d.id, path);
      if (seen.has(text)) continue;
      seen.add(text);
      added.push({ text, basis: DEFERRAL_BASIS });
    }
  }
  if (added.length === 0) return state;
  const verdict = ns.verdict === "proceed" ? "proceed-with-assumptions" : ns.verdict;
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      normalisedSpec: { ...ns, verdict, assumptions: [...ns.assumptions, ...added] },
    },
  };
}
