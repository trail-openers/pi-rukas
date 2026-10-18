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
import { trace } from "./trace.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { foldTwo } from "./workstream-fold.ts";

/**
 * A `report_workstream` call's arguments, as Pi validated them. Optional lines
 * add no keys when absent, so a plan without them has the pre-#1322 shape.
 */
export function workstreamFromArgs(args: Record<string, unknown>): Workstream {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const dependsOn = list(args.dependsOn);
  const introduces = list(args.introduces);
  const consumes = list(args.consumes);
  const integrationTest = typeof args.integrationTest === "string" ? args.integrationTest : "";
  return {
    id: String(args.id),
    scope: String(args.scope),
    paths: list(args.paths),
    outOfScope: list(args.outOfScope),
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
