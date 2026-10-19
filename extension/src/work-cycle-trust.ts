/**
 * work-cycle-trust — the one place a /work cycle's trust stamp is decided (#1666).
 *
 * A headless /work cycle's children run with interactive trust. Three things
 * must agree on that, so they read it from here and nowhere else:
 *
 *   - `cycleChildOpts(ctx)` — the stamp a driver-reachable dispatch carries
 *     (`workCycleTrust`). Every /work dispatch site spreads it; none computes
 *     `ctx.headless` by hand (test-work-cycle-dispatch-path.ts fails if one does).
 *   - `cycleDispatch(ctx)` lives in work-driver-cycle-entry.ts, because it needs
 *     dispatchCore; it stamps through `cycleChildOpts`.
 *   - `workCycleTrustEnabled` / `strictOptIn` — the predicate spawn-permission.ts
 *     applies to a child, and the predicate the `--capabilities` answer reports.
 *
 * This module imports nothing, so the capabilities answer can use it without
 * pulling in the dispatch or broker graph.
 */

/**
 * The operator's strict opt-in: `PI_ENSEMBLE_STRICT_PERMISSIONS=1` in the
 * runner's env restores the allowlist behaviour for /work children.
 */
export function strictOptIn(): boolean {
  return process.env.PI_ENSEMBLE_STRICT_PERMISSIONS === "1";
}

/**
 * Whether a dispatch's `workCycleTrust` request is honoured. The operator's
 * strict opt-in wins over the cycle's request.
 */
export function workCycleTrustEnabled(workCycleTrust: boolean | undefined): boolean {
  return workCycleTrust === true && !strictOptIn();
}

/**
 * The stamp for a dispatch made inside a /work cycle. Derived from the cycle's
 * `headless` flag and nothing else; spread it AFTER any caller options so a
 * caller cannot opt a child out or in.
 */
export function cycleChildOpts(ctx: { readonly headless?: boolean }): {
  workCycleTrust: boolean;
} {
  return { workCycleTrust: ctx.headless === true };
}
