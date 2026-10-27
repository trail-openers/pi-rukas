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
import { boundOutOfScope, fenceBoundNotice, fenceWasBounded } from "./plan-fence-bound.ts";
import { proseSelfFenceDrops } from "./plan-fence-prose.ts";
import { clippedField } from "./plan-fence-record.ts";
import { boundPaths, pathsBoundNotice } from "./plan-paths-bound.ts";
import { WORKSTREAM_ID_MAX, type WorkstreamArgs } from "./plan-workstream-schema.ts";
import { trace, traceWarn } from "./trace.ts";
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";
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
 *
 * `paths` is bounded by the same instinct and a different rule (#1756 part b):
 * duplicates collapse on the normalised identity and NOTHING is removed — the
 * whole list is the authorised set the scope gates read, and the prompts print
 * all of it. Only the schema ceiling still refuses a call.
 */
export function workstreamFromArgs(args: WorkstreamArgs): Workstream {
  const dependsOn = args.dependsOn ?? [];
  const introduces = args.introduces ?? [];
  const consumes = args.consumes ?? [];
  const integrationTest = args.integrationTest ?? "";
  const boundedPaths = boundPaths(args.paths);
  const fence = boundOutOfScope(args.outOfScope);
  if (fenceWasBounded(fence)) {
    traceWarn(fenceBoundNotice(`plan workstream '${args.id}'`, fence));
  }
  // #1862 (a) — a prose fence over this workstream's OWN files is dropped here,
  // at the tool boundary, rather than left for the develop gate to demote every
  // hit from. Only entries naming what THIS call declared go: a sibling's fence
  // (#572's cross-declaration contract) and prose that names no path stay. The
  // clip records of a dropped entry go with it, the way `capFenceList` drops a
  // record whose entry is gone — a record describing a vanished entry is a
  // disclosure of a loss that did not happen.
  const proseDrops = proseSelfFenceDrops(boundedPaths.paths, fence.entries);
  const dropped = new Set(proseDrops.map((d) => d.entry));
  for (const d of proseDrops) {
    traceWarn(
      `work-driver: plan workstream '${args.id}' self-fence dropped — ${JSON.stringify(d.entry)} covers its own declared ${d.path}`,
    );
  }
  if (boundedPaths.duplicate > 0) {
    // `traceWarn`, not `trace`: the fence bound's line is a WARN for the same
    // reason (#1744) — an operator greps one channel for every bound the driver
    // applied, and a display bound nobody sees is a bound nobody can audit.
    traceWarn(
      pathsBoundNotice(`plan workstream '${args.id}'`, {
        kept: boundedPaths.paths.length,
        duplicate: boundedPaths.duplicate,
      }),
    );
  }
  return {
    id: args.id.slice(0, WORKSTREAM_ID_MAX),
    scope: args.scope,
    paths: boundedPaths.paths,
    outOfScope: fence.entries.filter((e) => !dropped.has(e)),
    ...clippedField(fence.clipped.filter((r) => !(r.kind === "clipped" && dropped.has(r.entry)))),
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
 * paths union, out-of-scope union minus the merged workstream's own files,
 * scope annotated — so the work is never silently dropped, which a hard
 * truncation would do.
 *
 * #1862 — returns `{ workstreams, selfFenceDrops }`: the fences the folds
 * removed because they fenced the merged workstream's declared paths, so the
 * caller that persists plan quality can record them.
 */
export function foldToCeiling(entries: Workstream[]): {
  workstreams: Record<string, Workstream>;
  selfFenceDrops: UnfenceRecord[];
} {
  const out: Record<string, Workstream> = {};
  const selfFenceDrops: UnfenceRecord[] = [];
  // The paths union as the pass accumulates it: every fold appends the absorbed
  // half's entries here and the pass bounds the whole list ONCE at the end
  // (#1756 round 2). Re-dedupeing the growing union for each absorbed
  // workstream was O(n²) normalisations to produce one number, and the line it
  // printed reported `0 kept`.
  const union: string[] = [];
  for (const entry of entries) {
    if (Object.keys(out).length >= effectiveMaxWorkstreams()) {
      const lastId = Object.keys(out)[Object.keys(out).length - 1];
      if (!lastId) continue;
      const last = out[lastId];
      if (last) {
        union.push(...entry.paths);
        const folded = foldTwo(last, entry);
        selfFenceDrops.push(...folded.selfFenceDrops);
        // The ceiling fold's annotation is `+folded:` (the coupling merge's
        // `+merged:` is the other site's wording).
        folded.workstream.scope = `${last.scope} (+folded: ${entry.id})`;
        out[lastId] = folded.workstream;
        trace(`work-driver: plan exceeded MAX_WORKSTREAMS — folded '${entry.id}' into '${lastId}'`);
      }
      continue;
    }
    union.push(...entry.paths);
    out[entry.id] = entry;
  }
  // ONE line for the whole pass, not one per fold (#1756 part b): a crowded
  // plan absorbs N workstreams and the duplicate count is a property of the
  // pass, not of each fold. `kept` is the length of the union actually stored.
  const boundedPaths = boundPaths(union);
  if (boundedPaths.duplicate > 0) {
    traceWarn(
      pathsBoundNotice("plan ceiling fold", {
        kept: boundedPaths.paths.length,
        duplicate: boundedPaths.duplicate,
      }),
    );
  }
  return { workstreams: out, selfFenceDrops };
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
