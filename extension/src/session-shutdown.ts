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

import type { ExitOrigin } from "./exit-cause.ts";

let reason: string | undefined;

/**
 * The origin the `session_shutdown` actually came from (stdin EOF, a signal,
 * or `unknown`), or `undefined` while the session lives. Tracked at the
 * process level by exit-cause.ts because Pi's event does not say.
 */
let origin: ExitOrigin | undefined;

/** Called by the `session_shutdown` hook, before the jobs are aborted. */
export function markSessionShutdown(why: string, originOfShutdown: ExitOrigin): void {
  reason = why;
  origin = originOfShutdown;
}

/** Pi's shutdown reason (`quit`, `reload`, …), or undefined while the session lives. */
export function sessionShutdownReason(): string | undefined {
  return reason;
}

/**
 * Who asked for a job to be killed, as the cancellation report words it.
 *
 * Shared by the /plan and /research cancellations (plan-driver-cancel.ts,
 * research-cancel.ts), which previously carried byte-identical copies — two
 * places to keep in step with the one fact this reads. Session teardown aborts
 * every in-flight job at once, so an aborted session is the far likelier cause
 * than an operator's `dispatch_kill`, and the two want different follow-ups
 * (nothing to re-do vs re-run the run). Lives beside `sessionShutdownReason`
 * because that flag is the only thing that distinguishes the two.
 */
export function killedBy(signal: AbortSignal | undefined): string {
  if (sessionShutdownReason() !== undefined) return "session shutdown";
  return signal?.aborted ? "dispatch_kill (or session shutdown)" : "the harness";
}

/** The origin of the shutdown (`stdin-eof`, `signal:SIGTERM`, `unknown`), or undefined. */
export function sessionShutdownOrigin(): ExitOrigin | undefined {
  return origin;
}

/** Test-only: the offline suite shares one module instance across cases. */
export function clearSessionShutdownForTesting(): void {
  reason = undefined;
  origin = undefined;
}
