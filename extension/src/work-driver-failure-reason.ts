/**
 * work-driver-failure-reason — the operator-facing headline for a classified
 * dispatch failure (#309/#314). Split out of work-driver-failure-taxonomy.ts
 * (AGENTS.md §12).
 *
 * Two functions, one for each way a caller arrives at the cause: it either has
 * the tail and wants the classification too, or it already classified and must
 * not pay for a second pass. Both must say the SAME thing about the same cause
 * — they are one vocabulary rendered twice, so their `case` lists are kept in
 * step deliberately and the pair is what test-work-driver-f4-causes.ts pins for
 * every new cause (neither switch is compile-exhaustive in the way that would
 * catch a missing row on its own).
 */

import type { DispatchFailureCause, DispatchResult } from "./types.ts";
import {
  type FailureTail,
  classifyFailureCause,
  clip,
  repeatsNote,
} from "./work-driver-failure-taxonomy.ts";

/**
 * #309 — produce the operator-facing reason string for a dispatch failure.
 * Used by lifecycle emitStepRetry and any downstream reporting. Each cause
 * gets a distinct, human-readable headline so the operator can act on it.
 */
export function failureCauseReason(tail: {
  kind: string;
  errorTail?: string;
  providerMessage?: string;
  killCause?: DispatchResult["killCause"];
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
    // #1827 — the reviewer re-read cap gets its own headline: a child that was
    // reloading its SKILL.md is not a slow child, and "it ran out of time"
    // would send the operator after the wrong knob.
    case "self-killed:review-skill-reread":
      return "ended by pi-rukas for re-reading its own skill file past PI_ENSEMBLE_REVIEW_SKILL_READS (the read/cat/grep alternation no loop detector sees) — retrying would read it again";
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
    // #1827 — same wording as the sibling reason site: the two must not drift.
    case "self-killed:review-skill-reread":
      return "ended by pi-rukas for re-reading its own skill file past PI_ENSEMBLE_REVIEW_SKILL_READS (the read/cat/grep alternation no loop detector sees) — retrying would read it again";
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
