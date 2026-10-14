/**
 * #1295 — tell a headless `pi --mode rpc` client whether a report is still
 * coming to the PM.
 *
 * The PM dispatches, gets a job id and ends its turn; Pi emits
 * `agent_settled`; minutes later the job's `[ensemble:async]` report arrives
 * as a steer and a new run starts. On the wire a turn that is over and one
 * that is waiting on background jobs look the same, so a client that took
 * the quiet for "done" stopped the container and killed the job.
 *
 * The signal: `ctx.ui.setStatus("pi-rukas-jobs", "<n>")`, which Pi forwards
 * in RPC mode as an `extension_ui_request` with method `setStatus`, sent
 * every time `n` changes — including the transition to "0".
 *
 * What `n` counts is "reports the PM is still owed", so:
 *   - a PM-owned single job counts once, from start until its report has
 *     been handed to Pi (not merely until the child exits — a developer/ops
 *     report waits for its git-state line first);
 *   - a batch (`dispatch_parallel`) counts ONCE, not per member, because it
 *     delivers one consolidated report;
 *   - driver-owned jobs (the /work driver's own children) never count: their
 *     results go to the in-process driver, never to the PM. The
 *     `start_work_driver` job itself is PM-owned and does count — its report
 *     does reach the PM.
 *   - session_shutdown drops everything to "0": the aborted jobs' reports
 *     will never be delivered to this session.
 *
 * RPC mode only. In the TUI the dispatch deck already shows every job, and a
 * bare number in the footer would be noise; print/json modes have no status
 * channel to carry it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

export const PENDING_JOBS_STATUS_KEY = "pi-rukas-jobs";

/** The slice of ExtensionContext this module touches (a test can fake it). */
export type StatusContext = Pick<ExtensionContext, "mode"> & {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
};

let ctx: StatusContext | undefined;
const pending = new Set<string>();

function publish(): void {
  if (!ctx) return;
  try {
    ctx.ui.setStatus(PENDING_JOBS_STATUS_KEY, String(pending.size));
  } catch (err) {
    trace(`pending-jobs: setStatus failed: ${(err as Error).message}`);
  }
}

/** Capture the context from session_start; ignored outside RPC mode. */
export function attach(c: StatusContext): void {
  ctx = c.mode === "rpc" ? c : undefined;
}

/** A PM-owned job or batch started: its report is now owed. */
export function jobPending(id: string): void {
  pending.add(id);
  publish();
}

/** The job's report was handed to Pi (or could not be): no longer owed. */
export function jobReported(id: string): void {
  if (pending.delete(id)) publish();
}

/** session_shutdown: nothing in flight will report to this session. */
export function shutdown(): void {
  const had = pending.size > 0;
  pending.clear();
  if (had) publish();
  ctx = undefined;
}
