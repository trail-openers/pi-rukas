/**
 * lean/provider-wait — how long lean sits out a transient provider fault before
 * the ONE retry it already has. A 502/503 burst hits every lane at once, so a
 * retry dispatched AT ONCE lands inside the same burst and spends the run's only
 * retry; waiting the ladder `/work`'s step router waits is what makes it count.
 * Refusals: non-provider-class cause, `PI_ENSEMBLE_TRANSIENT_RETRY=0`, a deadline
 * that cannot fit the wait outside the handoff allowance.
 */

import { abortableSleep } from "../dispatch-retry.ts";
import type { DispatchFailureCause, DispatchResult } from "../types.ts";
import {
  classifyFailureCause,
  isFinalProviderFault,
  jitteredMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "../work-driver-failure-taxonomy.ts";
import { PROVIDER_CLASS_CAUSES, providerRetryWaitMs } from "../work-driver-provider-backoff.ts";
import { handoffAllowanceMs } from "./deadline.ts";

/**
 * Whether the sleep ran to its full length: `abortableSleep` resolves early on abort
 * and never says so, so a cut-short wait would otherwise be recorded as the rung.
 */
async function sleptToCompletion(ms: number, signal?: AbortSignal): Promise<boolean> {
  await abortableSleep(ms, signal);
  return signal?.aborted !== true;
}

/**
 * Injectable so the offline suite RECORDS waits instead of taking them. It answers
 * whether the sleep ran to completion (see {@link sleptToCompletion}).
 */
let sleepFn: (ms: number, signal?: AbortSignal) => Promise<boolean> = sleptToCompletion;

/** Test seam; returns the restore function. */
export function __setLeanSleepFn(
  fn: (ms: number, signal?: AbortSignal) => Promise<boolean>,
): () => void {
  const prev = sleepFn;
  sleepFn = fn;
  return () => {
    sleepFn = prev;
  };
}

/** The two fields the ladder reads; the caller carries the classification here. */
export interface ProviderWaitClass {
  cause: DispatchFailureCause;
  waitMs?: number;
}

/**
 * The taxonomy's verdict on a dead child in the wait leaf's shape, or `undefined`
 * when it is not a fault to sit out: a pi-rukas self-kill is never a provider
 * failure (re-spawning a child we ended is a spawn loop), nor is a fault the
 * classifier calls final. Both steps ask THIS function, so a build re-dispatch and
 * a specify re-prompt cannot disagree about the same death.
 */
export function providerFaultOf(result: DispatchResult): ProviderWaitClass | undefined {
  if (result.killCause !== undefined) return undefined;
  // An error stop whose only text is the stop reason must not read as a plain crash.
  const cls = classifyFailureCause({
    kind: result.errorStop === undefined ? "dispatch-failed" : "dispatch-failed-provider",
    killCause: result.killCause,
    providerMessage: result.errorStop?.message ?? result.errorStop?.reason,
  });
  if (!(cls.shouldRetry && cls.maxRetries > 0 && !isFinalProviderFault(cls))) return undefined;
  return { cause: cls.cause, ...(cls.waitMs === undefined ? {} : { waitMs: cls.waitMs }) };
}

/**
 * The one length formula, so `build` and `specify` cannot disagree about how long
 * the same outage is worth. `attempt` is 1-based; a provider-stated delay is a
 * floor jittered on top, not a target. `rand` is the generator `jitteredMs` draws
 * with — injectable so a case that must bound or compare a length is not reasoning
 * about a random draw.
 */
export function leanProviderWaitMs(
  cls: ProviderWaitClass,
  attempt: number,
  rand: () => number = Math.random,
): number {
  const rung = Math.max(1, attempt);
  const linear = transientRetryBackoffMs() * rung;
  return jitteredMs(providerRetryWaitMs(cls, rung, linear), cls.waitMs ?? 0, rand);
}

export interface ProviderWaitOpts {
  /** The classification the dispatch produced — never re-classified here. */
  cls: ProviderWaitClass;
  /** The retry about to run, 1-based. */
  attempt: number;
  /** The caller's clock reading, taken once. */
  now: number;
  /** The run's whole-cycle deadline, when it has one. */
  deadlineMs?: number;
  /** Forwarded on SIGTERM; an abort ends the wait. */
  signal?: AbortSignal;
  /** The jitter draw; injectable so a case can bound the length it expects. */
  rand?: () => number;
}

/**
 * Wait out the fault, or decline to. 0 is never a failure: the caller proceeds
 * exactly as it did before the wait existed.
 */
export async function waitOutProviderFault(opts: ProviderWaitOpts): Promise<number> {
  if (!transientRetryEnabled()) return 0;
  // Waiting is the remedy for the ladder's own narrow set of causes only.
  if (!PROVIDER_CLASS_CAUSES.has(opts.cls.cause)) return 0;
  const wait = leanProviderWaitMs(opts.cls, opts.attempt, opts.rand);
  if (wait <= 0) return 0;
  // The wait must fit outside the allowance the handback needs, or the run sleeps
  // into a death with no result document.
  if (opts.deadlineMs !== undefined && opts.deadlineMs - opts.now - handoffAllowanceMs() < wait) {
    return 0;
  }
  const completed = await sleepFn(wait, opts.signal);
  // What the caller reports is what this call SLEPT. A wait the signal ended is
  // not a wait of the rung's length, and the reason the step records would
  // otherwise state a duration the run never spent.
  return completed && opts.signal?.aborted !== true ? wait : 0;
}

/** The sentence a step appends to its recorded reason, in seconds. */
export function providerWaitNote(waitedMs: number): string {
  return `waited ${String(Math.ceil(waitedMs / 1000))}s for a transient provider fault`;
}
