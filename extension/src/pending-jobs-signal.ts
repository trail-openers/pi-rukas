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
 * in RPC mode as an `extension_ui_request` with method `setStatus` and
 * fields `statusKey` / `statusText`. Sent on attach (as "0"), then every time
 * `n` changes — including the transition to "0".
 *
 * What `n` counts is "reports the PM is still owed":
 *   - a PM-owned single job counts once, from start until its report has
 *     been handed to Pi (not merely until the child exits — a developer/ops
 *     report waits for its git-state line first);
 *   - a batch (`dispatch_parallel`) counts ONCE, not per member, because it
 *     delivers one consolidated report;
 *   - driver-owned jobs never count (see `jobPending`).
 *   - session_shutdown drops everything to "0".
 *
 * Invariant: the Set below is the only source of truth for `n`. It is NOT
 * derived from the `jobs` registry — the registry drops a job at settle
 * time, but the report can still be owed (git-state line pending). Deriving
 * the count would need a separate "owed" state in the registry (follow-up).
 * Callers must mark a job pending only once setup has succeeded, and must
 * release it through `releaseAfter` so every settle path clears it.
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
    trace(`pending-jobs: setStatus failed: ${String(err)}`);
  }
}

/** Capture the context from session_start; RPC only. Publishes the initial count. */
export function attach(c: StatusContext): void {
  ctx = c.mode === "rpc" ? c : undefined;
  publish();
}

/**
 * A job or batch's report is now owed. Driver-owned jobs are ignored here —
 * their results go to the in-process driver, never to the PM — so the owner
 * rule lives in one place for every caller.
 */
export function jobPending(id: string, ownerKind: "pm" | "driver"): void {
  if (ownerKind !== "pm") return;
  pending.add(id);
  publish();
}

/**
 * The job's report was handed to Pi (or could not be): no longer owed. Module-private:
 * `releaseAfter` is the only release path, so every settle exit clears the count.
 */
function jobReported(id: string): void {
  if (pending.delete(id)) publish();
}

/**
 * Run `settle` and release `id` once it has finished — on every exit path,
 * including a throw. `settle` must not resolve before its report is handed
 * to Pi, or the count would drop ahead of the report it waits for.
 */
export async function releaseAfter<T>(id: string, settle: () => Promise<T> | T): Promise<T> {
  try {
    return await settle();
  } finally {
    jobReported(id);
  }
}

/** session_shutdown: nothing in flight will report to this session. */
export function shutdown(): void {
  const had = pending.size > 0;
  pending.clear();
  if (had) publish();
  ctx = undefined;
}
