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
 */

let count = 0;

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
