/**
 * work-driver-failure-taxonomy — root-cause classification for dispatch
 * failures.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * classification/formatting helpers with no DriverContext dependency —
 * `runWorkDriver`'s main loop (still in work-driver.ts) consults these to
 * decide retry vs. halt behaviour per PR5/#297/#308/#314.
 */

import {
  type DispatchFailureCause,
  isRateLimit429Msg,
  isSpendCapMsg,
  parseRetryDelaySeconds,
} from "./types.ts";

/**
 * #297 — max INFRASTRUCTURE-TRANSIENT retries per step on HALT-class
 * steps. Pre-#297, a single transient (provider error-stop, pi-ensemble
 * timeout kill) anywhere in a multi-hour cycle aborted the whole cycle —
 * the amplifier behind the month-long "failing more than getting work
 * done" regression. Semantic failures (subagent completed but the work
 * failed) still HALT immediately.
 */
const TRANSIENT_MAX_RETRIES = 2;

/** #297 — escape hatch: PI_ENSEMBLE_TRANSIENT_RETRY=0 restores halt-on-first-failure. */
export function transientRetryEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_TRANSIENT_RETRY;
  return v !== "0" && v !== "false";
}

/**
 * #297 — backoff between transient retries (ms, scaled by attempt).
 * Overridable so the offline suite doesn't sleep.
 */
export function transientRetryBackoffMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 5_000;
}

/**
 * #366 — the boundary between "wait it out inside the cycle" and "this is a
 * quota window, come back later". Default 300s: long enough to absorb every
 * per-minute bucket reset, short enough that the operator is not left staring
 * at a cycle that looks alive but is asleep for hours.
 */
export function burstThresholdSeconds(): number {
  const env = Number(process.env.PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S);
  return Number.isFinite(env) && env >= 0 ? env : 300;
}

/**
 * #366 — full jitter (AWS Builders' Library): sleep a uniform random amount in
 * [0, computed). Without it, N cycles that hit the same rate limit compute the
 * same backoff and retry in the same instant, converting a recoverable blip
 * into a self-inflicted thundering herd. This becomes load-bearing the moment
 * parallel groups land (#289); it is cheap to have now and expensive to
 * retrofit under a live incident.
 *
 * A provider-requested delay is treated as a FLOOR — waiting less than asked
 * is what earns the next 429 — so jitter is added on top rather than sampled
 * across the whole interval.
 */
export function jitteredMs(baseMs: number, floorMs = 0, rand: () => number = Math.random): number {
  if (floorMs > 0) return Math.ceil(floorMs + rand() * Math.max(baseMs, 1000));
  return Math.ceil(rand() * Math.max(baseMs, 0));
}

/**
 * #308/#314 — classify a dispatch-failure event by its ROOT CAUSE so the retry
 * router can branch on structure (killCause / 429 / errorStop) instead of
 * regex-matching errorTail strings. Uses shared DispatchFailureCause type
 * and RATE_LIMIT_429_PATTERN from types.ts for consistency with adversarial.ts.
 */
export function classifyFailureCause(tail: {
  kind: string;
  errorTail?: string;
  killCause?: string;
  providerMessage?: string;
}): {
  cause: DispatchFailureCause;
  shouldRetry: boolean;
  maxRetries: number;
  /** #366 — provider-requested wait, when it stated one. */
  waitMs?: number;
} {
  // Structured killCause (#296) — pi-ensemble itself ended the child.
  // MUST be checked first; a self-kill is never a provider failure.
  if (tail.killCause === "timeout") {
    return { cause: "self-killed:timeout", shouldRetry: false, maxRetries: 0 };
  }
  if (tail.killCause === "inactivity") {
    return { cause: "self-killed:inactivity", shouldRetry: true, maxRetries: 1 };
  }
  if (tail.killCause === "abort") {
    return { cause: "self-killed:abort", shouldRetry: false, maxRetries: 0 };
  }

  // 429 rate-limit. #366 — read the delay the provider actually asked for
  // instead of treating every 429 as permanently fatal. A per-minute token
  // bucket and a 24-hour quota exhaustion arrive as the same status code and
  // differ only in that number; conflating them is what turned a 60-second
  // wait into a dead cycle and 11 unstarted issues.
  const msg = tail.providerMessage ?? tail.errorTail ?? "";
  if (isRateLimit429Msg(msg)) {
    if (isSpendCapMsg(msg)) {
      return { cause: "rate-limited:quota-terminal", shouldRetry: false, maxRetries: 0 };
    }
    const delayS = parseRetryDelaySeconds(msg);
    if (delayS === undefined) {
      // Unreadable message — keep the conservative pre-#366 halt rather than
      // guessing a wait that might be a day long.
      return { cause: "rate-limited:429", shouldRetry: false, maxRetries: 0 };
    }
    if (delayS <= burstThresholdSeconds()) {
      return {
        cause: "rate-limited:burst",
        shouldRetry: true,
        maxRetries: TRANSIENT_MAX_RETRIES,
        waitMs: Math.ceil(delayS * 1000),
      };
    }
    return {
      cause: "rate-limited:quota-window",
      shouldRetry: false,
      maxRetries: 0,
      waitMs: Math.ceil(delayS * 1000),
    };
  }

  // Provider error-stop (transport severance, provider timeout, etc).
  if (tail.kind === "dispatch-failed-provider") {
    return { cause: "provider-severed", shouldRetry: true, maxRetries: TRANSIENT_MAX_RETRIES };
  }

  // Non-zero exit with no structured signal — generic crash. Retry once as safety net.
  if (tail.kind === "dispatch-failed") {
    return { cause: "crashed", shouldRetry: true, maxRetries: 1 };
  }

  // Unexpected kind — treat as crash but don't retry.
  return { cause: "crashed-unknown", shouldRetry: false, maxRetries: 0 };
}

