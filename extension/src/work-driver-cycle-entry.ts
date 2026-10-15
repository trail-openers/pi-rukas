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
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { createEmitSink } from "./work-state-emit.ts";

export function enterCycle(ctx: DriverContext): CycleContext {
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
  const cycleSignal = ctx.signal;
  const cycleProcessGroup = ctx.processGroup;
  // Production dispatch is the real dispatchCore, bound to this cycle's signal.
  // A test-injected dispatchFn is used as given.
  const dispatchFn: NonNullable<DriverContext["dispatchFn"]> =
    ctx.dispatchFn ??
    ((h, spec, opts) =>
      dispatchCore(h, spec, {
        ...opts,
        signal: opts?.signal ?? cycleSignal,
        processGroup: opts?.processGroup ?? cycleProcessGroup,
      }));
  return { ...ctx, emitSink, dispatchFn };
}
