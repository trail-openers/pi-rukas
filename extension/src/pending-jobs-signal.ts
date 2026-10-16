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
 *   - session_shutdown drops everything to "0" — but see `shutdown()`: only
 *     after whatever is still owed has had a bounded window to land.
 *
 * Invariant: the Set below is the only source of truth for `n`. It is NOT
 * derived from the `jobs` registry — the registry drops a job at settle
 * time, but the report can still be owed (git-state line pending). Deriving
 * the count would need a separate "owed" state in the registry (follow-up).
 * Callers must mark a job pending only once setup has succeeded, and must
 * release it through `releaseAfter` so every settle path clears it.
 *
 * #1389 adds the second half of that invariant: the Set is also the record of
 * who still owes a report when `session_shutdown` fires, and `shutdown()`
 * consults it instead of clearing it blindly — see `SHUTDOWN_SETTLE_MS`.
 *
 * RPC mode only. In the TUI the dispatch deck already shows every job, and a
 * bare number in the footer would be noise; print/json modes have no status
 * channel to carry it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { trace, traceWarn } from "./trace.ts";

export const PENDING_JOBS_STATUS_KEY = "pi-rukas-jobs";

/**
 * #1389 — how long `shutdown()` waits for a report still owed when
 * `session_shutdown` fires, before it publishes "0" anyway.
 *
 * The hook aborts every job on its way out, and an aborted job's settle is
 * async (a developer report awaits its git-state line before the steer is
 * handed to Pi). The old unconditional `pending.clear(); publish()` printed
 * "0" while that report was still on its way — and dropped `ctx`, so the
 * late report was the last thing anyone saw on the channel. The bound is
 * what keeps the deferral from becoming a hang: a job whose work function
 * ignores `abort` forever (the `new Promise(() => undefined)` case
 * `clearJobsForTesting` exists for) must not hold a quitting session open.
 */
export const SHUTDOWN_SETTLE_MS = 1000;

/**
 * The bound a `shutdown()` call uses: the explicit argument if given, else
 * `PI_ENSEMBLE_PENDING_SHUTDOWN_MS`, else `SHUTDOWN_SETTLE_MS`. The env form is
 * what lets an offline test pin one outcome ("the report lands inside the
 * window" / "it never does") instead of racing a fixed sleep against the default.
 */
function shutdownBoundMs(): number {
  const raw = process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  if (raw === undefined || raw === "") return SHUTDOWN_SETTLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : SHUTDOWN_SETTLE_MS;
}

/** The slice of ExtensionContext this module touches (a test can fake it). */
export type StatusContext = Pick<ExtensionContext, "mode"> & {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
};

let ctx: StatusContext | undefined;
const pending = new Set<string>();
// #1389 — the still-pending "publish 0 when the bound expires" timer, kept so a
// second shutdown() or a test teardown can cancel it rather than race it.
let deferredArm: ReturnType<typeof setTimeout> | undefined;

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

/**
 * Test-only: put the module back to its pre-`attach` state — no context, nothing
 * owed, no scheduled arm.
 *
 * `shutdown()` deliberately leaves `ctx` dropped (a session that is ending must
 * not keep publishing), which means a test that wants to observe what the NEXT
 * case publishes has to re-attach anyway; a case that instead asserted on
 * `statuses()` after a shutdown would be reading a channel nobody can write to,
 * and a missing "0" would read as compliance. This clears the Set and any
 * pending bound, which `attach()` alone does not.
 */
export function resetForTesting(): void {
  pending.clear();
  const timer = deferredArm;
  deferredArm = undefined;
  timer?.close();
  ctx = undefined;
}

/**
 * session_shutdown: the count must reach "0", but not ahead of the reports
 * this session is still owed.
 *
 * #1389: the old body cleared the Set and published "0" synchronously while
 * the jobs the shutdown handler had just aborted were still settling, so a
 * client that trusted "0" was told "nothing is coming" about a report that
 * was. Nothing publishes after this returns either (`ctx` is dropped), so the
 * only real choice is between "0 now" and "0 when they land".
 *
 * The deferral is bounded by `SHUTDOWN_SETTLE_MS` and costs the caller no
 * wait: the shutdown hook returns immediately and the timer keeps the count
 * honest if a late settle lands inside the window. Past the bound the rest
 * are recorded as never-owed — unconditionally, so an ignored abort signal
 * cannot strand the count above 0 — and each names itself on stderr, because
 * a report the session never received is a fact an operator needs and
 * `trace()` would hide it behind `PI_ENSEMBLE_DEBUG`.
 */
export function shutdown(settleMs: number = shutdownBoundMs()): void {
  const owedIds = [...pending];
  // A re-entrant shutdown (Pi can fire the hook on both quit and reload paths)
  // re-arms rather than leaving the first bound to fire mid-teardown.
  deferredArm?.close();
  deferredArm = undefined;
  const finish = (): void => {
    pending.clear();
    // No `had` guard (the old path published only when the Set was non-empty):
    // the arm must always run, so an id added between the call and a deferred
    // timer still gets its "0" rather than a silent no-op.
    publish();
    ctx = undefined;
  };
  if (owedIds.length === 0 || settleMs <= 0) {
    finish();
    return;
  }
  deferredArm = setTimeout(() => {
    deferredArm = undefined;
    // Read the Set, not the snapshot taken at call time: a report that landed
    // inside the window was already released and must not be called never-arrived.
    for (const id of [...pending]) {
      traceWarn(`session shutdown: report (job ${id}) never arrived`);
    }
    finish();
  }, settleMs);
  // A bound must not itself keep the process alive — this session is ending.
  deferredArm.unref?.();
}
