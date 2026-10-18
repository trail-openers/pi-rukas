/**
 * headless/failure — the reason behind a result's `cap`, as stable fields
 * (#1367). A host that acts on WHY a cycle stopped (retry a provider outage on
 * its own, leave a real failure to a person) reads `issues[].failure` instead
 * of the unstable `dispatch-failed*` NDJSON lines or the cap's prose evidence.
 *
 * `kind` is a published, coarse class (FAILURE_KINDS). The finer detail is the
 * failed dispatch's taxonomy `cause` and its bounded, redacted texts. Pure:
 * reads a WorkState, never writes.
 */

import { redactClip } from "../decision-log.ts";
import type { DispatchFailureCause } from "../types.ts";
import { classifyFailureCause, failureCauseReason } from "../work-driver-failure-taxonomy.ts";
import type { WorkEvent, WorkStep } from "../workflow-state-events.ts";
import type { WorkState } from "../workflow-state.ts";
import type { HeadlessCap } from "./caps.ts";
import { lastCapIndex } from "./exit-code.ts";

/**
 * The published `failure.kind` values. Additive: a new kind does not bump the
 * result schema, so a host treats an unknown kind like `cap`.
 */
export const FAILURE_KINDS = [
  /** A dispatch stopped on a provider error (outage, 429, spend cap, unknown model). */
  "provider",
  /** A time bound ended it: a timed-out or silent child, a verify run, the cycle clock. */
  "timeout",
  /** pi-rukas ended the child on a guard: a loop, the token budget, an abort. */
  "guard",
  /** The child process failed (non-zero exit) with no structured cause. */
  "process",
  /** #1403 — a develop child's ENGINE DIED mid-pass (`the engine stopped
   *  unexpectedly`) and left uncommitted work. Additive: a host treats an
   *  unknown kind like `cap`. */
  "crashed",
  /** The verify gate ran and judged the code (or the base commit) red. */
  "verify",
  /** The system refused to start a process, so the gate never ran. */
  "environment",
  /** A driver step handler threw. */
  "driver",
  /** No failure: the cap's own rule stopped the cycle (a round cap, a park, awaiting merge). */
  "cap",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface ResultFailure {
  kind: FailureKind;
  /** The step the failure belongs to (the result's `failedStep`). */
  step?: WorkStep;
  /** The failed dispatch's role, or the role a guard cap names. */
  role?: string;
  /** The failed dispatch's root cause, as the driver's retry router classified it. */
  cause?: DispatchFailureCause;
  /** One bounded plain-text sentence: why it stopped. */
  message: string;
  /** The provider's own error message (bounded, redacted). */
  providerMessage?: string;
  /** The end of the failed child's output (bounded, redacted). */
  errorTail?: string;
  /** How pi-rukas ended the child (`timeout`, `inactivity`, `loop`, …). */
  killCause?: string;
  /** The failed child's exit code, when it exited. */
  exitCode?: number | null;
  /** The cap's evidence (bounded, redacted). */
  evidence?: string;
}

const MESSAGE_MAX = 500;
const PROVIDER_MAX = 1000;
const TAIL_MAX = 2000;
const EVIDENCE_MAX = 2000;

type FailedDispatch = Extract<WorkEvent, { kind: "dispatch-failed" | "dispatch-failed-provider" }>;

/** Caps a failed dispatch causes: the failure is read from that dispatch. */
const DISPATCH_CAPS: ReadonlySet<string> = new Set([
  "adversarial-infra-failure",
  // #1243 — listed so the failed dispatch behind a provider park is read: its
  // cause, provider message and exit code reach the host, and the KIND still
  // comes from the cap (CAP_KIND_WINS below) rather than from the last event,
  // which on a multi-attempt outage is whichever rung died last.
  "provider-unavailable",
  "spawn-backstop",
  "review-incomplete",
  "loop-detected",
  "token-budget",
  "plan-timeout",
  // #1403 — the crash cap's evidence IS the dead dispatch's fact: the failed
  // dispatch is read from the log so `cause` / `exitCode` / `errorTail` reach
  // the host, and `capKind` only answers when the child left no event at all.
  // It is listed in DISPATCH_CAPS for that read, and excluded from the KIND
  // inference below: a develop child whose engine died printed its own death
  // notice rather than leaving a structured `dispatch-failed` cause, and the
  // generic "exited non-zero, no signal" reading would call that `process`.
  "develop-child-crash",
]);

/** Caps whose KIND comes from the cap itself, even when a failed dispatch
 *  exists to explain them (#1403). */
const CAP_KIND_WINS: ReadonlySet<string> = new Set([
  "develop-child-crash",
  // #1243 — the outage is the reason, and the cap already says so; a rung of
  // the retry ladder that died of something else must not relabel the park.
  "provider-unavailable",
]);

/** The kind a cap implies when no failed dispatch explains it. */
function capKind(cap: string): FailureKind {
  const family = cap.includes(":") ? cap.slice(0, cap.indexOf(":")) : cap;
  switch (family) {
    case "verify-failed":
    case "verify-baseline-red":
    case "integration-verify-failed":
    case "consolidated-verify-consolidation-created":
      return "verify";
    case "verify-timeout":
    case "spawn-backstop":
    case "child-timeout":
    case "plan-timeout":
    case "lens-review-timeout":
    case "deadline":
      return "timeout";
    case "verify-env":
      return "environment";
    // #1243 — the endpoint, not the work. This is the field a headless caller
    // switches on to re-queue a cycle by itself once the provider answers.
    case "provider-unavailable":
      return "provider";
    case "driver-crash":
      return "driver";
    // #1403 — a develop child whose own engine died. Not `process` (that is
    // "the child exited non-zero"), and not `cap`: the driver can name the
    // work the dead pass left behind, and a host that retries provider
    // outages must not read this as one — the child is gone, and its work is
    // sitting uncommitted in a worktree waiting for a person.
    case "develop-child-crash":
      return "crashed";
    case "loop-detected":
    case "token-budget":
      return "guard";
    case "step-failed":
    case "adversarial-infra-failure":
    case "review-incomplete":
      return "process";
    default:
      return "cap";
  }
}

/** A failed dispatch's kind: the provider stopped it, a bound or guard killed it, or it crashed. */
function dispatchKind(e: FailedDispatch): FailureKind {
  if (e.kind === "dispatch-failed-provider") return "provider";
  switch (e.killCause) {
    case "timeout":
    case "inactivity":
    case "tool-inactivity":
    case "plan-timeout":
    case "child-bound":
      return "timeout";
    case "loop":
    case "token-budget":
    case "no-progress":
    case "abort":
      return "guard";
    default:
      return "process";
  }
}

function isDispatchCap(cap: string): boolean {
  return (
    DISPATCH_CAPS.has(cap) || cap.startsWith("step-failed:") || cap.startsWith("child-timeout:")
  );
}

/**
 * The last failed dispatch between the start of the stopped step's last run
 * and the cap, or undefined.
 */
function failedDispatchBefore(
  log: readonly WorkEvent[],
  capIdx: number,
  step: WorkStep | undefined,
): FailedDispatch | undefined {
  let start = 0;
  for (let i = capIdx - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "step-started" && (step === undefined || e.step === step)) {
      start = i;
      break;
    }
  }
  for (let i = capIdx - 1; i >= start; i--) {
    const e = log[i];
    if (e?.kind === "dispatch-failed" || e?.kind === "dispatch-failed-provider") return e;
  }
  return undefined;
}

