/**
 * work-queue-types — the queue's data shapes.
 *
 * Split out of work-queue.ts for #1101. Not a convenience: `work-queue.ts`
 * imports the worker, the worker imports the scheduler, and both need
 * `IssueGroup` / `QueueEntry`. Importing those from `work-queue.ts` would make
 * the module graph a cycle whose resolution order decides whether a module
 * body sees its own types — which is fine for `type` imports and quietly fatal
 * the first time someone adds a runtime helper here. The leaf is the leaf.
 *
 * `IssueGroup` stays derived from `GroupingResult` rather than being restated:
 * the queue iterates what `groupIssues()` produces, and a hand-written copy of
 * that shape is a second definition that can drift out of sync with the one
 * the grouping pass actually emits.
 */

import type { GroupingResult } from "./work-driver-grouping.ts";

/** One entry of `groupIssues()`'s result — the unit the queue iterates. */
export type IssueGroup = GroupingResult["groups"][string];

/** What `runGroup` reports back. `started: false` means it never ran. */
export interface GroupOutcome {
  started: boolean;
  reason?: string;
}

export interface QueueEntry {
  groupId: string;
  issues: number[];
  outcome: "merged" | "parked" | "halted" | "not-started";
  /** Operator-facing why, for parked/halted. */
  reason?: string;
  /** The step the cycle died on, when known. */
  failedStep?: string;
  /** What the operator has to do — an action, never "it failed". */
  humanAction?: string;
  /** Raw token sum across the group's dispatch-completed/failed events
   * (input+output+cacheRead+cacheWrite); older summaries predate it. */
  tokens?: number;
  cost?: number; // USD, when the total is priced; never estimated when unknown
}

export interface QueueSummary {
  entries: QueueEntry[];
  merged: number;
  parked: number;
  refused: number; // #368 — a refusal is not a failure; no operator action
  notStarted: string[]; // groups the queue never reached — it halted first
}
