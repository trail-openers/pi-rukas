/**
 * dispatch-retry — honour a provider's backoff on the tool dispatch path.
 *
 * The #366/#433 fault taxonomy knows that a 429 stating a 59-second delay is a
 * burst worth waiting out, and that one stating 24 hours is a quota window that
 * waiting cannot fix. That knowledge was reachable only from the compiled
 * `/work` driver (`work-driver-step-router.ts`, `work-queue.ts`).
 * `dispatch_specialist` and `dispatch_parallel` had no retry at all.
 *
 * Measured on one `/research` run: four parallel `explore` children, all four
 * throttled. `rust-slack` happened to survive because Pi's own in-process retry
 * covered its gaps; the other three died, having made 85 tool calls and fetched
 * ~305k characters between them. All of it was discarded and re-fetched.
 *
 * Pi's in-process retry is not a substitute. It backs off 2s/4s/8s — about 14.6
 * seconds of total waiting against a server asking for 59, so all four attempts
 * land inside the same rate-limit window. Waiting the delay the provider
 * actually stated is the only thing that works.
 *
 * The wait happens inside the async job, which is already fire-and-forget, so
 * the calling agent's turn never blocks on it.
 *
 * Jitter, not a concurrency cap: `jitteredMs` spreads N children's retries so
 * they do not re-arrive in unison and re-trigger the limit. It costs no
 * throughput — nothing is serialised, and no cap is imposed on how much we ask
 * of a provider that is willing.
 */

import type { DispatchResult } from "./types.ts";
import {
  classifyFailureCause,
  jitteredMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";

/** Ceiling on a provider-stated wait we are willing to sit through. */
const MAX_WAIT_MS = 120_000;

export interface RetryNotice {
  attempt: number;
  waitMs: number;
  cause: string;
}

/**
 * Classify a completed dispatch and say whether waiting would help.
 *
 * Takes the result rather than an event, because the tool path has no state
 * file to read events from — but hands it to the same classifier the driver
 * uses, so the two cannot disagree about what a given 429 means.
 */
export function retryDecision(result: DispatchResult): {
  retry: boolean;
  waitMs: number;
  cause: string;
} {
  if (result.ok) return { retry: false, waitMs: 0, cause: "success" };
  const cls = classifyFailureCause({
    kind: result.errorStop ? "dispatch-failed-provider" : "dispatch-failed",
    killCause: result.killCause,
    providerMessage: result.errorStop?.message,
    errorTail: result.text,
  });
  // A provider that stated no delay gives us nothing to wait for; the taxonomy
  // already declines those rather than guessing a duration.
  const waitMs = Math.min(cls.waitMs ?? 0, MAX_WAIT_MS);
  return {
    retry: cls.shouldRetry && waitMs > 0,
    waitMs,
    cause: cls.cause,
  };
}

/**
 * Run a dispatch, waiting out a provider-stated backoff and trying again.
 *
 * Returns the last result either way — a caller that exhausts its attempts
 * still gets the real failure to report, never a synthesised one.
 */
export async function withProviderBackoff(
  work: (signal: AbortSignal | undefined) => Promise<DispatchResult>,
  opts: {
    signal?: AbortSignal;
    maxAttempts?: number;
    onRetry?: (notice: RetryNotice) => void;
    /** Injected in tests so a 59-second wait does not take 59 seconds. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    rand?: () => number;
  } = {},
): Promise<DispatchResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? abortableSleep;
  let result = await work(opts.signal);

  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    if (!transientRetryEnabled()) return result;
    if (opts.signal?.aborted) return result;
    const decision = retryDecision(result);
    if (!decision.retry) return result;

    const waitMs = jitteredMs(decision.waitMs, 0, opts.rand ?? Math.random);
    opts.onRetry?.({ attempt, waitMs, cause: decision.cause });
    await sleep(waitMs, opts.signal);
    if (opts.signal?.aborted) return result;
    result = await work(opts.signal);
  }
  return result;
}

/** Sleep that resolves early when the dispatch is cancelled. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
