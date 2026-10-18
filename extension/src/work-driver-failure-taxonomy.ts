/**
 * work-driver-failure-taxonomy — root-cause classification for dispatch
 * failures.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * classification/formatting helpers with no DriverContext dependency —
 * `runWorkDriver`'s main loop (still in work-driver.ts) consults these to
 * decide retry vs. halt behaviour per PR5/#297/#308/#314.
 */

import type { SEAMS } from "./decision-seam-registry.ts";
import type { DecisionWhere } from "./decision-seam.ts";
import { shadowDecide, shadowExactRuleMatch, shadowSkip } from "./decision-shadow.ts";
import {
  type DispatchFailureCause,
  isRateLimit429Msg,
  isSpendCapMsg,
  parseRetryDelaySeconds,
} from "./types.ts";

// #1243 — the provider-class ladder lives in its own module (AGENTS.md §12 size
// limit). Re-exported so every caller keeps importing the ladder alongside the
// classifier that produced the cause it keys on — one seam for "what happened"
// and "how long to wait for it", which is the pairing that was missing before.
export {
  providerRetryFloorMs,
  providerRetryMaxWaitMs,
  providerRetryWaitMs,
} from "./work-driver-provider-backoff.ts";

/**
 * #297 — max INFRASTRUCTURE-TRANSIENT retries per step on HALT-class
 * steps. Pre-#297, a single transient (provider error-stop, pi-rukas
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

type FailureTail = {
  kind: string;
  errorTail?: string;
  killCause?: string;
  providerMessage?: string;
  /** #79 — consecutive identical provider failures the adversarial loop already saw. */
  providerRepeats?: number;
};

type FailureClass = {
  cause: DispatchFailureCause;
  shouldRetry: boolean;
  maxRetries: number;
  /** #366 — provider-requested wait, when it stated one. */
  waitMs?: number;
};

type FailureCauseLabel = keyof (typeof SEAMS)["failure-cause"]["labels"];

/**
 * Causes that occur DURING a provider outage: transport severance and every
 * 429 / spend-cap / quota class.
 */
const PROVIDER_OUTAGE_CAUSES: ReadonlySet<DispatchFailureCause> = new Set<DispatchFailureCause>([
  "provider-severed",
  "rate-limited:429",
  "rate-limited:burst",
  "rate-limited:quota-window",
  "rate-limited:quota-terminal",
]);

/**
 * True when the outage evidence comes from the PROVIDER: a provider error stop
 * (`dispatch-failed-provider`) or a 429 in the provider's own message. An outage
 * cause inferred only from the subagent's last words is NOT provider-derived:
 * the rule may be wrong, which is exactly what the shadow call measures (#1262),
 * so the model is asked.
 */
function isProviderOutage(tail: FailureTail, cause: DispatchFailureCause): boolean {
  if (!PROVIDER_OUTAGE_CAUSES.has(cause)) return false;
  return tail.kind === "dispatch-failed-provider" || tail.providerMessage !== undefined;
}

/**
 * The failure-cause seam's label for a rule cause (#1308 S3). Undefined for a
 * cause the rule reads EXACTLY — a structured kill (pi-rukas ended the child
 * itself), or a 429 / spend-cap pattern matched on the provider's own error
 * message. Those stay rule-authoritative and no model is asked.
 * A 429 pattern matched only on `errorTail` is NOT exact: that is the
 * subagent's own last words, which can talk about 429s (#1262), so the model
 * is asked there — in shadow, which is how S5 will see how often it happens.
 */
function seamLabelFor(
  tail: FailureTail,
  cause: DispatchFailureCause,
): FailureCauseLabel | undefined {
  switch (cause) {
    case "self-killed:timeout":
    case "self-killed:inactivity":
    case "self-killed:tool-inactivity":
    case "self-killed:abort":
    case "self-killed:loop":
    case "self-killed:token-budget":
    case "self-killed:plan-timeout":
    case "self-killed:child-bound":
    case "success":
    // #79 — matched only on the provider's own 404 message: exact.
    case "provider-model-unavailable":
      return undefined;
    case "rate-limited:429":
    case "rate-limited:burst":
    case "rate-limited:quota-window":
    case "rate-limited:quota-terminal":
      return tail.providerMessage !== undefined ? undefined : "rate-limited";
    case "provider-severed":
      return "provider-transient";
    case "crashed":
      return "subagent-failure";
    case "crashed-unknown":
      return "unknown";
    default: {
      const unhandled: never = cause;
      return unhandled;
    }
  }
}

