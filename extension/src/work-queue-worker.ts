/**
 * work-queue-worker — #1101: the queue's claim loop, extracted so the
 * reasoning around it can be read (and tested) without the file it grew from
 * crossing AGENTS.md §12's 500-line cap.
 *
 * One invariant lives here that the rest of the queue depends on and that no
 * other module can state: **every exit from `runGroup` settles the group.**
 * Resolved, thrown, refused-before-start — `settled` is stamped in the
 * `finally`, in the same synchronous step that drops the in-flight entry.
 * That is what makes it safe for the scheduler to stop restricting its waits
 * to earlier cursor positions: a sibling always releases, in both directions,
 * so the asymmetry the old rule needed as a deadlock guard bought nothing and
 * hid every ordering edge that pointed forward.
 *
 * The second invariant is the pair `settled` / `merged`. A sibling that
 * parked releases its CLAIM (nothing is being edited any more) but never
 * satisfies an ORDERING edge (the dependency it was supposed to deliver does
 * not exist). Collapsing the two sets would make a parked dependency either
 * a permanent wait or a free pass, depending on which way the check was
 * written.
 *
 * `outcomeOf` is recorded alongside both, so a dependent that reads a settled
 * group can be told *why* it never merged — that is the difference between
 * `dependency-parked:#N` and a cap-out nobody can explain.
 *
 * The third invariant is the one a reader cannot infer from the loop and that
 * #1101 had to learn the hard way: **waiting never blocks the scan.** The
 * cursor is a scan position, not a claim queue, so a group that cannot be
 * claimed is skipped and remembered (`deferred`) rather than sat on. Parking
 * the workers on one blocked group looks harmless at K=1 and is a wedge the
 * moment K>1: the blocked group is never *claimed*, so it never settles, so
 * nothing can release the wait — the queue waits on a group whose turn it is
 * blocking. Case 13 of `test-work-queue-ordering.ts` is exactly that shape,
 * and it hung for the whole defer cap before this was fixed.
 */

import { trace } from "./trace.ts";
import { type BlockReason, blockReasonFor, traceBlock } from "./work-queue-scheduler.ts";
// Re-exported: the queue asks the worker for the gate's state rather than
// importing the scheduler itself, which keeps the scheduler a leaf with one
// consumer and the env-var read in exactly one place.
export { queueOrderingEnabled } from "./work-queue-scheduler.ts";
// The reporting half of the loop lives in work-queue-outcome.ts (§12 line cap)
// and the sets it mutates are documented in work-queue-waitlist.ts.
import {
  capOutWait,
  classify,
  finishGroup,
  recordCrash,
  recordQueuePark,
} from "./work-queue-outcome.ts";
import type { GroupOutcome, IssueGroup, QueueEntry } from "./work-queue-types.ts";
import { dropDeferred, isDeferred } from "./work-queue-waitlist.ts";
import type { WaitEntry } from "./work-queue-waitlist.ts";
import type { WorkState } from "./workflow-state.ts";

/** Everything the loop touches, owned by `runWorkQueue` and mutated through
 * this object. Passed by reference on purpose: the worker's whole job is to
 * move groups between `inFlight`, `owners`, `settled` and `merged`, and a
 * copy would freeze the very state the scheduler reads. */