/** The first non-empty line of the evidence, without list or heading markup. */
function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split("\n")
    .map((l) => l.replace(/^\s*(?:[-*#>]+\s*)+/, "").trim())
    .find((l) => l.length > 0);
  return line;
}

/**
 * The failure behind the cycle's last cap. Undefined when the cycle hit no cap
 * or merged (a cap it recovered from is not why it stopped).
 */
export function failureOf(
  state: WorkState,
  cap: HeadlessCap | undefined,
  step: WorkStep | undefined,
): ResultFailure | undefined {
  if (cap === undefined || state.pipelineState.status === "merged") return undefined;
  const log = state.eventLog;
  // The cap-hit `lastCap` reports: one a signal cut off is skipped (#1371).
  const capIdx = lastCapIndex(state);
  const capHit = capIdx >= 0 ? log[capIdx] : undefined;
  const hit = capHit?.kind === "cap-hit" ? capHit : undefined;
  const failed = isDispatchCap(cap) ? failedDispatchBefore(log, capIdx, step) : undefined;
  const evidence = hit?.evidence ? redactClip(hit.evidence, EVIDENCE_MAX) : undefined;
  const f: ResultFailure = {
    kind: failed && !CAP_KIND_WINS.has(cap) ? dispatchKind(failed) : capKind(cap),
    message: "",
  };
  if (step !== undefined) f.step = step;
  const role = failed?.role ?? hit?.role;
  if (role !== undefined) f.role = role;
  if (failed) {
    f.cause = classifyFailureCause(failed).cause;
    f.message = redactClip(failureCauseReason(failed), MESSAGE_MAX);
    if (failed.kind === "dispatch-failed-provider") {
      if (failed.providerMessage) {
        f.providerMessage = redactClip(failed.providerMessage, PROVIDER_MAX);
      }
    } else {
      if (failed.errorTail) f.errorTail = redactClip(failed.errorTail, TAIL_MAX, "end");
      if (failed.killCause) f.killCause = failed.killCause;
      if (failed.exitCode !== undefined) f.exitCode = failed.exitCode;
    }
  } else {
    f.message = redactClip(firstLine(hit?.evidence) ?? cap, MESSAGE_MAX);
  }
  if (evidence) f.evidence = evidence;
  return f;
}
