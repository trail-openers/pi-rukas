/**
 * work-entry-queue — #1101: the queue half of the grouped `/work` entry point.
 *
 * `runGroupedIssues` in `work-entry.ts` owns the invocation: it fetches the
 * bodies, groups them, computes the ordering graph, opens the sibling-claim
 * window, and then hands the whole thing to `runWorkQueue`. The hand-off is a
 * large object literal with a driver stub inside it, and `work-entry.ts` had
 * grown past AGENTS.md §12's 500-line cap carrying it. The seam is also the
 * honest one: everything above it is about the INVOCATION (what the operator
 * asked for) and everything below it is about the QUEUE (how the groups run),
 * and the `EntrySeams` pair is the boundary the test suite injects at.
 *
 * Nothing here decides ordering — `work-entry-ordering.ts` builds the graph and
 * `work-queue.ts` enforces it. This module is the only place that connects the
 * two, which is exactly where #1101's feature went missing: `runWorkQueue` took
 * `dependencies` and `cyclic`, and this call passed neither.
 */

import { setJobIssues } from "./async-jobs-registry.ts";
import { startJob } from "./async-jobs.ts";
import type { DriverHost } from "./work-driver-host.ts";
import { setSiblingClaimWait } from "./work-driver-path-claims.ts";
import { runWorkDriver } from "./work-driver.ts";
import type { EntrySeams } from "./work-entry.ts";
import type { OrderingPlan } from "./work-queue-deps.ts";
import type { IssueGroup } from "./work-queue-types.ts";
import { runWorkQueue } from "./work-queue.ts";

/**
 * The DispatchResult a completed group reports.
 *
 * The work-driver is an in-process, non-LLM cycle: no agents spawned, so
 * toolUses/usage/transcriptPath are structurally meaningless here (the
 * `dispatch-completed` event carries the real timing). Built by the entry
 * module's `makeResult` — passed in rather than duplicated here so the grouped
 * path and the single-issue path cannot drift in what the async-jobs layer
 * sees for a driver-owned job.
 */
type GroupResult = import("./types.ts").DispatchResult;

/** What this module needs from the invocation, already analysed. */
export interface QueueLaunch {
  repoRoot: string;
  groups: IssueGroup[];
  restart: boolean;
  concurrency: number;
  mergeGrant: boolean;
  protectedGrant: string[];
  headless: boolean | undefined;
  /** The ordering graph from `queueOrderingPlan()` — passed through untouched. */
  ordering: OrderingPlan;
  /**
   * Every issue of the invocation, for the sibling-claim window. Not derived
   * from `groups`: the window covers what the OPERATOR asked for, and a group
   * the grouping pass dropped is still a same-process cycle the queue could be
   * waiting on.
   */
  issues: number[];
  /** Builds the result a finished group reports (the entry module's `makeResult`). */
  makeResult: (ok: boolean, text: string, startMs: number, error?: string) => GroupResult;
  seams?: EntrySeams;
}

/**
 * Run the queue for one grouped invocation and return its summary.
 *
 * The sibling-claim window opens here and closes in the `finally`: `runWorkQueue`
 * never returns without every group having an outcome, so this is the narrowest
 * scope that is still correct — the plan-time claim check must see the sibling
 * set for the whole life of the queue, and must not see it afterwards.
 */
export async function launchQueue(pi: DriverHost, launch: QueueLaunch): Promise<unknown> {
  const {
    repoRoot,
    groups,
    restart,
    concurrency,
    mergeGrant,
    protectedGrant,
    headless,
    ordering,
    issues,
    makeResult,
    seams,
  } = launch;
  setSiblingClaimWait(issues);
  try {
    return await runWorkQueue({
      repoRoot,
      groups,
      restart,
      concurrency,
      dependencies: ordering.byGroup,
      cyclic: ordering.cyclic,
      runGroup: async (primary, groupIssueNums, invocationStartRef) => {
        const handle = startJob(pi, {
          label: `work-driver-group:${groups.find((g) => g.issues[0] === primary)?.id ?? "unknown"}`,
          role: "work-driver",
          skipDeck: true,
          ownerKind: "driver" as const,
          work: async () => {
            if (seams?.runDriver) {
              await seams.runDriver(primary, {
                issues: groupIssueNums,
                parallelCycles: concurrency,
                invocationStartRef,
              });
            } else {
              await runWorkDriver({
                host: pi,
                repoRoot,
                issue: primary,
                issues: groupIssueNums,
                restart,
                mergeGrant,
                protectedGrant,
                headless,
                parallelCycles: concurrency,
                invocationStartRef,
              });
            }
            return makeResult(
              true,
              `Completed group: #${(groupIssueNums ?? [primary]).join(", #")}`,
              Date.now(),
            );
          },
        });
        setJobIssues(handle.jobId, groupIssueNums ?? [primary]);
        // #676 — hold the runWorkQueue worker slot (and the inFlight entry the
        // pre-dispatch overlap gate keys on) until the driver reaches a terminal
        // state. startJob is fire-and-forget; without this await, runGroup would
        // resolve within the same event-loop tick and the gate's inFlight map
        // would be empty by the time the next worker checks it, making the
        // pre-dispatch serialization a no-op on the real entry path.
        await handle.completion;
        return { started: true };
      },
    });
  } finally {
    setSiblingClaimWait(null);
  }
}