export interface WorkerState {
  repoRoot: string;
  groups: IssueGroup[];
  runGroup: (
    primary: number,
    issues: number[] | undefined,
    invocationStartRef: string | undefined,
  ) => Promise<GroupOutcome>;
  read: (repoRoot: string, issue: number) => Promise<WorkState | undefined>;
  /** Systemic-failure verdict for a finished group's state file. */
  isSystemic: (state: WorkState | undefined) => { systemic: boolean; reason?: string };
  /** #368 escape hatch: halt on the first non-merged group instead of parking. */
  haltOnFailure: () => boolean;
  /** Scan position, shared across workers: each group is examined once. */
  cursor: number;
  halted: boolean;
  entries: Map<number, QueueEntry>;
  /**
   * Groups that could not be claimed on the first pass and are being waited
   * on. Held outside the cursor so the scan reaches everything behind them
   * (see the module header); each worker re-tests all of them whenever any
   * group settles.
   */
  deferred: WaitEntry[];
  /** groupId → the cursor position it was claimed at. */
  inFlight: Map<string, number>;
  /**
   * Groups somebody has taken, whether or not they have an outcome yet.
   *
   * Written in the same synchronous step as `inFlight` on every claim, and
   * read by the scan to decide "do not touch this again". `inFlight` cannot
   * answer that question — a group that has finished is no longer in flight
   * but must still not be re-scanned — and `claimed` cannot either, because
   * the drain marks a group claimed before it has dispatched anything.
   */
  owners: Set<string>;
  /**
   * Waiters parked in `sleep()`. Woken whenever state changes in a way any
   * waiter could care about — a settle, a merge, a park, a halt, a cap.
   * Registered by `sleep()`, drained by `wake()`.
   */
  waiters: Array<() => void>;
  /**
   * Wake every parked waiter. Called synchronously from the state-change
   * sites so a waiter is never left to discover the change on its poll
   * interval; the poll is only the safety net for a change no site reported.
   */
  wake: () => void;
  /** Group ids whose `runGroup` resolved or threw — the release signal. */
  settled: Set<string>;
  /**
   * Group ids that have told the queue what they became.
   *
   * `settled` is written the moment a cycle stops holding anything back, which
   * is before its outcome is known; `entries` is written when the outcome is
   * known, which is after the group is safe to touch again. Neither answers
   * "has this group finished, or is it merely waiting?" — and the drain has to
   * ask exactly that before re-dispatching a group it parked. This is the one
   * bit that does, set in `finishGroup` and cleared only by a revive.
   */
  resolved: Set<string>;
  /** Group ids that reached `merged` — the only state satisfying an edge. */
  merged: Set<string>;
  /** What each group ended as, for a dependent's park reason. */
  outcomeOf: Map<string, QueueEntry["outcome"]>;
  /** When each group began waiting, for the wait cap. */
  deferralStart: Map<string, number>;
  dependencies: Record<string, { blockingGroupIds: string[] }>;
  orderingEnabled: boolean;
  deferCapMs: number;
  invocationStartRef: string | undefined;
}

/**
 * The ceiling on a re-test interval, not the interval itself.
 *
 * A worker does not poll on a timer — it parks on `wake()` and is woken the
 * instant anything it is waiting on changes (a sibling settles, a cap fires,
 * the queue halts). The timeout exists only for what no event covers, so it
 * is a safety net measured in seconds against a production cap measured in
 * tens of minutes, and tests with a cap of a few hundred ms are bounded by
 * the cap rather than by the poll.
 */
const MAX_POLL_MS = 1_000;

/**
 * The worker body: claim the next unclaimed group, run it, repeat.
 *
 * Extracted from `runWorkQueue`'s closure (#1101) — the state moves to a
 * parameter, the policy moves to the scheduler, and what stays here is the
 * bookkeeping that must happen in one synchronous step.
 *
 * A `Promise<void>` that resolves only when this worker has nothing left to
 * do: every group it could claim has run, and every group it could not claim
 * has an outcome or the queue has halted.
 */
