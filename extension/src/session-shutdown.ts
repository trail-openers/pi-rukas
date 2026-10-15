/**
 * session-shutdown — "this extension runtime is being torn down", as a fact
 * the /work driver can read.
 *
 * `session_shutdown` aborts every in-flight job, and an aborted child comes
 * back to the driver as an ordinary failed dispatch. Without this flag the
 * driver cannot tell "Pi is going away" from "the developer failed", so it
 * blamed the step it had just killed (`step-failed:lens-fix`) and started a
 * handoff — an ops dispatch plus forge calls — in a process that was exiting.
 *
 * Process-wide and never reset on purpose: Pi loads extensions with
 * `moduleCache: false`, so a reload / session replacement gets a fresh copy
 * of this module while the old runtime's driver keeps reading the one whose
 * flag is set. Set synchronously by the hook BEFORE it aborts anything, so no
 * aborted dispatch can be observed ahead of the reason for it.
 */

let reason: string | undefined;

/** Called by the `session_shutdown` hook, before the jobs are aborted. */
export function markSessionShutdown(why: string): void {
  reason = why;
}

/** Pi's shutdown reason (`quit`, `reload`, …), or undefined while the session lives. */
export function sessionShutdownReason(): string | undefined {
  return reason;
}

/** Test-only: the offline suite shares one module instance across cases. */
export function clearSessionShutdownForTesting(): void {
  reason = undefined;
}
