/**
 * work-driver-cycle-entry — the bookkeeping a /work cycle does before its first
 * step. Split out of work-driver.ts (AGENTS.md §12 500-line cap).
 *
 * `enterCycle` creates this cycle's emit sink over the host's `emit` seam (S4a,
 * #1162) and returns the context every step receives. The sink is passed
 * explicitly to `writeState`; there is no module-level registry to unbind, so
 * nothing needs cleaning up on exit.
 *
 * Headless S4 (#1024): the returned context is a `CycleContext`, whose
 * `emitSink` is required — `persistCycle` will not compile without one. The
 * default dispatch is bound to the cycle's AbortSignal, so a SIGTERM kills the
 * in-flight child process instead of leaving it running.
 */

import { dispatchCore } from "./dispatch.ts";
import { traceResourceBudget } from "./resource-budget.ts";
import { dropSlowEvents } from "./slow-events.ts";
import { cycleChildOpts } from "./work-cycle-trust.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { createEmitSink } from "./work-state-emit.ts";

/**
 * The dispatch every driver-reachable step uses. A test-injected `dispatchFn`
 * wins as given; otherwise the real `core` (dispatchCore) is bound to this
 * cycle's signal and process-group policy and stamped with the cycle's trust.
 * The stamp is spread AFTER the caller's options, so no caller can opt a child out.
 *
 * Driver sites call this instead of naming dispatchCore, so the cycle is the only
 * place the stamp is applied (test-work-cycle-dispatch-path.ts).
 */
export function cycleDispatch(
  ctx: DriverContext,
  core: typeof dispatchCore = dispatchCore,
): NonNullable<DriverContext["dispatchFn"]> {
  return (
    ctx.dispatchFn ??
    ((h, spec, opts) =>
      core(h, spec, {
        ...opts,
        signal: opts?.signal ?? ctx.signal,
        processGroup: opts?.processGroup ?? ctx.processGroup,
        ...cycleChildOpts(ctx),
      }))
  );
}

/**
 * `core` is the real dispatch (dispatchCore by default); the parameter exists so
 * a test can observe the options a cycle's children are dispatched with (#1666).
 */
export function enterCycle(
  ctx: DriverContext,
  core: typeof dispatchCore = dispatchCore,
): CycleContext {
  traceResourceBudget(ctx.issue); // #1325 — the host budget and the limits this cycle runs with
  // #799 — clear any stale slow-event buffer entry for EVERY issue in the
  // group before the cycle begins: a previous parked cycle of the same
  // issue (whose handoff's final drain ran before a late crossing) can
  // otherwise leak its leftover events into this cycle's log.
  const groupIssues = [...new Set([ctx.issue, ...(ctx.issues ?? [])])];
  for (const n of groupIssues) dropSlowEvents(n);
  const host = ctx.host;
  // A caller that owns the watermark (the headless runner, #1024) passes its
  // sink in, so a fallback write made outside the driver shares it.
  const emitSink = ctx.emitSink ?? createEmitSink((e, index) => host.emit(e, index));
  // #1666 — a headless cycle's children run under the trust marker, the same as an
  // interactive /work cycle's. Set here, once, for every child of the cycle; no
  // caller can opt a child out, and the flag never reaches a non-cycle dispatch.
  const dispatchFn = cycleDispatch(ctx, core);
  return { ...ctx, emitSink, dispatchFn };
}