export async function runQueueWorker(state: WorkerState): Promise<void> {
  for (;;) {
    if (state.halted) return;
    const gi = state.cursor;
    const g = state.groups[gi];
    if (!g) break;
    // #676 lens-findings — advance the cursor before continuing: a group with
    // an empty `issues` array (unreachable via groupIssues(), but possible
    // through the exported hand-built `IssueGroup[]`) would spin forever on a
    // bare `continue` with no cursor advance and no await.
    if (g.issues[0] === undefined) {
      state.cursor += 1;
      continue;
    }
    if (state.owners.has(g.id)) {
      // Someone already has this group — this worker scanned it earlier, or a
      // sibling is running it out of the wait list. `owners` is written in the
      // same synchronous step that writes `inFlight`, so one test covers both
      // "already scanned" and "someone else is mid-cycle"; a `claimed` set
      // tried to answer this and re-dispatched a running cycle, and testing
      // `inFlight` alone re-scanned a group whose outcome was already recorded.
      state.cursor += 1;
      continue;
    }
    // A group that is waiting is not also available: it is already in the
    // wait list, its deferral clock is already running, and the drain owns
    // it. Re-adding it here would let a second scan reset its budget, which
    // is how a wait outlives its cap.
    if (isDeferred(state, g.id)) {
      state.cursor += 1;
      continue;
    }
    // The whole pre-dispatch policy in one call: ordering edges first (a
    // declared dependency must have MERGED), then the claim wait (no in-flight
    // sibling may predict a path collision). Position in the list is not an
    // input to either.
    const blocked = blockReasonFor(snapshotOf(state, g));
    if (blocked) {
      // The scan moves on and this group is remembered for the wake pass.
      // `deferralStart` is stamped only on the FIRST sighting, so a group
      // that another worker already put into the wait is not restarted here.
      if (!state.deferralStart.has(g.id)) {
        state.deferralStart.set(g.id, Date.now());
        state.deferred.push({ gi, group: g });
        traceBlock(g, blocked);
      }
      state.cursor += 1;
      continue;
    }
    // Claimed here: the scan owns it from this point. It STAYS in the wait
    // list while it runs — see `claimDeferred` for why a running group must
    // stay visible to the scheduler — and `finishGroup` drops it once it has
    // an outcome. `deferralStart` is deliberately NOT cleared on claim: it is
    // this group's wait budget, and handing a group that went back into the
    // wait list a fresh cap each round is how a wait outlived its bound.
    state.owners.add(g.id);
    state.inFlight.set(g.id, gi);

    const primary = g.issues[0];
    let threw: Error | undefined;
    let outcome: GroupOutcome | undefined;
    try {
      outcome = await state.runGroup(
        primary,
        g.issues.length > 1 ? g.issues : undefined,
        state.invocationStartRef,
      );
    } catch (err) {
      threw = err as Error;
    }
    // `settled` is NOT stamped here. The worker still holds this group's fate
    // through the outcome read that follows, and stamping it in a `finally`
    // the moment `runGroup` returned told every dependent two lies at once:
    // "my dependency can no longer merge" (so park it) and "no sibling holds
    // the overlapping claim" (so dispatch now). Both are wrong while the
    // outcome is unknown. `finishGroup` is the single point that marks a group
    // done, and it runs only once the entry is on the record.
    if (threw) {
      // Return from THIS worker only. Siblings already mid-cycle drain to
      // completion — abandoning a group halfway through commit-pr would leave
      // exactly the debris the halt exists to avoid.
      recordCrash(state, gi, g, threw);
      return;
    }

    await classify(state, gi, g, outcome);
    if (state.halted) return;
  }

  // The scan is done. From here the worker is a waiter: it holds nothing, so
  // the only work left is re-testing the groups the scan deferred, until
  // either one of them becomes claimable or every one of them has an outcome.
  await drainDeferred(state);
}

/** The scheduler's input, built fresh each re-test. */
function snapshotOf(state: WorkerState, group: IssueGroup) {
  return {
    group,
    groups: state.groups,
    inFlight: [...state.inFlight.keys()],
    // Everything taken and not yet given an outcome — the claim minus the
    // groups that have already been reported. See `SchedulerSnapshot.pending`.
    pending: [...state.owners].filter((id) => !state.entries.has(indexOf(state, id))),
    settled: [...state.settled],
    merged: [...state.merged],
    dependencies: state.dependencies,
    orderingEnabled: state.orderingEnabled,
  };
}

