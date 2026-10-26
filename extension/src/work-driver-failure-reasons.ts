/**
 * work-driver-failure-reasons — the operator-facing sentence for one classified
 * dispatch failure, split from work-driver-failure-taxonomy.ts (AGENTS.md §12
 * file-size limit). The classifier decides WHAT happened; this module decides
 * what a person reads about it, and the two change for different reasons.
 *
 * Every cause has exactly one headline in each renderer, so the taxonomy's
 * `exhaustive switch` (a new `DispatchFailureCause` is a compile error here) is
 * what keeps an operator ever seeing a blank or a generic reason. Two renderers
 * exist because a caller either has the classification already
 * (`failureCauseReasonForClass`, from the step router's hot path) or does not
 * (`failureCauseReason`, which classifies first).
 */

import type { DispatchFailureCause } from "./types.ts";
import {
  FAILURE_REASON_CHARS,
  type FailureTail,
  classifyFailureCause,
} from "./work-driver-failure-taxonomy.ts";

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
    case "environment:diff-unreadable":
      return `the driver could not read the diff it was about to review: ${clip(tail.errorTail) ?? "the git read failed"} — an environment fault, not a provider one: re-running the cycle repeats the same read and gets the same answer until the tree or the ref is fixed`;
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
    case "environment:diff-unreadable":
      return "the driver could not read the diff it was about to review — an environment fault, not a provider one";
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
