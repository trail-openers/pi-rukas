/**
 * adversarial-classify — the dispatch-outcome classifier for the
 * adversarial loop (#309/#314), extracted from adversarial.ts (the 500-line
 * gate headroom for the #799 slow-watch wiring). Pure: takes a DispatchResult,
 * returns the cause classification the loop branches on. No behaviour change.
 */
import type { DispatchFailureCause, DispatchResult } from "./types.ts";
import { ADVERSARIAL_TRANSIENT_MAX_RETRIES, isRateLimit429Msg } from "./types.ts";

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

  // 429 rate-limit — detected from errorStop.message.
  if (r.errorStop && isRateLimit429Msg(r.errorStop.message)) {
    return {
      cause: "rate-limited:429",
      shouldRetry: false,
      maxRetries: 0,
      headline: `provider rate-limited (429) — retrying cannot help (${r.errorStop.message ?? "retry delay requested"})`,
    };
  }

  // Provider error-stop (transport severance, provider timeout, etc).
  if (r.errorStop) {
    return {
      cause: "provider-severed",
      shouldRetry: true,
      maxRetries: ADVERSARIAL_TRANSIENT_MAX_RETRIES,
      headline: `provider/transport error: ${r.errorStop.message ?? r.errorStop.reason}`,
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