/** The entry slot a group id occupies (its original index), or -1. */
function indexOf(state: WorkerState, id: string): number {
  return state.groups.findIndex((g) => g.id === id);
}

/**
 * Re-test the deferred groups until none is left, then let the worker exit.
 *
 * Two rules make this terminate, and the absence of both is what made a group
 * whose dependency never settled occupy the whole defer cap:
 *
 *  - **A park is a terminal outcome, not a retry.** Once a group has an entry
 *    it is dropped from the wait list whatever it parked as, otherwise a
 *    capped-out group would sit in the list and be re-parked forever.
 *  - **The bound is per group, and the clock starts once.** `deferralStart`
 *    is stamped on the group's FIRST sighting by the scan, so a worker
 *    re-testing a group cannot hand it a fresh budget, and a group merely
 *    waiting on a healthy sibling is released by `wake()` the moment that
 *    sibling settles rather than by the cap.
 *
 * `state.wake()` fires on every settle, merge, park, halt and cap, so in the
 * normal case a waiter never sleeps for its poll interval at all — the timer
 * is the safety net for an event no site reported.
 */
async function drainDeferred(state: WorkerState): Promise<void> {
  // One re-test of the whole wait list per wake. A worker does not spin: it
  // sleeps until `wake()` says something changed. The loop ends when this
  // worker owes nothing — everything is either claimed or scanned past.
  for (;;) {
    if (state.halted) return;
    if (!stillWaiting(state)) return;
    // Snapshot, then test: the list mutates as groups are claimed and re-
    // deferred, and a worker must not claim a group another worker is mid-way
    // through claiming. Read FRESH each pass — a group another worker finished
    // during the await below is gone from the list, and testing a stale entry
    // is what re-dispatched a finished cycle.
    const pending = [...state.deferred];
    // Reverse order on purpose. A worker in the drain has already scanned
    // everything ahead of these groups, so the workers still scanning own the
    // FRONT of the queue. Taking the LAST claimable group is what keeps two
    // waiters from both reaching for the same one while a group behind them
    // starves: taking the first is what made a whole pool of workers pile onto
    // one group and leave a claimable one unclaimed until the cap.
    for (const { gi, group } of pending.reverse()) {
      // Re-test the halt inside the loop: a sibling's crash while this worker
      // was awaiting must stop it claiming further groups.
      if (state.halted) return;
      // Someone else has it — claimed from a scan, or being run by another
      // worker's drain. Re-tested every pass from the LIVE list, because the
      // snapshot above is only as current as the last await.
      if (state.owners.has(group.id)) continue;
      if (!state.deferred.some((d) => d.group.id === group.id)) continue;
      const parked = state.entries.get(gi);
      const blocked = blockReasonFor(snapshotOf(state, group));
      if (!blocked) {
        if (parked) {
          // It has an outcome AND it is claimable: this is a revived group,
          // parked by an earlier pass whose blocker has since cleared.
          // Retrying is what stops a premature park from being permanent, and
          // clearing the marks is what lets `claimDeferred` take it honestly.
          //
          // #1101 fix-round — `resolved` and `outcomeOf` are cleared with the
          // entry. `resolved` is the mark that says "this group has told the
          // queue what it became, never ask again": leaving it stamped meant a
          // revived group carried the *park* as its answer while a fresh
          // `runGroup` was on the stack, so `stillWaiting` read it as finished,
          // `finish()` read it as started, and a waiter retired beside a cycle
          // that was running. `outcomeOf` is the same claim in the per-group
          // map — a dependent reading it would be told a running group had
          // already parked.
          state.entries.delete(gi);
          state.settled.delete(group.id);
          state.resolved.delete(group.id);
          state.outcomeOf.delete(group.id);
          dropDeferred(state, group.id);
        }
        await claimDeferred(state, gi, group);
        if (state.halted) return;
        continue;
      }
      // A dependency that settled non-merged can never be satisfied, so this
      // is a park now rather than a wait that ends at the cap with the same
      // conclusion and a worse message.
      if (blocked.kind === "ordering" && blocked.dependencyParkedOn) {
        state.deferralStart.delete(group.id);
        recordQueuePark(state, gi, group, "dependency-parked", blocked.dependencyParkedOn);
        dropDeferred(state, group.id);
        trace(
          `work-queue: ${group.id} parked — dependency ${blocked.dependencyParkedOn} did not merge`,
        );
        continue;
      }
      const first = state.deferralStart.get(group.id);
      if (first !== undefined && Date.now() - first > state.deferCapMs) {
        capOutWait(state, gi, group, blocked);
        dropDeferred(state, group.id);
        // The group that blocked it may already have settled, in which case
        // nothing will ever wake this waiter; be its own wake-up.
        state.wake();
      }
    }
    if (!stillWaiting(state)) return;
    await sleep(state);
  }
}

