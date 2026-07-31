/**
 * work-driver-failure-taxonomy — root-cause classification for dispatch
 * failures.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * classification/formatting helpers with no DriverContext dependency —
 * `runWorkDriver`'s main loop (still in work-driver.ts) consults these to
 * decide retry vs. halt behaviour per PR5/#297/#308/#314.
 */

import { type DispatchFailureCause, isRateLimit429Msg } from "./types.ts";

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

  // 429 rate-limit — detected from providerMessage (errorStop.message).
  // Retrying is definitionally useless; the provider explicitly asked us to wait.
  const msg = tail.providerMessage ?? tail.errorTail ?? "";
  if (isRateLimit429Msg(msg)) {
    return { cause: "rate-limited:429", shouldRetry: false, maxRetries: 0 };
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
      return "provider rate-limited (429) — retrying cannot help";
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
      return "provider rate-limited (429) — retrying cannot help";
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
