/**
 * adversarial-classify — the dispatch-outcome classifier for the
 * adversarial loop (#309/#314), extracted from adversarial.ts (the 500-line
 * gate headroom for the #799 slow-watch wiring). Pure: takes a DispatchResult,
 * returns the cause classification the loop branches on. No behaviour change.
 */
import type { DispatchFailureCause, DispatchResult } from "./types.ts";
import { ADVERSARIAL_TRANSIENT_MAX_RETRIES } from "./types.ts";
import {
  classifyFailureCause,
  failureCauseReasonForClass,
} from "./work-driver-failure-taxonomy.ts";

/**
 * #309/#314 — classify a dispatch result by its ROOT CAUSE so the adversarial
 * loop can branch on structure (self-kill / 429 / provider-severed) instead
 * of collapsing everything into a boolean. Uses shared RATE_LIMIT_429_PATTERN
 * from types.ts. Infra-failure is derived: cause !== "success".
 */
export function classifyDispatchOutcome(r: DispatchResult): {
  cause: DispatchFailureCause;
  shouldRetry: boolean;
  maxRetries: number;
  /** #79 — a provider-stated delay (burst 429) to wait before re-spawning. */
  waitMs?: number;
  headline: string;
} {
  // killCause (#296) — pi-rukas itself ended the child. Must check first.
  if (r.killCause === "timeout") {
    return {
      cause: "self-killed:timeout",
      shouldRetry: false,
      maxRetries: 0,
      headline: "killed by pi-rukas (wall-clock timeout) — budget exhausted, retrying cannot help",
    };
  }
  if (r.killCause === "inactivity") {
    return {
      cause: "self-killed:inactivity",
      shouldRetry: true,
      maxRetries: 1,
      headline: "killed by pi-rukas (inactivity watchdog)",
    };
  }
  // #951 — the in-flight-tool silence kill: same hang shape as inactivity
  // (a tool that never returned), so it is retried the same way.
  if (r.killCause === "tool-inactivity") {
    return {
      cause: "self-killed:tool-inactivity",
      shouldRetry: true,
      maxRetries: 1,
      headline: "killed by pi-rukas (tool-inactivity watchdog — a tool call never returned)",
    };
  }
  if (r.killCause === "abort") {
    return {
      cause: "self-killed:abort",
      shouldRetry: false,
      maxRetries: 0,
      headline: "cancelled (abort signal)",
    };
  }
  // #543 — loop / token-budget self-kills (F4d: four-site parity with
  // the taxonomy). NOT a provider fault, so shouldRetry=false — a looped or
  // budgeted child retried would just loop again, and the #486 in-step
  // retry (`isTransientAdversarialOutcome` reads shouldRetry) must not spend
  // its budget on it.
  if (r.killCause === "loop") {
    return {
      cause: "self-killed:loop",
      shouldRetry: false,
      maxRetries: 0,
      headline:
        "killed by pi-rukas (loop detected) — the same tool call repeated; retrying would loop again",
    };
  }
  if (r.killCause === "token-budget") {
    return {
      cause: "self-killed:token-budget",
      shouldRetry: false,
      maxRetries: 0,
      headline: "killed by pi-rukas (token budget crossed) — a cost cap, not a provider fault",
    };
  }
  // #1313 — the driver ended a round child frozen across slow levels
  // (spawn-stall.ts); the same brief would freeze the same way.
  if (r.killCause === "no-progress") {
    return {
      cause: "self-killed:no-progress",
      shouldRetry: false,
      maxRetries: 0,
      headline:
        "ended by pi-rukas (no progress across a slow-run level) — a stall, not a provider fault",
    };
  }

  // Provider error-stop (transport severance, timeout, 429, missing model).
  // #79 — the driver's taxonomy decides, so a reviewer child and a step
  // dispatch cannot disagree about what a given provider error means: a burst
  // 429 is waited out (`waitMs`), a quota window or a 404 model is not retried.
  if (r.errorStop) {
    const message = r.errorStop.message ?? r.errorStop.reason;
    const tax = classifyFailureCause({
      kind: "dispatch-failed-provider",
      providerMessage: r.errorStop.message,
    });
    const severed = tax.cause === "provider-severed";
    return {
      cause: tax.cause,
      shouldRetry: tax.shouldRetry,
      // A severed stream keeps the loop's own depth; runPhaseWithInfraRetry
      // stops it early when the same error comes back (#79).
      maxRetries: severed ? ADVERSARIAL_TRANSIENT_MAX_RETRIES : tax.maxRetries,
      ...(tax.waitMs !== undefined ? { waitMs: tax.waitMs } : {}),
      headline: severed
        ? `provider/transport error: ${message}`
        : `${failureCauseReasonForClass({ providerMessage: message }, tax)} (${message})`,
    };
  }

  // Non-zero exit with no structured signal — generic crash.
  if (!r.ok) {
    return {
      cause: "crashed",
      shouldRetry: true,
      maxRetries: 1,
      headline: `crashed (exit ${r.exitCode ?? "?"}), no verdict produced`,
    };
  }

  // Success.
  return {
    cause: "success",
    shouldRetry: false,
    maxRetries: 0,
    headline: "",
  };
}
