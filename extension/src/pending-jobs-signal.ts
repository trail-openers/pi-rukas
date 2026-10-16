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
 * The bound a `shutdown()` call uses: `PI_ENSEMBLE_PENDING_SHUTDOWN_MS`, else
 * `SHUTDOWN_SETTLE_MS`. The env form is what lets an offline test pin one outcome
 * ("the report lands inside the window" / "it never does") instead of racing a
 * fixed sleep against the default. Exported so `test-headless-inputs.ts` can pin
 * the registered default against the live reader.
 *
 * #1389 — the bound is clamped to `MAX_SHUTDOWN_SETTLE_MS`: it schedules a timer
 * on a session that is already leaving, so an absurd value is a bug, not a
 * preference. A non-numeric/negative value falls back to the default, which is
 * also the synchronous (pre-#1389) behaviour at `0`.
 */
export const MAX_SHUTDOWN_SETTLE_MS = 30_000;

export function pendingShutdownBoundMs(): number {
  const raw = process.env.PI_ENSEMBLE_PENDING_SHUTDOWN_MS;
  if (raw === undefined || raw === "") return SHUTDOWN_SETTLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHUTDOWN_SETTLE_MS;
  return Math.min(n, MAX_SHUTDOWN_SETTLE_MS);
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
// #1389 — whether THIS process ever attached a session. `attach()` sets it;
// nothing clears it. It is what lets the guards below tell "this session was
// shut down, so a late message is a fact worth printing" from "this process was
// never a headless RPC session at all" — print/json/TUI modes never attach, and
// for them every `jobPending`/`jobReported` call is ordinary operation, not a
// message to a session that stopped listening. Warning on it would bury the
// real "after shutdown" lines in a stack of noise from a mode that has no
// status channel to be honest about.
let everAttached = false;
// #1389 — whether this session's count is still open. `shutdown()` closes it;
// `attach()` reopens it for the next session. It is tracked apart from `ctx`
// because the two answer different questions: `ctx` is "is there a channel to
// write to", this is "is this session still waiting on reports". A settle that
// lands after the count closed must not move a number the client watched reach
// "0" — but the deferred arm still needs its own channel to publish through.
// #1389 — which session the deferred arm belongs to. `attach()` installs a
// context and bumps this; `shutdown()` bumps it too. `finish()` publishes only
// while the token it captured is still current, so a bound that outlives its own
// shutdown cannot push a stale "0" into a context a LATER session installed.
let generation = 0;
let open = false;

function publish(): void {
  if (!ctx) return;
  try {
    ctx.ui.setStatus(PENDING_JOBS_STATUS_KEY, String(pending.size));
  } catch (err) {
    trace(`pending-jobs: setStatus failed: ${String(err)}`);
  }
}

/**
 * Publish the closing "0" and say so when the channel refused it.
 *
 * #1389 — `publish()` swallows a `setStatus` throw behind a debug-gated `trace`,
 * which is right for an ordinary frame and wrong for this one: the whole point
 * of the closing frame is that a headless client is told "nothing is coming".
 * If THAT frame does not land, a client that watched the count at `n` has no
 * reason to believe the session is finished, and the only record of it was
 * behind `PI_ENSEMBLE_DEBUG`. So the shutdown tail reads the publish's own
 * answer (`publishToClient` returns whether the channel delivered it) and
 * warns when it did not.
 */
function publishToClient(): boolean {
  if (!ctx) return false;
  try {
    ctx.ui.setStatus(PENDING_JOBS_STATUS_KEY, String(pending.size));
    return true;
  } catch (err) {
    trace(`pending-jobs: setStatus failed: ${String(err)}`);
    return false;
  }
}

/**
 * A refused `jobPending`/`jobReported` after the count closed.
 *
 * #1389 — the two states the guards have to separate:
 *   - a process that DID attach and then shut down: a report was handed to (or
 *     owed by) a session that is no longer listening. Worth an unconditional
 *     WARN — it is the same class of fact as an early "0".
 *   - a process that never attached (print/json/TUI mode, or a bare test
 *     process): there is no channel, nothing was ever promised to a client, and
 *     the call is ordinary operation. `trace` only, so those modes keep working
 *     silently and the shutdown WARNs stay findable.
 */
function refusedAfterClose(what: string, id: string): void {
  if (!everAttached) {
    trace(`pending-jobs: ignored ${what} (job ${id}) — no session ever attached`);
    return;
  }
  traceWarn(`pending-jobs: ignored ${what} (job ${id}) after shutdown`);
}

/** Capture the context from session_start; RPC only. Publishes the initial count. */
export function attach(c: StatusContext): void {
  // #1389 — a new session is a new channel: any deferred arm from a shutdown
  // this process survived is cancelled rather than left to publish into what is
  // about to be installed. Without this, a client that re-attaches (a reload,
  // or a test that re-attaches after observing a shutdown) would receive the
  // previous session's "0" as if it were its own count.
  deferredArm?.close();
  deferredArm = undefined;
  generation++;
  open = true;
  // #1389 — the count starts at zero for the new session. `shutdown()` clears
  // `pending` only on the paths that actually publish (the immediate "0", the
  // expiry of the bound); its early return for "already at 0, nothing owed"
  // deliberately leaves the Set alone because the channel already carries that
  // number. Without this clear a reload would inherit whatever the previous
  // session was still owed — `open` is back to true, so those stale ids are
  // writable again, and the fresh "0" this publish sends is a lie in the other
  // direction: the client reads 0 while `pending` still holds ids whose settle
  // can never run, so nothing ever calls `jobReported` on them and the next
  // shutdown's "reports never arrived" names jobs this session never started.
  pending.clear();
  // #1389 — set for ANY mode, not only RPC: the question the guards ask is "did
  // this process ever have a session to be honest with", and a TUI/print/json
  // attach is an affirmative answer with no channel to publish through.
  everAttached = true;
  ctx = c.mode === "rpc" ? c : undefined;
  publish();
}

/**
 * A job or batch's report is now owed. Driver-owned jobs are ignored here —
 * their results go to the in-process driver, never to the PM — so the owner
 * rule lives in one place for every caller.
 *
 * #1389 — refused (with a WARN naming the id) once the count is closed: a job
 * started against a session that has already been told "nothing is coming"
 * would re-open a number the client acted on, which is the same class of lie as
 * publishing "0" too early.
 */
export function jobPending(id: string, ownerKind: "pm" | "driver"): void {
  if (ownerKind !== "pm") return;
  if (!open) {
    refusedAfterClose("new owed report", id);
    return;
  }
  pending.add(id);
  publish();
}

/**
 * The job's report was handed to Pi (or could not be): no longer owed. Module-private:
 * `releaseAfter` is the only release path, so every settle exit clears the count.
 *
 * #1389 — while the count is open this is unconditional, including during a
 * `shutdown()` that is waiting out its bound: the report that just landed is
 * exactly what the deferral was waiting for, and dropping the release there is
 * what would strand the count above 0. Once the count is CLOSED (the bound
 * expired, or nothing was owed) a late release is refused with a WARN naming the
 * id — a fact worth printing, since it means a report was handed to a session
 * that is no longer listening, and `trace()` would hide it behind
 * `PI_ENSEMBLE_DEBUG`.
 */
function jobReported(id: string): void {
  if (!open) {
    refusedAfterClose("report release", id);
    return;
  }
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
  // A reset is a new session for the guards too: an arm scheduled before the
  // reset must not publish through whatever a later attach installs.
  generation++;
  open = false;
  ctx = undefined;
  // #1389 — and it is a NEW PROCESS for the "was there ever a session" guard:
  // a case that wants the never-attached shape (print/json mode) has to start
  // from a state no attach has touched, which is what the test asserts on.
  everAttached = false;
}

/**
 * session_shutdown: the count must reach "0", but not ahead of the reports
 * this session is still owed.
 *
 * #1389: the old body cleared the Set and published "0" synchronously while
 * the jobs the shutdown handler had just aborted were still settling, so a
 * client that trusted "0" was told "nothing is coming" about a report that
 * was. The only real choice is therefore between "0 now" and "0 when they land".
 *
 * The deferral is bounded by `pendingShutdownBoundMs()` (clamped to
 * `MAX_SHUTDOWN_SETTLE_MS`) and costs the caller no wait: the shutdown hook returns
 * immediately and the timer keeps the count honest if a late settle lands inside the
 * window. Past the bound the rest are recorded as never-owed — unconditionally, so
 * an ignored abort signal cannot strand the count above 0 — in ONE line (a fan-out
 * of killed children would otherwise print one WARN per id, which buries the rest
 * of the shutdown output), because a report the session never received is a fact an
 * operator needs and `trace()` would hide it behind `PI_ENSEMBLE_DEBUG`.
 *
 * #1389 also closes the leak the deferral opened: the arm belongs to the session
 * that scheduled it (`generation`), so a bound that fires after a new session has
 * attached publishes nothing — a stale "0" in a live channel is the same lie as an
 * early one — and `attach()` cancels a pending arm outright. `shutdown()` takes no
 * parameter: the bound is a property of the shutting-down session, read here, not
 * chosen by the caller.
 */
export function shutdown(): void {
  const settleMs = pendingShutdownBoundMs();
  // The bound is read FIRST (above) and the Set is read where it is acted on —
  // once at the top of the synchronous body (`if (pending.size === 0)`), once
  // inside the armed callback from the live Set. A snapshot taken here is read
  // by neither: the deferred path must not call never-arrived a report that
  // landed inside the window, so it re-reads `pending` at fire time, and an
  // unused copy is a second, staler answer to "what is owed" sitting next to
  // the one that is consulted.
  // A re-entrant shutdown (Pi can fire the hook on both quit and reload paths)
  // re-arms rather than leaving the first bound to fire mid-teardown.
  deferredArm?.close();
  deferredArm = undefined;
  // The session this arm belongs to, and the last word this count gets. From
  // here `jobPending`/`jobReported` refuse to move the number — except that the
  // count stays OPEN while the bound runs, because a settle landing inside the
  // window is the release the deferral exists to wait for.
  const token = ++generation;
  open = false;
  const finish = (): void => {
    if (token !== generation) return;
    pending.clear();
    // Always publish the closing frame: an id added between the call and this
    // timer still gets its "0" rather than a silent no-op. If the channel
    // refused it, say so — a client still watching `n` has no way to learn the
    // session ended, and a debug-gated trace is not a signal it can act on.
    if (!publishToClient()) {
      traceWarn(
        "session shutdown: the closing 0 was not delivered to the client — a headless reader may still believe a report is coming",
      );
    }
    ctx = undefined;
  };
  // Already at "0" and nothing owed: the channel already carries the count this
  // would publish, so publishing again would be a redundant frame, not a
  // transition. The channel is still detached.
  if (pending.size === 0) {
    ctx = undefined;
    return;
  }
  if (settleMs <= 0) {
    finish();
    return;
  }
  // Inside the window the count is still open: a late settle that releases its
  // report drops the number through the normal path, and the arm that fires
  // afterwards publishes whatever remains.
  open = true;
  deferredArm = setTimeout(() => {
    deferredArm = undefined;
    if (token !== generation) return;
    // Read the Set, not the snapshot taken at call time: a report that landed
    // inside the window was already released and must not be called never-arrived.
    const neverArrived = [...pending];
    if (neverArrived.length > 0) {
      const preview = neverArrived.slice(0, 3).join(", ");
      const more = neverArrived.length > 3 ? ` +${neverArrived.length - 3} more` : "";
      traceWarn(
        `session shutdown: ${neverArrived.length} report(s) never arrived — ${preview}${more}`,
      );
    }
    finish();
  }, settleMs);
  // A bound must not itself keep the process alive — this session is ending.
  deferredArm.unref?.();
}
