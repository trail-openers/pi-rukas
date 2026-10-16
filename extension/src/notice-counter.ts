/**
 * #916 SLICE B — the "N new notices" counter for the live-view header.
 *
 * Async-report deliveries (async-jobs `deliverReport` →
 * `pi.sendUserMessage`) happen while the operator watches the live
 * view. The view resets the counter when it opens, `incrementNotice`
 * counts each delivery while open, and the header shows the badge when
 * the count is > 0. A single global counter is sufficient — the badge
 * is only read by the view that is open, and a delivery while no view
 * is open is unbadged by design (resetOnOpen wipes it).
 *
 * #1389 adds a second tally beside it: how many of those attempted
 * deliveries the host rejected. `deliverReport` cannot throw (its callers'
 * never-throws contracts depend on that), so a caller that must know whether
 * its send reached Pi has no try/catch to write — it compares the two
 * counters across the call. The pair is read as a delta, which is what makes
 * it safe as a process-global: an unrelated deliverer's failure cannot be
 * blamed on the send being judged.
 */

let count = 0;
let failedCount = 0;

/** Increment the notice count (async-jobs deliverReport). */
export function incrementNotice(): void {
  count += 1;
}

/** Reset the count to zero (the view, on open). */
export function resetNotices(): void {
  count = 0;
}

/** The current count (the view header). */
export function getNotices(): number {
  return count;
}

/**
 * Record that a delivery attempt did not reach the host (async-jobs
 * `deliverReport`'s catch). Counted separately from the badge: the badge is
 * an ATTEMPTED-delivery count and must stay byte-identical for the view.
 */
export function incrementFailedNotice(): void {
  failedCount += 1;
}

/**
 * How many delivery attempts so far were rejected by the host. Read as a
 * delta around a `deliverReport` call — never as an absolute (see the module
 * header), and never reset: the view's `resetNotices` clears what the operator
 * reads, not the ledger a caller judges its own send by.
 */
export function getFailedNotices(): number {
  return failedCount;
}
