/**
 * smoke-tests/lib/lean-request-stall-fixture — the panel row of #2644, stated once.
 *
 * Three cells in three benchmark cycles died the same shape: a 4200 s lean deadline,
 * ONE model request that emitted nothing for 827 s / 1668 s / 827 s, and the harness's
 * outer wall at 5340 s taking the cell while the step was still open — no result
 * document, no PR branch, the patch lost. Every case of the stall lever is that row:
 * a 4200 s cell, a hung request, a stall abort, then the handback inside the bound.
 *
 * Nothing here is a knob the production code reads. The window, the cell, the
 * allowance and the report bound are each read through the SAME helper the lever
 * reads, so a case that hard-codes a duration is asserting about its own fixture
 * rather than about the rule.
 */

import { MINUTE_MS, handoffAllowanceMs } from "../../src/lean/deadline.ts";
import { handoffReportBoundMs } from "../../src/lean/engine-report.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../../src/lean/review-bound.ts";

/** The panel's cell, in seconds: a 4200 s lean deadline. */
export const PANEL_CELL_S = 4200;

/** The panel's cell in ms, built from the seconds so one number is the row. */
export const PANEL_CELL_MS = PANEL_CELL_S * MINUTE_MS;

/** The instant the panel's run began. Every clock position is stated against it. */
export const PANEL_START_MS = 1_700_000_000_000;

/**
 * The field's silence: 1668 s without one stream event, the longest of the three
 * recorded hangs. Past every window the helpers derive, which is what makes it the
 * reproduction rather than a case tuned to its own expectation.
 */
export const HUNG_REQUEST_MS = 1668_000;

/**
 * The allowance every stall case pins. The window is derived FROM it (plus the review
 * reserve), so pinning it here — and only here — keeps the assertion in (c) honest
 * about which number it expects.
 */
export const PINNED_ALLOWANCE_MS = 8 * MINUTE_MS;

/**
 * The env the ON arm runs under: the switch left as an operator leaves it, the allowance pinned,
 * and dispatch caps on so neither lever is inert by master switch.
 *
 */
export function stallEnv(): Record<string, string | undefined> {
  return {
    PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(PINNED_ALLOWANCE_MS),
    PI_ENSEMBLE_DISPATCH_CAPS: "1",
    PI_ENSEMBLE_LEAN_REQUEST_STALL: undefined,
  };
}

/** The env the OFF arm runs under: only the literal `0` turns the lever off. */
export function offEnv(): Record<string, string | undefined> {
  return { ...stallEnv(), PI_ENSEMBLE_LEAN_REQUEST_STALL: "0" };
}

/** The whole reserve the window is derived from, through the same two helpers. */
export function reserveMs(): number {
  return handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS;
}

/** The instant at which a cell begun at `PANEL_START_MS` has spent `seconds`. */
export function cellAt(seconds: number): number {
  return PANEL_START_MS + seconds * MINUTE_MS;
}

/** The bound the engine holds the handback report to, read through its helper. */
export { handoffReportBoundMs };
