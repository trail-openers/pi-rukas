/**
 * adversarial-classify — the dispatch-outcome classifier for the
 * adversarial loop (#309/#314), extracted from adversarial.ts (the 500-line
 * gate headroom for the #799 slow-watch wiring). Pure: takes a DispatchResult,
 * returns the cause classification the loop branches on.
 *
 * #1297 — the PROVIDER half (429 family, spend cap, 404 model-not-found,
 * transport severance) is classified by the driver's own taxonomy
 * (classifyProviderFault) instead of a loop-local 429 pattern, so a reviewer
 * child and a step dispatch cannot disagree about what a given provider
 * error means: a burst 429 gets the provider's stated wait (waitMs) and a
 * re-spawn, a quota-window/undated 429 or a missing model is not retried.
 * KillCause classification stays here — a self-kill is never a provider fault.
 */
import type { DispatchFailureCause, DispatchResult } from "./types.ts";
import { ADVERSARIAL_TRANSIENT_MAX_RETRIES } from "./types.ts";
import {
  classifyProviderFault,
  failureCauseReasonForClass,
} from "./work-driver-failure-taxonomy.ts";

/**
 * #309/#314 — classify a dispatch result by its ROOT CAUSE so the adversarial
 * loop can branch on structure (self-kill / 429 / provider-severed) instead
 * of collapsing everything into a boolean. Infra-failure is derived:
 * cause !== "success".
 */
export function classifyDispatchOutcome(r: DispatchResult): {
  cause: DispatchFailureCause;
  shouldRetry: boolean;
  maxRetries: number;
  /** #1297 — provider-requested wait (burst 429) to sleep before re-spawning. */
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

  // Provider error-stop — #1297: the driver's taxonomy decides the provider
  // half (429 family / spend cap / 404 model-not-found / transport severance).
  // A severed stream keeps the loop's own deeper retry depth (runPhaseWithInfraRetry
  // stops the ladder early on a repeated identical error via the outcome's
  // providerRepeats, see adversarial-retry); every other provider cause
  // carries the taxonomy's shouldRetry/maxRetries verbatim, so a quota window
  // or a missing model is never re-spawned and a burst 429 waits waitMs first.
  if (r.errorStop) {
    const message = r.errorStop.message ?? r.errorStop.reason;
    const tax = classifyProviderFault(r.errorStop.message ?? "");
    return {
      cause: tax.cause,
      shouldRetry: tax.shouldRetry,
      maxRetries:
        tax.cause === "provider-severed" ? ADVERSARIAL_TRANSIENT_MAX_RETRIES : tax.maxRetries,
      ...(tax.waitMs !== undefined ? { waitMs: tax.waitMs } : {}),
      headline:
        tax.cause === "provider-severed"
          ? `provider/transport error: ${message}`
          : failureCauseReasonForClass({ providerMessage: message }, tax),
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