/**
 * #1308 S3 — ask the `failure-cause` seam about a classification the caller
 * is about to ACT on, in shadow mode. Called next to `classifyFailureCause`
 * by the driver's step router only — not by renderers, so one failure is
 * asked about once, and not by the tool-path retry, which runs once per
 * attempt during exactly the provider outage a model call would add load to.
 *
 * `cls` (the rule's answer) is always the acted-on outcome, and
 * `classifyFailureCause` stays pure and synchronous. The seam call is fired
 * without awaiting (decision-shadow.ts), so it can neither slow nor change
 * the route. The model sees only the event kind and bounded error text,
 * redacted by the seam — not the rule's answer, so S5 compares two
 * independent readings.
 */
export function shadowFailureCause(
  tail: FailureTail,
  cls: FailureClass,
  where: DecisionWhere,
): void {
  const rule = seamLabelFor(tail, cls.cause);
  if (rule === undefined) {
    // #1393 — an EXACT rule match (any self-killed:* cause, `success`, or a
    // 429 / spend-cap read from the provider's own message) is rule-
    // authoritative and asks no model, but it is still a decision the driver
    // acted on. It used to write no record at all, so S5 saw silence where the
    // rule had answered. The record is STATELESS apart from the cause name:
    // `seamLabelFor` returns undefined exactly where there is no seam label to
    // record, and the payload carries `kind` + the rule cause and NOTHING else
    // — no `providerMessage`, no `errorTail`. Those fields are the untrusted
    // text the redaction criteria close, and an exact match has nothing for a
    // model to add. Building them here would reintroduce the unredacted path.
    void shadowExactRuleMatch(
      "failure-cause",
      { question: "What caused this dispatch failure?", rule: cls.cause },
      where,
      // The payload is a NAMED argument (#1393), not a field of `where`: this is
      // the only path allowed to put text into a record, and the seam bounds it.
      { kind: tail.kind, exactRuleCause: cls.cause },
    );
    return;
  }
  // The seam's declared per-field bounds (decision-seam-registry.ts) redact over
  // the whole text and then clip, inside the seam: no caller clips by hand.
  const req = {
    question: "What caused this dispatch failure?",
    state: {
      kind: tail.kind,
      providerMessage: tail.providerMessage,
      // The END of the output: a failure shows in the last words.
      lastOutput: tail.errorTail,
    },
    rule,
  };
  if (isProviderOutage(tail, cls.cause)) {
    void shadowSkip("failure-cause", req, where, "skipped: provider-outage class");
    return;
  }
  void shadowDecide("failure-cause", req, where);
}

/** #79 — observed: `404: {"message":"model \"qwen3.8-flash-next\" not found","type":"not_found"}`. */
const MODEL_NOT_FOUND_PATTERN = /\b404\b.*not[ _]found|\bmodel\b.*\bnot found\b/i;

/**
 * #1243 — the whole reason, not a prefix of it. Every reason site used to
 * `slice(0, 60)` the provider's message and the child's tail, which is why the
 * three tehas cycles all read `subagent failed: Adversarial loop infrastructure
 * failure: round 2 review disp` — cut 60 characters into our OWN composite
 * text, so the number that followed was invisible and the one number that WAS
 * visible ("3m54s") read as a constant rather than that attempt's cost.
 *
 * 240 is a compromise: enough of the endpoint's own error to act on, bounded
 * enough that a stack-trailing provider body cannot dominate a scrollback line
 * or a headless `message` field (headless/failure.ts applies its own tighter
 * caps on top of this one).
 */
export const FAILURE_REASON_CHARS = 240;

/** Clip to the reason budget, preserving `undefined` — callers distinguish an
 * absent field from an empty one (`?? "connection lost"` style defaults). */
function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > FAILURE_REASON_CHARS ? text.slice(0, FAILURE_REASON_CHARS) : text;
}

/** #79 — `×N in a row` when the loop stopped on a repeating provider error. */
function repeatsNote(tail: { providerRepeats?: number }): string {
  const n = tail.providerRepeats ?? 0;
  return n >= 2 ? ` (×${n} in a row — not re-dispatched)` : "";
}

/**
 * #308/#314 — classify a dispatch-failure event by its ROOT CAUSE so the retry
 * router can branch on structure (killCause / 429 / errorStop) instead of
 * regex-matching errorTail strings. Uses shared DispatchFailureCause type
 * and RATE_LIMIT_429_PATTERN from types.ts for consistency with adversarial.ts.
 */