/**
 * #309 — produce the operator-facing reason string for a dispatch failure.
 * Used by lifecycle emitStepRetry and any downstream reporting. Each cause
 * gets a distinct, human-readable headline so the operator can act on it.
 */
export function failureCauseReason(tail: {
  kind: string;
  errorTail?: string;
  providerMessage?: string;
  killCause?: string;
}): string {
  const cls = classifyFailureCause(tail);
  switch (cls.cause) {
    case "self-killed:timeout":
      return "killed by pi-ensemble (wall-clock timeout)";
    case "self-killed:inactivity":
      return "killed by pi-ensemble (inactivity watchdog)";
    case "self-killed:abort":
      return "cancelled (abort signal)";
    case "rate-limited:429":
      return "provider rate-limited (429), no retry delay stated — halting rather than guessing how long to wait";
    case "rate-limited:burst":
      return `provider rate-limited (429), asked us to wait ${Math.round((cls.waitMs ?? 0) / 1000)}s — waiting it out and resuming`;
    case "rate-limited:quota-window":
      return `provider rate-limited (429), asked us to wait ~${Math.round((cls.waitMs ?? 0) / 3600000)}h — a quota window, not a burst`;
    case "rate-limited:quota-terminal":
      return "provider spend cap reached — waiting will not clear this";
    case "provider-severed":
      return `provider/transport error: ${tail.providerMessage ?? tail.errorTail?.slice(0, 60) ?? "connection lost"}`;
    case "crashed":
      return `subagent failed: ${tail.errorTail?.slice(0, 60) ?? "non-zero exit"}`;
    case "crashed-unknown":
      return `subagent failed (unexpected event): ${tail.errorTail?.slice(0, 60) ?? "unknown failure"}`;
    case "success":
      return "(success — no failure reason)";
  }
}

/**
 * #314 — variant of failureCauseReason that accepts a pre-computed
 * classification to avoid double-calling classifyFailureCause on the
 * same event (e.g. in runWorkDriver's step-completion handler).
 */
export function failureCauseReasonForClass(
  tail: { errorTail?: string; providerMessage?: string },
  cls: { cause: DispatchFailureCause },
): string {
  switch (cls.cause) {
    case "self-killed:timeout":
      return "killed by pi-ensemble (wall-clock timeout)";
    case "self-killed:inactivity":
      return "killed by pi-ensemble (inactivity watchdog)";
    case "self-killed:abort":
      return "cancelled (abort signal)";
    case "rate-limited:429":
      return "provider rate-limited (429), no retry delay stated — halting rather than guessing how long to wait";
    case "rate-limited:burst":
      return "provider rate-limited (429) within the burst window — waiting it out and resuming";
    case "rate-limited:quota-window":
      return "provider rate-limited (429) on a quota window — retrying now cannot help; come back after the reset";
    case "rate-limited:quota-terminal":
      return "provider spend cap reached — waiting will not clear this";
    case "provider-severed":
      return `provider/transport error: ${tail.providerMessage ?? tail.errorTail?.slice(0, 60) ?? "connection lost"}`;
    case "crashed":
      return `subagent failed: ${tail.errorTail?.slice(0, 60) ?? "non-zero exit"}`;
    case "crashed-unknown":
      return `subagent failed (unexpected event): ${tail.errorTail?.slice(0, 60) ?? "unknown failure"}`;
    case "success":
      return "(success — no failure reason)";
  }
}
