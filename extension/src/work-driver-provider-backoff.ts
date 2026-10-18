/**
 * work-driver-provider-backoff — the #1243 provider-class retry ladder.
 *
 * Split from `work-driver-failure-taxonomy.ts` (AGENTS.md §12 file-size limit).
 * Pure: reads the env and a classification the taxonomy already produced, writes
 * nothing. The taxonomy stays the single classifier; this module decides only
 * HOW LONG to sit out the causes it already named.
 *
 * The transient ladder was `5s × attempt` — 5s, then 10s. Measured across the
 * 14 Oct orchard incident (three cycles parked inside 30 minutes on one endpoint
 * outage, cycles 45/61/63): every one of those waits landed inside the SAME
 * incident, so every re-spawn died on the identical provider error and the
 * step's single retry was spent in under five minutes. A sub-minute ladder
 * cannot clear an outage measured in minutes; it only manufactures a second
 * failure and spends the budget that was the recovery.
 */

import type { DispatchFailureCause } from "./types.ts";

/**
 * The FLOOR of the provider-class backoff, and the clamp on a SINGLE wait.
 *
 * A PROVIDER-class failure (a transport severance / endpoint timeout / 5xx, or
 * a short-burst 429) waits at least the floor, scaled by the attempt, and no
 * single wait exceeds the clamp. A provider that DID state a delay is a floor
 * above this one (the `waitMs` path) — waiting less than asked is what earns
 * the next 429.
 *
 * The clamp is per wait, NOT a budget for the whole cycle: what bounds the
 * cycle is the retry budget (each rung spends one), not this number. It exists
 * so one provider-stated delay — a 429 asking for a day — cannot put a cycle to
 * sleep on its own.
 *
 * Both are env-tunable and both are zeroed by the offline suite (like
 * `transientRetryBackoffMs`) so no test sleeps.
 *
 * Override: PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS (default 60s),
 * PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS (default 30 min — the bound the issue
 * names, on one wait).
 */
export function providerRetryFloorMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 60_000;
}

export function providerRetryMaxWaitMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 30 * 60_000;
}

/**
 * The provider-class causes: the failure is the ENDPOINT's, so waiting is the
 * remedy and the wait has a floor. Deliberately NARROWER than
 * `PROVIDER_OUTAGE_CAUSES` in the taxonomy (which also lists the quota classes,
 * where waiting is known not to help): a quota window or a spend cap is not
 * scaled by this ladder, because no amount of waiting inside the cycle clears
 * it — and the taxonomy already declines to retry either.
 */
const PROVIDER_CLASS_CAUSES: ReadonlySet<DispatchFailureCause> = new Set<DispatchFailureCause>([
  "provider-severed",
  "rate-limited:burst",
]);

/**
 * How long to sit out a provider-class failure before re-dispatching.
 *
 * `attempt` is the retry about to run (1-based), so the two transient attempts
 * wait the floor and twice the floor. A provider-stated delay (`cls.waitMs`) is
 * a FLOOR rather than a target — the larger of the two wins — and the result is
 * clamped to `providerRetryMaxWaitMs()` so no single wait — one a provider asked
 * for, one the floor scaled past the bound — puts a cycle to sleep for longer
 * than the bound. Callers add jitter on top of the result.
 *
 * Non-provider causes return `linearMs` unchanged: a self-kill or a crash is not
 * cleared by a minute of waiting, and paying minutes for what a second buys
 * would be a regression, not a fix.
 */
export function providerRetryWaitMs(
  cls: { cause: DispatchFailureCause; waitMs?: number },
  attempt: number,
  linearMs: number,
): number {
  if (!PROVIDER_CLASS_CAUSES.has(cls.cause)) return linearMs;
  const scaled = providerRetryFloorMs() * Math.max(1, attempt);
  const stated = Math.max(cls.waitMs ?? 0, scaled);
  return Math.min(stated, providerRetryMaxWaitMs());
}
