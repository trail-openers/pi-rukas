/**
 * work-queue-scheduler — #1101: what a `/work` worker waits for before it may
 * claim a group.
 *
 * The queue's whole pre-dispatch policy used to be one expression: defer if an
 * in-flight group at an EARLIER cursor position has overlapping *extracted*
 * paths. Three defects lived inside that expression, and the operator-visible
 * symptom of all three was the queue refusing work it should have run.
 *
 *  1. **Cursor order stood in for dependency order.** A group whose declared
 *     dependency sat LATER in the list was not held back at all — the check
 *     only ever looked backwards — so the dependent started first and the
 *     dependency arrived after it had already committed. Dependency edges are
 *     a property of the issues, not of the sort order, so they are checked
 *     independently of position.
 *  2. **Extracted paths were the only signal.** `groupIssues()` extracts
 *     nothing from a body that names files only in prose, and
 *     `groupPathsOverlap` answers "no overlap" for an empty set on either
 *     side. The pair then ran concurrently and the reactive plan-time claim
 *     check parked the loser with `cross-group-conflict` — after an
 *     explore + plan dispatch had already been paid for. A *prediction* of
 *     collision now holds the group back instead; only a collision the queue
 *     cannot predict at all still reaches the reactive check.
 *  3. **Waited-for was the same as still-running.** A sibling's `runGroup`
 *     settling is what releases its claim, and it settles on every terminal
 *     outcome — merged, parked, refused, thrown. The waiting group does not
 *     care which. So a sibling that parked still releases; the bug was that
 *     nothing could reach the terminal state to begin with when the ordering
 *     edge pointed at a group that had already parked for an unrelated reason.
 *
 * The cap that bounds all of this changed direction too, and deliberately:
 * the old code DROPPED a deferral after 30 minutes and let the group proceed,
 * on the theory that the reactive check would catch a real conflict. For an
 * ordering edge that theory is backwards — proceeding is the failure the
 * issue is about, and it is the irreversible one, because a dependent built
 * before its dependency has merged cannot be un-built. A cap-out now PARKS
 * with the reason naming the group that never released, never proceeds.
 *
 * Deadlock discipline: the ordering wait ignores cursor position on purpose
 * (an edge that points forward is the case the old check missed), which makes
 * a wait-for cycle across workers possible in principle. It is closed before
 * dispatch, not at runtime: `findCyclicGroups` runs over the whole graph and
 * every group in a cycle parks before any worker blocks. A cycle detected
 * mid-flight (state the pre-pass did not see) hits the same cap, so the worst
 * case is a named park, never a hang.
 *
 * Pure module: takes a snapshot of queue state, returns a decision. The queue
 * owns the maps; this owns the reasoning.
 */

import { trace } from "./trace.ts";
import { groupPathsOverlap, predictedPathsCollide } from "./work-queue-overlap.ts";
import type { IssueGroup } from "./work-queue-types.ts";

/** Why a group may not be claimed yet, or `null` when it may. */
export type BlockReason =
  | { kind: "ordering"; waitingOn: string[]; dependencyParkedOn?: string }
  | { kind: "claim"; heldBy: string[] }
  | null;

/** The slice of queue state a decision needs. Built by the worker; read-only here. */
export interface SchedulerSnapshot {
  /** The group a worker is trying to claim. */
  group: IssueGroup;
  /** Every group of the invocation, in dispatch order. */
  groups: IssueGroup[];
  /** Group ids claimed and not yet settled, in claim order. */
  inFlight: string[];
  /**
   * Group ids that have been taken and have no outcome yet.
   *
   * `inFlight` alone cannot answer "may I run alongside this sibling?": the
   * worker releases `inFlight` the instant `runGroup` settles, but the group
   * is not *settled* until its outcome is read and recorded, and in between it
   * is invisible to every set. A dependent that consulted only `inFlight`
   * could watch its dependency disappear there, conclude the overlap had
   * cleared, and dispatch alongside a cycle that had already committed.
   * `pending` is that intermediate state, and it holds the dependent back
   * exactly as long as the claim does.
   */
  pending: string[];
  /** Group ids whose `runGroup` resolved or threw. Release signal for a claim wait. */
  settled: string[];
  /** Group ids that reached `merged` — the only state that satisfies an ordering edge. */
  merged: string[];
  /** Cross-group ordering edges, keyed by the dependent group. */
  dependencies: Record<string, { blockingGroupIds: string[] }>;
  /** #1101 escape hatch: PI_ENSEMBLE_QUEUE_ORDERING=0 drops the ordering edge. */
  orderingEnabled: boolean;
}

/**
 * Whether the ordering gate is enabled.
 * Override: `PI_ENSEMBLE_QUEUE_ORDERING=0` — groups then dispatch under the
 * #676 overlap rule alone, which is the pre-#1101 behaviour.
 */
