/**
 * work-driver-plan-workstreams — the workstream map a plan step keeps, built
 * from its `report_workstream` calls (#1652), plus maxWorkstreams.
 *
 * The markdown `## Workstreams` parser is gone. A reply's prose is not read for
 * workstreams any more: the planner reports each one through a schema-validated
 * tool call (workstream-reporter.ts), and work-driver-plan-calls.ts turns the
 * ACCEPTED calls into entries. What survives here is the ceiling fold, which
 * applies to whatever set arrives, however it arrived.
 */

import { hostBudget } from "./host-resources.ts";
import { boundOutOfScope, clippedField, fenceBoundNotice } from "./plan-fence-bound.ts";
import { WORKSTREAM_ID_MAX, type WorkstreamArgs } from "./plan-workstream-schema.ts";
import { trace, traceWarn } from "./trace.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { foldTwo } from "./workstream-fold.ts";

/**
 * A `report_workstream` call's arguments, already checked against the schema by
 * the reader (work-driver-plan-calls.ts). Optional lines add no keys when absent,
 * so a plan without them has the pre-#1322 shape.
 *
 * This is the ONE place a reported `outOfScope` becomes a stored one, so it is
 * where the fence is BOUNDED (#1744): clipped at `WORKSTREAM_FENCE_MAX`, a path
 * list written as one entry split into its parts, duplicates collapsed, the list
 * capped at `WORKSTREAM_LIST_MAX`. The schema accepts a long entry rather than
 * refusing the call, and what was bounded is both recorded on the workstream and
 * said on the trace — a fence that quietly disappeared is the failure this
 * closes. The warning counts clipped, cap-dropped and blank-dropped entries
 * SEPARATELY and measures `kept` against the expanded list, so the numbers add
 * up to what the planner actually wrote.
 */
export function workstreamFromArgs(args: WorkstreamArgs): Workstream {
  const dependsOn = args.dependsOn ?? [];
  const introduces = args.introduces ?? [];
  const consumes = args.consumes ?? [];
  const integrationTest = args.integrationTest ?? "";
  const fence = boundOutOfScope(args.outOfScope);
  if (fence.clipped.length > 0) {
    traceWarn(fenceBoundNotice(`plan workstream '${args.id}'`, fence));
  }
  return {
    id: args.id.slice(0, WORKSTREAM_ID_MAX),
    scope: args.scope,
    paths: [...args.paths],
    outOfScope: fence.entries,
    ...clippedField(fence.clipped),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(integrationTest ? { integrationTest } : {}),
    ...(introduces.length > 0 ? { introduces } : {}),
    ...(consumes.length > 0 ? { consumes } : {}),
  };
}

/**
 * #290 — ceiling on workstreams per cycle. Each workstream becomes a worktree
 * AND a developer child, so M is a direct multiplier on process count. Excess
 * FOLDS into the last kept workstream — the shared fold (workstream-fold.ts):
 * paths union, out-of-scope union minus the merged paths, scope annotated — so
 * the work is never silently dropped, which a hard truncation would do.
 */
export function foldToCeiling(entries: Workstream[]): Record<string, Workstream> {
  const out: Record<string, Workstream> = {};
  for (const entry of entries) {
    if (Object.keys(out).length >= effectiveMaxWorkstreams()) {
      const lastId = Object.keys(out)[Object.keys(out).length - 1];
      if (!lastId) continue;
      const last = out[lastId];
      if (last) {
        const folded = foldTwo(last, entry);
        // The ceiling fold's annotation is `+folded:` (the coupling merge's
        // `+merged:` is the other site's wording).
        folded.scope = `${last.scope} (+folded: ${entry.id})`;
        out[lastId] = folded;
        trace(`work-driver: plan exceeded MAX_WORKSTREAMS — folded '${entry.id}' into '${lastId}'`);
      }
      continue;
    }
    out[entry.id] = entry;
  }
  return out;
}

/** #290 — ceiling on workstreams per cycle. Override: PI_ENSEMBLE_MAX_WORKSTREAMS. */
export function maxWorkstreams(): number {
  const env = Number(process.env.PI_ENSEMBLE_MAX_WORKSTREAMS);
  return Number.isFinite(env) && env >= 1 ? env : 6;
}

/**
 * #1325 — the ceiling a plan is actually folded to: `maxWorkstreams()` lowered
 * to the host's workstream slots. An explicit `PI_ENSEMBLE_MAX_WORKSTREAMS`
 * wins over the budget.
 */
export function effectiveMaxWorkstreams(): number {
  if (Number(process.env.PI_ENSEMBLE_MAX_WORKSTREAMS) >= 1) return maxWorkstreams();
  return Math.min(maxWorkstreams(), hostBudget().workstreamSlots);
}