export function classifyFailureCause(tail: FailureTail): FailureClass {
  // Structured killCause (#296) — pi-rukas itself ended the child.
  // MUST be checked first; a self-kill is never a provider failure.
  if (tail.killCause === "timeout") {
    return { cause: "self-killed:timeout", shouldRetry: false, maxRetries: 0 };
  }
  if (tail.killCause === "inactivity") {
    return { cause: "self-killed:inactivity", shouldRetry: true, maxRetries: 1 };
  }
  // #951 — the in-flight-tool silence kill is the same hang shape as
  // inactivity (a tool that never returned), so it is retried the same way:
  // shouldRetry true, maxRetries 1 — NOT the generic crashed fallback.
  if (tail.killCause === "tool-inactivity") {
    return { cause: "self-killed:tool-inactivity", shouldRetry: true, maxRetries: 1 };
  }
  if (tail.killCause === "abort") {
    return { cause: "self-killed:abort", shouldRetry: false, maxRetries: 0 };
  }
  // #543 — loop + token-budget self-kills sit in the killCause block, after
  // 'abort' and BEFORE the 429 family (the #296 order: structured killCause
  // wins). A looped/budgeted child is NOT a provider fault — the generic
  // 'non-zero exit, no structured signal' fallback below returns
  // shouldRetry:true, which is the OPPOSITE of the intent: an SIGTERM'd
  // looped child is a non-zero exit, so without this branch the cap is undone
  // by a retry. shouldRetry FALSE, maxRetries 0.
  if (tail.killCause === "loop") {
    return { cause: "self-killed:loop", shouldRetry: false, maxRetries: 0 };
  }
  if (tail.killCause === "token-budget") {
    return { cause: "self-killed:token-budget", shouldRetry: false, maxRetries: 0 };
  }
  // #754 — the plan step's own wall-clock bound expired on the primary plan
  // dispatch. An EXPLICIT branch is load-bearing: a kill that fell through
  // to the generic 'crashed' fallback below would carry shouldRetry:true,
  // re-running a dispatch that was killed for taking too long — the opposite
  // of the intent. The in-step recovery is the plan step's corrective
  // re-dispatch (runPlan), not a wholesale router retry. shouldRetry FALSE,
  // maxRetries 0, mirroring the #543 loop/token-budget branches.
  if (tail.killCause === "plan-timeout") {
    return { cause: "self-killed:plan-timeout", shouldRetry: false, maxRetries: 0 };
  }
  // #1560 — the per-child run bound: the child was steered to wrap up and
  // ended a grace period later. Re-running it would spend the bound again,
  // so it parks like the other self-kills (`child-timeout:<step>`).
  if (tail.killCause === "child-bound") {
    return { cause: "self-killed:child-bound", shouldRetry: false, maxRetries: 0 };
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

  // #79 — the endpoint does not serve the configured model. Read from the
  // provider's own error only, never from a child's prose.
  if (tail.providerMessage && MODEL_NOT_FOUND_PATTERN.test(tail.providerMessage)) {
    return { cause: "provider-model-unavailable", shouldRetry: false, maxRetries: 0 };
  }

  // Provider error-stop (transport severance, provider timeout, etc).
  if (tail.kind === "dispatch-failed-provider") {
    // #79 — the adversarial loop already re-spawned into this exact error and
    // got it back unchanged; another re-dispatch lands in the same window.
    if ((tail.providerRepeats ?? 0) >= 2) {
      return { cause: "provider-severed", shouldRetry: false, maxRetries: 0 };
    }
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
 * #79 — a provider fault the taxonomy declined to retry (a quota window, a
 * spend cap, an undated 429, a missing model, an error that already repeated).
 * A RETRY_ONCE step must not spend its semantic retry re-dispatching into it.
 */
export function isFinalProviderFault(cls: { cause: DispatchFailureCause; shouldRetry: boolean }) {
  if (cls.shouldRetry) return false;
  return (
    cls.cause.startsWith("rate-limited:") ||
    cls.cause === "provider-severed" ||
    cls.cause === "provider-model-unavailable"
  );
}

/**
 * #79 — how many re-dispatches a RETRY_ONCE step may spend on this failure:
 * none for a final provider fault, the transient budget for infra, else one.
 */
export function stepRetryBudget(
  cls: { cause: DispatchFailureCause; shouldRetry: boolean; maxRetries: number },
  infra: boolean,
): number {
  if (isFinalProviderFault(cls)) return 0;
  return infra ? cls.maxRetries : 1;
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
  providerRepeats?: number;
}): string {
  const cls = classifyFailureCause(tail);
  switch (cls.cause) {
    case "self-killed:timeout":
      return "killed by pi-rukas (wall-clock timeout)";
    case "self-killed:inactivity":
      return "killed by pi-rukas (inactivity watchdog)";
    case "self-killed:tool-inactivity":
      return "killed by pi-rukas (tool-inactivity watchdog — a tool call never returned)";
    case "self-killed:abort":
      return "cancelled (abort signal)";
    case "self-killed:loop":
      return "killed by pi-rukas (loop detected — the same tool call repeated; retrying would loop again)";
    case "self-killed:token-budget":
      return "killed by pi-rukas (token budget crossed — a cost cap, not a provider fault)";
    case "self-killed:plan-timeout":
      return "killed by pi-rukas (the plan step's own wall-clock bound expired — a bound on planning, not on the issue)";
    case "self-killed:child-bound":
      return "ended by pi-rukas at its per-child run bound (wrap-up steer, then the kill) — a bound on the child, not a provider fault";
    case "rate-limited:429":
      return "provider rate-limited (429), no retry delay stated — halting rather than guessing how long to wait";
    case "rate-limited:burst":
      return `provider rate-limited (429), asked us to wait ${Math.round((cls.waitMs ?? 0) / 1000)}s — waiting it out and resuming`;
    case "rate-limited:quota-window":
      return `provider rate-limited (429), asked us to wait ~${Math.round((cls.waitMs ?? 0) / 3600000)}h — a quota window, not a burst`;
    case "rate-limited:quota-terminal":
      return "provider spend cap reached — waiting will not clear this";
    case "provider-severed":
      return `provider/transport error: ${clip(tail.providerMessage ?? tail.errorTail) ?? "connection lost"}${repeatsNote(tail)}`;
    case "provider-model-unavailable":
      return `provider does not serve the configured model — re-dispatching cannot help: ${clip(tail.providerMessage ?? tail.errorTail)}`;
    case "crashed":
      return `subagent failed: ${clip(tail.errorTail) ?? "non-zero exit"}`;
    case "crashed-unknown":
      return `subagent failed (unexpected event): ${clip(tail.errorTail) ?? "unknown failure"}`;
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
  tail: { errorTail?: string; providerMessage?: string; providerRepeats?: number },
  cls: { cause: DispatchFailureCause },
): string {
  switch (cls.cause) {
    case "self-killed:timeout":
      return "killed by pi-rukas (wall-clock timeout)";
    case "self-killed:inactivity":
      return "killed by pi-rukas (inactivity watchdog)";
    case "self-killed:tool-inactivity":
      return "killed by pi-rukas (tool-inactivity watchdog — a tool call never returned)";
    case "self-killed:abort":
      return "cancelled (abort signal)";
    case "self-killed:loop":
      return "killed by pi-rukas (loop detected — the same tool call repeated; retrying would loop again)";
    case "self-killed:token-budget":
      return "killed by pi-rukas (token budget crossed — a cost cap, not a provider fault)";
    case "self-killed:plan-timeout":
      return "killed by pi-rukas (the plan step's own wall-clock bound expired — a bound on planning, not on the issue)";
    case "self-killed:child-bound":
      return "ended by pi-rukas at its per-child run bound (wrap-up steer, then the kill) — a bound on the child, not a provider fault";
    case "rate-limited:429":
      return "provider rate-limited (429), no retry delay stated — halting rather than guessing how long to wait";
    case "rate-limited:burst":
      return "provider rate-limited (429) within the burst window — waiting it out and resuming";
    case "rate-limited:quota-window":
      return "provider rate-limited (429) on a quota window — retrying now cannot help; come back after the reset";
    case "rate-limited:quota-terminal":
      return "provider spend cap reached — waiting will not clear this";
    case "provider-severed":
      return `provider/transport error: ${clip(tail.providerMessage ?? tail.errorTail) ?? "connection lost"}${repeatsNote(tail)}`;
    case "provider-model-unavailable":
      return `provider does not serve the configured model — re-dispatching cannot help: ${clip(tail.providerMessage ?? tail.errorTail)}`;
    case "crashed":
      return `subagent failed: ${clip(tail.errorTail) ?? "non-zero exit"}`;
    case "crashed-unknown":
      return `subagent failed (unexpected event): ${clip(tail.errorTail) ?? "unknown failure"}`;
    case "success":
      return "(success — no failure reason)";
  }
}