export function queueOrderingEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_QUEUE_ORDERING;
  return v !== "0" && v !== "false";
}

/**
 * Can this group be claimed right now?
 *
 * Precedence is deliberate: **ordering first, then claims.** When a group both
 * depends on a sibling and overlaps its paths, the ordering edge governs —
 * waiting for `merged` is strictly more conservative than waiting for the
 * sibling to settle, so the claim check adds nothing and must not add a second
 * park reason to the same group.
 */
export function blockReasonFor(snapshot: SchedulerSnapshot): BlockReason {
  const ordering = orderingBlock(snapshot);
  if (ordering) return ordering;
  return claimBlock(snapshot);
}

/**
 * The ordering half: every declared dependency must have SETTLED MERGED.
 *
 * A dependency that settled on any other outcome can never satisfy the edge —
 * waiting longer will not change its state — so the dependent parks with the
 * reason `dependency-parked:#N` rather than spinning until the cap. A
 * dependency that has not settled yet is a plain wait.
 */
function orderingBlock(snapshot: SchedulerSnapshot): BlockReason {
  if (!snapshot.orderingEnabled) return null;
  const blocking = snapshot.dependencies[snapshot.group.id]?.blockingGroupIds ?? [];
  if (blocking.length === 0) return null;
  const merged = new Set(snapshot.merged);
  const settled = new Set(snapshot.settled);
  const waitingOn: string[] = [];
  for (const dep of blocking) {
    if (merged.has(dep)) continue;
    if (!settled.has(dep)) {
      // Still running — the ordinary wait. Its outcome decides, later.
      waitingOn.push(dep);
      continue;
    }
    // Settled without merging: a parked dependency never satisfies its edge,
    // and waiting longer cannot change that. Say so now rather than at the cap.
    const depIssues = snapshot.groups.find((g) => g.id === dep)?.issues ?? [];
    return {
      kind: "ordering",
      waitingOn: [],
      dependencyParkedOn: depIssues.length > 0 ? `#${depIssues.join(", #")}` : dep,
    };
  }
  if (waitingOn.length === 0) return null;
  return { kind: "ordering", waitingOn };
}

/**
 * The claim half: never run alongside a sibling that predicts a collision.
 *
 * Two signals, because the queue has two independent views of what a group
 * touches: `groupIssues()`'s extracted tokens and the planner's declaration
 * that a later dispatch will produce. Either one is enough to hold a group
 * back — a false positive costs one serialised cycle, a false negative costs
 * the wasted dispatch this gate exists to prevent.
 *
 * Unlike the original #676 rule this is NOT restricted to earlier cursor
 * positions. The reason the old rule needed that restriction was the
 * claim-release question — with no terminal-state concept, a group waiting on
 * a later sibling could wait forever. With `settled` populated on every path
 * out of `runGroup`, a sibling always releases, in both directions, so the
 * asymmetry bought nothing and hid real overlaps.
 */
function claimBlock(snapshot: SchedulerSnapshot): BlockReason {
  const heldBy: string[] = [];
  // `pending` is unioned in, not consulted instead: a group is in flight only
  // while `runGroup` is on the stack, and pending covers the read-and-record
  // tail that follows it. See `SchedulerSnapshot.pending`.
  for (const id of new Set([...snapshot.inFlight, ...snapshot.pending])) {
    if (id === snapshot.group.id) continue;
    const other = snapshot.groups.find((g) => g.id === id);
    if (!other) continue;
    if (
      groupPathsOverlap(snapshot.group, other) ||
      predictedPathsCollide(snapshot.group.paths, other.paths)
    ) {
      heldBy.push(id);
    }
  }
  return heldBy.length > 0 ? { kind: "claim", heldBy } : null;
}

/**
 * One line for the trace, so "why is this group waiting" is answerable from
 * the log without re-deriving the graph. The trace is the only surface this
 * decision has while it is still a wait rather than an outcome.
 */
export function describeBlock(group: { id: string }, reason: Exclude<BlockReason, null>): string {
  if (reason.kind === "ordering") {
    if (reason.dependencyParkedOn) {
      return `${group.id} parked: its dependency ${reason.dependencyParkedOn} did not merge`;
    }
    return `${group.id} waiting on dependency group(s) ${reason.waitingOn.join(", ")}`;
  }
  return `${group.id} waiting on in-flight sibling(s) ${reason.heldBy.join(", ")} (predicted path collision)`;
}

/** The trace call site kept here so the queue's worker stays readable. */
export function traceBlock(group: { id: string }, reason: Exclude<BlockReason, null>): void {
  trace(`work-queue: ${describeBlock(group, reason)}`);
}
