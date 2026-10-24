/**
 * cycle-deadline-clock — bounds the children a /work cycle spawns by the
 * caller's whole-cycle deadline (#1593).
 *
 * The step-boundary check (work-driver-deadline.ts) only decides whether a
 * NEW step starts. A step already running when the deadline arrived was
 * bounded only by its own backstop (2 h for a developer), so it could run
 * into the caller's hard kill: a measured cycle wrote its handoff 8 s
 * before `docker stop` removed the container.
 *
 * The cross-repo contract (observed with the caller): the caller sets
 * `PI_ENSEMBLE_CYCLE_DEADLINE` = its hard kill − its handoff allowance, and
 * passes that allowance as `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS`. So the deadline
 * is where step work ends, and `deadline + allowance` is the kill. This
 * module holds both numbers for the cycle and gives every spawn the bound:
 *
 * - while steps run, a child is killed no later than the deadline minus the
 *   handoff grace (the allowance): the policy's `timeoutMs = min(own bound,
 *   deadline − now − grace)` (#1567 item 6). The step-boundary check uses the
 *   same end, so "a step may start" and "a step's children must stop" agree;
 * - once the handoff runs, its child is killed no later than the kill minus
 *   a small reserve, which is left for the in-process `gh` fallback that
 *   posts the same body when the handoff dispatch does not finish.
 *
 * The clock is scoped with AsyncLocalStorage to the cycle's own async chain:
 * every spawn the cycle makes (dispatchCore, lens-review children, the
 * adversarial phase) sees it, and a spawn outside a cycle — or in a sibling
 * cycle with its own budget — does not. A bound is only ever tightened.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The smallest bound a clamped child gets: past the deadline it is killed almost at once. */
export const MIN_CLAMPED_BOUND_MS = 1_000;

/** The most the handoff keeps back for the in-process `gh` fallback. */
export const HANDOFF_FALLBACK_RESERVE_MS = 60_000;

type Phase = "steps" | "handoff";

interface CycleClock {
  deadlineMs?: number;
  /** The caller's hard kill as the contract implies it: deadline + handoff allowance. */
  killAtMs?: number;
  /** Where step work ends: deadline − handoff grace (the allowance). */
  stepsEndMs?: number;
  phase: Phase;
}

const store = new AsyncLocalStorage<CycleClock>();

/** Run a cycle with its own clock; spawns inside `fn` read it. */
export function runWithCycleClock<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ phase: "steps" }, fn);
}

/**
 * Record the cycle's resolved deadline (or its absence) at a step boundary.
 * `allowanceMs` is the handoff allowance (`handoffDispatchTimeoutMs()`), and
 * `step` says which phase the next spawns belong to. No-op outside a cycle.
 */
export function noteCycleDeadline(
  deadlineMs: number | undefined,
  allowanceMs: number,
  step: string,
): void {
  const clock = store.getStore();
  if (!clock) return;
  clock.deadlineMs = deadlineMs;
  clock.killAtMs = deadlineMs === undefined ? undefined : deadlineMs + allowanceMs;
  clock.stepsEndMs = deadlineMs === undefined ? undefined : deadlineMs - allowanceMs;
  clock.phase = step === "handoff" ? "handoff" : "steps";
}

/** The fallback reserve for an allowance: at most a minute, at most half of it. */
export function handoffFallbackReserveMs(allowanceMs: number): number {
  return Math.min(HANDOFF_FALLBACK_RESERVE_MS, Math.floor(allowanceMs / 2));
}

/**
 * The bound a child spawned now may run for: `timeoutMs`, tightened to what
 * the cycle's deadline leaves. Returns `{ timeoutMs, clamped }`; `clamped`
 * is true only when the deadline (not the caller's own bound) set it.
 */
export function clampToCycleDeadline(
  timeoutMs: number,
  now: number,
): { timeoutMs: number; clamped: boolean } {
  const clock = store.getStore();
  const end = clock?.phase === "handoff" ? handoffEndOf(clock) : clock?.stepsEndMs;
  if (end === undefined) return { timeoutMs, clamped: false };
  const left = Math.max(MIN_CLAMPED_BOUND_MS, end - now);
  return left < timeoutMs ? { timeoutMs: left, clamped: true } : { timeoutMs, clamped: false };
}

function handoffEndOf(clock: CycleClock): number | undefined {
  if (clock.killAtMs === undefined || clock.deadlineMs === undefined) return undefined;
  return clock.killAtMs - handoffFallbackReserveMs(clock.killAtMs - clock.deadlineMs);
}
