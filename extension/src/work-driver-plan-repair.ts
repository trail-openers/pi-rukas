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
 * appends the omitted paths to that workstream's `paths` — and only when the
 * workstream already owns at least one measurable deliverable path (a plan that
 * covers nothing of the spec is a wrong plan, not an omitted one, and is left
 * to the gate) and every missing path is safe to add:
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

import {
  declaredPathsCoveredBy,
  measurableAlternative,
  splitDeliverablePaths,
  toAlternative,
} from "./work-driver-deliverable-paths.ts";
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
type OmittedPathRepair = {
  workstreams: Record<string, Workstream>;
  added: string[];
};

/** The basis every repair assumption carries; rendered beside its text. */
const OMITTED_PATH_BASIS =
  "plan-to-spec gate (single-workstream repair): spec deliverable path the plan omitted";

/**
 * Appends the omitted deliverable paths to the sole workstream, or returns
 * `undefined` when there is nothing to repair, or when a repair is declined —
 * the caller then runs the gate unchanged. `onRefuse` receives the reason for
 * a decline, so the caller can trace it.
 */
export function repairOmittedDeliverablePaths(
  workstreams: Record<string, Workstream>,
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
  onRefuse: (reason: string) => void = () => undefined,
): OmittedPathRepair | undefined {
  const refuse = (reason: string): undefined => {
    onRefuse(reason);
    return undefined;
  };
  const ids = Object.keys(workstreams);
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) return undefined;
  const ws = workstreams[id];
  // Fail closed: without a normalised spec there is no deliverable to repair to.
  if (!ws || !spec) return undefined;
  const { uncovered } = findUncoveredDeliverables(workstreams, spec, grant);
  if (uncovered.length === 0) return undefined;
  // Evidence the plan targets THIS spec: at least one measurable deliverable slot
  // is already covered by the workstream. Without it the plan is wholly wrong,
  // and extending it would hide that rather than repair an omission.
  const targetsSpec = (spec.deliverables ?? []).some((d) =>
    d.paths.some(
      (slot) =>
        declaredPathsCoveredBy(slot, ws.paths) &&
        splitDeliverablePaths(slot).map(toAlternative).some(measurableAlternative),
    ),
  );
  if (!targetsSpec)
    return refuse(
      "the sole workstream covers no spec deliverable path, so it is the wrong plan, not an omitted one",
    );

  const deferred = new Set(deferredProtectedPaths(spec, grant));
  // A fence covers the path and everything under it, as the gate's
  // `findFenceContradictions` reads it.
  const fences = ws.outOfScope
    .map((e) => normaliseDeclaredPath(e).replace(/\/+$/, ""))
    .filter((n) => n.length > 0);
  const fenced = (path: string) => fences.some((n) => path === n || path.startsWith(`${n}/`));
  const added: string[] = [];
  for (const row of uncovered) {
    for (const slot of row.paths) {
      // Already covered by the workstream: only the missing slots are added.
      if (declaredPathsCoveredBy(slot, ws.paths)) continue;
      // An either/or slot is the planner's choice between alternatives, and a
      // template (`<name>`, `work-driver-<name>.ts`) is a pattern, not a file:
      // writing it literally is the #1155 failure the grammar exists to prevent.
      const alternatives = splitDeliverablePaths(slot).map(toAlternative);
      const [alt] = alternatives;
      if (alternatives.length !== 1 || alt === undefined)
        return refuse(`${slot}: an either/or slot is the planner's choice`);
      if (alt.isGlob || !measurableAlternative(alt))
        return refuse(`${slot}: not a single measurable file path`);
      const path = normaliseDeclaredPath(alt.raw);
      if (path.length === 0) return refuse(`${slot}: empty after normalisation`);
      if (isProtectedRepairPath(path)) return refuse(`${path}: protected path`);
      if (fenced(path)) return refuse(`${path}: fenced in the workstream's outOfScope`);
      if (deferred.has(path)) return refuse(`${path}: deferred protected path`);
      if (!added.includes(path)) added.push(path);
    }
  }
  if (added.length === 0) return undefined;
  return {
    workstreams: { [id]: { ...ws, paths: [...ws.paths, ...added] } },
    added,
  };
}

/**
 * A repair never adds a protected path, however it is spelled: `.GitHub/…`,
 * `.PI/verify-cmd` and a bare `.pi` are the same capabilities on a
 * case-insensitive checkout.
 */
function isProtectedRepairPath(path: string): boolean {
  const folded = path.replace(/\\/g, "/").toLowerCase();
  if (folded.split("/").some((s) => s === ".github" || s === ".pi")) return true;
  return isProtectedPath(path) || isProtectedPath(folded);
}

/** The one line a reviewer reads for the repair. */
function omittedPathAssumptionText(added: readonly string[]): string {
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
