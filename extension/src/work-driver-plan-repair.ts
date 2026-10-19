/**
 * work-driver-plan-repair — the single-workstream repair of omitted spec
 * deliverable paths.
 *
 * The incident (#1439, run 5): the plan had ONE workstream, the spec named two
 * test files for one deliverable, and the planner left both out on two
 * attempts. The plan-to-spec gate (#819) parked the cycle as
 * `plan-spec-mismatch` before develop ever ran.
 *
 * With exactly one workstream there is no judgement left to make about WHICH
 * workstream owns a missing path: the only owner is the one workstream. So,
 * deterministically and before the one-shot corrective is spent, the driver
 * appends the omitted paths to that workstream's `paths` — and only when every
 * missing path is safe to add:
 *
 *   - a single plain path, not an either/or (`a.ts or b.ts` is a choice the
 *     planner must make, so it keeps today's behaviour);
 *   - not a protected path (`isProtectedPath`), granted or not;
 *   - not fenced in the workstream's `outOfScope`;
 *   - not a deferred protected path (#1642).
 *
 * One missing path that fails any of these and nothing is repaired: the gate
 * then runs exactly as before. N>1 workstreams are never repaired — which
 * workstream owns the path is a judgement.
 *
 * What the repair adds is disclosed on the resolved spec as one assumption, so
 * the PR body says what the driver changed rather than the plan silently
 * differing from the model's output.
 */

import { declaredPathsCoveredBy, splitDeliverablePaths } from "./work-driver-deliverable-paths.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import type { SpecAssumption } from "./work-driver-intent.ts";
import { deferredProtectedPaths } from "./work-driver-plan-fence.ts";
import {
  type SpecCoverageSpec,
  findUncoveredDeliverables,
} from "./work-driver-plan-spec-coverage.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/** A repair: the workstreams with the paths appended, and what was appended. */
export type OmittedPathRepair = {
  workstreams: Record<string, Workstream>;
  added: string[];
};

/** The basis every repair assumption carries; rendered beside its text. */
export const OMITTED_PATH_BASIS =
  "plan-to-spec gate (single-workstream repair): spec deliverable path the plan omitted";

/**
 * Appends the omitted deliverable paths to the sole workstream, or returns
 * `undefined` when there is nothing to repair or any missing path is not safe
 * to add (the caller then runs the gate unchanged).
 */
export function repairOmittedDeliverablePaths(
  workstreams: Record<string, Workstream>,
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
): OmittedPathRepair | undefined {
  const ids = Object.keys(workstreams);
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) return undefined;
  const ws = workstreams[id];
  if (!ws) return undefined;
  const { uncovered } = findUncoveredDeliverables(workstreams, spec, grant);
  if (uncovered.length === 0) return undefined;

  const deferred = new Set(deferredProtectedPaths(spec, grant));
  const fenced = new Set(ws.outOfScope.map((e) => normaliseDeclaredPath(e)));
  const added: string[] = [];
  for (const row of uncovered) {
    for (const slot of row.paths) {
      // Already covered by the workstream: only the missing slots are added.
      if (declaredPathsCoveredBy(slot, ws.paths)) continue;
      // An either/or slot is the planner's choice between alternatives.
      const alternatives = splitDeliverablePaths(slot);
      const [path] = alternatives;
      if (alternatives.length !== 1 || path === undefined) return undefined;
      if (isProtectedPath(path) || fenced.has(path) || deferred.has(path)) return undefined;
      if (!added.includes(path)) added.push(path);
    }
  }
  if (added.length === 0) return undefined;
  return {
    workstreams: { [id]: { ...ws, paths: [...ws.paths, ...added] } },
    added,
  };
}

/** The one line a reviewer reads for the repair. */
export function omittedPathAssumptionText(added: readonly string[]): string {
  return `driver added spec deliverable paths the plan omitted: ${added.join(", ")}`;
}

/**
 * Returns `state` with one assumption recording the repair appended to
 * `pipelineState.normalisedSpec` (idempotent), promoting a `proceed` verdict to
 * `proceed-with-assumptions` as the deferral notice does. Without a normalised
 * spec the trace is the only record.
 */
export function withOmittedPathAssumption(state: WorkState, added: readonly string[]): WorkState {
  const ns = state.pipelineState.normalisedSpec;
  if (!ns || added.length === 0) return state;
  const text = omittedPathAssumptionText(added);
  if (ns.assumptions.some((a) => a.text === text)) return state;
  const assumption: SpecAssumption = { text, basis: OMITTED_PATH_BASIS };
  const verdict = ns.verdict === "proceed" ? "proceed-with-assumptions" : ns.verdict;
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      normalisedSpec: {
        ...ns,
        verdict,
        assumptions: [...ns.assumptions, assumption],
      },
    },
  };
}
