/**
 * work-entry-ordering — #1101: the `/work` queue's ordering graph, computed at
 * the entry point that owns the issue bodies.
 *
 * `runWorkQueue` takes `dependencies` and `cyclic` and its scheduler obeys
 * them, but it does not — and cannot — discover them: it is handed
 * `IssueGroup[]`, not issue bodies. The bodies live at the entry point
 * (`runGroupedIssues` fetches them for the grouping pass), so the edges have to
 * be computed there and threaded in. Before this module the entry point passed
 * neither option, which made the whole ordering gate inert in production: every
 * real `/work 12 13` where 13 said `Depends-on: #12` still started the two
 * groups side by side, and the feature survived only in tests that passed the
 * edges by hand.
 *
 * Two decisions live here, and both are the reason this is a module rather
 * than four lines inline:
 *
 *  - **Edges come from `groupIssues()`'s `depsByIssue`, never from a fresh
 *    scan of the bodies.** The grouping pass already read every body and
 *    already ran the ordering regex; re-reading here would be a second regex
 *    over the same text that can drift from the one the grouping decisions
 *    were actually made with.
 *  - **`PI_ENSEMBLE_QUEUE_ORDERING=0` skips the computation entirely**, rather
 *    than computing the graph and letting the queue ignore it. A cycle
 *    `findCyclicGroups` reports is an ordering claim, and an operator who said
 *    ordering is off should not have a group parked for one. The queue reads
 *    the same switch independently and stays fail-safe if edges arrive anyway.
 *
 * Extracted from work-entry.ts for AGENTS.md §12's 500-line cap; the seam is
 * also what lets the wiring be asserted without a driver spawn.
 */

import type { GroupingResult } from "./work-driver-grouping.ts";
import { type OrderingPlan, planOrderingEdges } from "./work-queue-deps.ts";
import { queueOrderingEnabled } from "./work-queue-scheduler.ts";

/** An ordering plan with no edges — what the escape hatch returns. */
const NO_ORDERING: OrderingPlan = { byGroup: {}, cyclic: [], notes: [] };

/**
 * The ordering graph the queue enforces for one grouped `/work` invocation.
 *
 * `grouping` is the result the caller already has — `groupIssues()` collected
 * the `Depends-on: #N` / `blocked by #N` statements in the same pass that
 * decided the groups, so nothing re-reads a body.
 *
 * Returns an empty plan when `PI_ENSEMBLE_QUEUE_ORDERING=0`: no edges to wait
 * on, and no cycle to park for.
 */
export function queueOrderingPlan(
  grouping: Pick<GroupingResult, "groups" | "depsByIssue">,
): OrderingPlan {
  if (!queueOrderingEnabled()) return NO_ORDERING;
  const groups = Object.values(grouping.groups);
  return planOrderingEdges(groups, grouping.depsByIssue);
}
