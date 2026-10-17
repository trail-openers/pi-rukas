/**
 * work-queue-waitlist — #1101: the queue's wait list, and who owns what.
 *
 * The scan and the drain are two different walks over the same groups, and the
 * only thing that keeps them from dispatching one group twice is a handful of
 * sets the workers mutate between awaits. They live here, apart from the loop,
 * because every one of their invariants is about the *interaction* of those
 * walks and none of it is about either loop's body.
 *
 * Three questions, three sets — and the whole bug class this issue produced
 * was asking one of them of the wrong set:
 *
 *  - *Has anybody taken this group?* `owners`. Written in the same synchronous
 *    step that writes `inFlight`, on both claim paths. A separate `claimed`
 *    set tried to answer it and could not (it was stamped before a group
 *    dispatched anything), and `inFlight` cannot either (a finished group has
 *    left it but must still not be re-scanned).
 *  - *Is this group still somebody's business?* `deferred` plus `resolved`.
 *    A group stays in the wait list for its whole life — including while it
 *    runs — so a group waiting behind it can see that the overlapping claim is
 *    held. Dropping a group at claim time was the bug: the waiter behind it
 *    saw an empty list, concluded nothing was held, and walked back onto a scan
 *    that had already passed it.
 *  - *Has this group told us what it became?* `resolved`. `settled` is stamped
 *    the moment a cycle stops holding anything back, which is before its
 *    outcome is known; `entries` is written when the outcome is known, which
 *    is after the group is safe to touch. Neither distinguishes "finished" from
 *    "merely waited", and the drain must, or it re-dispatches a completed
 *    cycle thinking it was reviving a premature park.
 */

import type { IssueGroup } from "./work-queue-types.ts";

/** One entry of the wait list: the group, and the slot its entry occupies. */
export interface WaitEntry {
  /** Original group index — the key `entries` is written under. */
  gi: number;
  group: IssueGroup;
}

/**
 * Remove a group from the wait list.
 *
 * Called when a group is claimed from the SCAN path, when it is revived, and
 * from `finishGroup` once it has an outcome. Deliberately NOT called at the top
 * of the drain's claim: a group the drain is running stays in the list, so the
 * scheduler keeps seeing its overlap claim. See the module header.
 */
export function dropDeferred(state: { deferred: WaitEntry[] }, id: string): void {
  state.deferred = state.deferred.filter((d) => d.group.id !== id);
}

/** Is this group in the wait list? */
export function isDeferred(state: { deferred: WaitEntry[] }, id: string): boolean {
  return state.deferred.some((d) => d.group.id === id);
}
