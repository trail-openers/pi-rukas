/**
 * plan-driver-seams — the injectable test seams for the /plan pipeline (moved
 * verbatim from plan-driver.ts along its 500-line seam). plan-driver reads the
 * overrides through the getters; tests set them via the re-exported setters.
 */

import type { dispatchCore } from "./dispatch.ts";

// The dispatch seam, injectable for tests (ESM namespaces are not mutable
// in Bun — the FsOps-style DI the agents-md core uses too).
export type PlanDispatchFn = typeof dispatchCore;

let _dispatchOverride: PlanDispatchFn | null = null;

/** Set a dispatch stub for the next run (tests). Pass `null` to clear. */
export function setPlanDispatch(fn: PlanDispatchFn | null): void {
  _dispatchOverride = fn;
}

// #893 — injectable stat seam for the plan-reporter preflight (tests).
let _statFnOverride: ((p: string) => Promise<unknown>) | null = null;

/** Set a stat stub for the next run (tests). Pass `null` to clear. */
export function setPlanStatFn(fn: ((p: string) => Promise<unknown>) | null): void {
  _statFnOverride = fn;
}

/** Read the dispatch stub set for the current run (plan-driver). */
export function getPlanDispatchOverride(): PlanDispatchFn | null {
  return _dispatchOverride;
}

/** Read the stat stub set for the current run (plan-driver). */
export function getPlanStatFnOverride(): ((p: string) => Promise<unknown>) | null {
  return _statFnOverride;
}