/** Any group left that a worker still owes an outcome to? */
function stillWaiting(state: WorkerState): boolean {
  // Three things keep a worker from retiring, and they are the three ways a
  // group can still be somebody's business: the scan has not passed it, it is
  // in the wait list and nobody has taken it, or somebody has taken it and has
  // not yet written its outcome. The last one is why this walks the groups
  // rather than testing `deferred.length` alone — a claimed group is still in
  // the list, and a waiter that retired while a cycle was mid-run left a group
  // that nothing would ever report.
  if (state.cursor < state.groups.length) return true;
  for (const g of state.groups) {
    if (!state.owners.has(g.id)) {
      if (state.deferred.some((d) => d.group.id === g.id)) return true;
      continue;
    }
    if (!state.settled.has(g.id)) return true;
  }
  return false;
}

/**
 * Claim and run a group the scan deferred.
 *
 * The body is shared with the scan path on purpose: a group that waited must
 * be classified through the *same* merged / parked / halted pipeline as one
 * that never waited, or the deferred sibling of an overlap becomes a special
 * case with its own reporting bugs.
 */
async function claimDeferred(state: WorkerState, gi: number, g: IssueGroup): Promise<void> {
  // `deferralStart` is NOT cleared: it is the budget, and the group may be
  // deferred again after this run. The group STAYS in `deferred` for the whole
  // of its run, and `owners` is
  // what keeps any other worker from claiming it a second time. Dropping it
  // here was the bug twice over: a group waiting behind it saw an empty wait
  // list and concluded nobody held the overlapping claim, and the group itself
  // was unobservable in the window between `runGroup` resolving and the state
  // file being read. `owners` is set before the first await for the same
  // reason — the difference between one dispatch per group and one per awake
  // worker.
  state.owners.add(g.id);
  state.inFlight.set(g.id, gi);
  // See `classify`: reached through the scan/drain guard, so the primary exists.
  const primary = g.issues[0] as number;
  let threw: Error | undefined;
  let outcome: GroupOutcome | undefined;
  try {
    outcome = await state.runGroup(
      primary,
      g.issues.length > 1 ? g.issues : undefined,
      state.invocationStartRef,
    );
  } catch (err) {
    threw = err as Error;
  }
  // Same rule as the scan path: the group holds its claim and its ordering
  // edge until `classify`/`recordCrash` has written its entry.
  if (threw) {
    recordCrash(state, gi, g, threw);
    return;
  }
  await classify(state, gi, g, outcome);
}

/** Wait for the next event, or at most the poll ceiling. */
async function sleep(state: WorkerState): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      const i = state.waiters.indexOf(done);
      if (i >= 0) state.waiters.splice(i, 1);
      resolve();
    };
    const t = setTimeout(done, Math.min(MAX_POLL_MS, Math.max(1, state.deferCapMs)));
    state.waiters.push(done);
  });
}
