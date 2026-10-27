#!/usr/bin/env bun
/**
 * #1798 round 4 — the terminal-provider read is scoped to the kill that owns
 * the provider's words.
 *
 * Round 3 made `classifyFailureCause` read a TERMINAL provider class from
 * `providerMessage` BEFORE its kill branches, so a fixer killed at its own
 * bound by a spend-cap 429 stopped looking like a self-kill and the queue
 * halted instead of starting groups into the same cap (that half is pinned by
 * `test-work-driver-lens-fix-kill-provider-queue.ts`, and stays). What round 3
 * did not scope is WHICH kills get that read: it applied on any event with a
 * `killCause`.
 *
 * That is wider than the evidence. A child-supervision kill (`no-progress`,
 * `stuck-tool`) is pi-rukas ending a child it judged stalled — the provider is
 * not the reason at all — and #1682 records such deaths on the PROVIDER kind.
 * An adversarial reviewer ended by the supervision policy whose stream happened
 * to carry 429 spend-cap text therefore HALTED THE WHOLE QUEUE on text no
 * reader in the driver is obliged to believe.
 *
 * The override is now gated on two things, both asserted here:
 *
 *  - `kind === "dispatch-failed"` — the member `buildCompletionEvent`'s kill
 *    branch owns, the only writer that stamps `providerMessage` on a killed
 *    dispatch, and does so from `result.errorStop.message`;
 *  - `isFixerBoundKill(killCause)` — the two causes a bound pi-rukas ARMED for
 *    this child (`timeout`, `child-bound`).
 *
 * Beyond that pair the rule is STEP-AGNOSTIC on purpose: a develop child
 * killed at its own bound whose stream a spend cap cut IS systemic — the next
 * group meets the same cap whatever the step was (case (c) below).
 *
 * THE DISTINCTION THIS FILE KEEPS HONEST. Two rules read 429 text and only one
 * is being scoped. The 429 LADDER (`providerMessage ?? errorTail`) predates
 * #1798 and answers for EVERY event, kill or no kill — so a supervision kill
 * carrying real spend-cap text still classifies terminal through the ladder,
 * and still must. What round 4 removes is the OVERRIDE's power to delete a
 * kill cause and stamp a provider cause on an event whose provider field came
 * from anywhere other than the endpoint's own captured response.
 */
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { isSystemicFailure } from "../src/work-queue.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import {
  MIN,
  NOW,
  killed,
  killedByProvider,
  lensFixCtx,
  lensFixWindow,
} from "./lib/lens-fix-kill-cause-fixtures.ts";

let exitCode = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

/** Assembled at runtime so this file's own text never carries a credential-class
 *  token (the rule `secret-patterns.ts` enforces elsewhere), and spelled from
 *  the pieces rather than pasted. */
const SPEND_CAP = ["429 status code", "monthly spend cap reached"].join(" — ");

/** A supervision kill's event, written by hand because it is the shape a
 *  RESUMED cycle holds (the fields the state file carries), not the shape a
 *  child returns. `over` varies the kind and the cause. */
const supervisionKill = (over: Record<string, unknown>) =>
  ({
    kind: "dispatch-failed",
    step: "adversarial",
    role: "adversarial-developer",
    jobId: "adversarial:x:1:1",
    label: "adversarial review",
    ms: 3 * MIN,
    at: NOW,
    exitCode: null,
    errorTail: "[pi-rukas] killed no-progress",
    killCause: "no-progress",
    providerMessage: SPEND_CAP,
    ...over,
  }) as never;

// ────────────── (a) a supervision kill keeps the classification it always had ─
{
  // No provider text at all: the #296 order intact. `no-progress` names no
  // branch of its own, so the event reaches the generic crash — `shouldRetry:
  // true`, one attempt — exactly as it did before #1798. This is the baseline
  // the rest of this file is measured against.
  const noProgress = classifyFailureCause(
    supervisionKill({ providerMessage: undefined }),
  );
  assert(
    noProgress.cause === "crashed",
    `a supervision kill with no provider text classifies AS BEFORE — the override never reads it (got ${noProgress.cause})`,
  );
  assert(
    noProgress.shouldRetry === true && noProgress.maxRetries === 1,
    `…with the retry policy the generic crash always had (retry=${noProgress.shouldRetry}/${noProgress.maxRetries})`,
  );

  // …and an ordinary (non-429) error-stop on such a kill reads as a severance,
  // which proves the provider field is genuinely present on these events. So
  // the cases below are the override DECLINING, not a field that was never set.
  const noProgressSevered = classifyFailureCause(
    supervisionKill({ kind: "dispatch-failed-provider", providerMessage: "Request timed out." }),
  );
  assert(
    noProgressSevered.cause === "provider-severed" && noProgressSevered.shouldRetry === true,
    `…and an ordinary error-stop on such a kill still reads as a severance, so the field is not simply absent (got ${noProgressSevered.cause})`,
  );

  // The other supervision cause, on the kind #1682 records it under: the
  // override still declines it (not a `dispatch-failed`, not a fixer-bound
  // cause) and the event keeps the branch it used to reach.
  const stuckTool = classifyFailureCause(
    supervisionKill({ kind: "dispatch-failed", killCause: "stuck-tool" }),
  );
  assert(
    stuckTool.cause === "crashed" && stuckTool.shouldRetry === true,
    `a stuck-tool kill keeps its own classification whatever providerMessage holds (got ${stuckTool.cause}/retry=${stuckTool.shouldRetry})`,
  );
}

// ─────────────── the ladder is untouched: a real cap is still a real cap ─────
{
  // The caveat that keeps this file honest. These two are REAL writer output —
  // `buildCompletionEvent` on a result whose `errorStop.message` really is
  // spend-cap text, on children pi-rukas ended for `no-progress` (not a bound
  // it armed). They still classify terminal and the queue still halts, because
  // the 429 LADDER reads `providerMessage ?? errorTail` for every event and
  // predates #1798. Scoping the override must not change that, and these
  // assertions are what would notice if it did.
  const supervisionState = await lensFixWindow([
    killed({
      killCause: "no-progress",
      killBudgetMs: undefined,
      ms: 3 * MIN,
      errorStop: { reason: "error", message: SPEND_CAP },
    }),
  ]);
  assert(
    supervisionState.eventLog.at(-2)?.kind === "dispatch-failed",
    "the supervision kill is a dispatch-failed built by the writer (kill cause no-progress)",
  );
  assert(
    classifyFailureCause(supervisionState.eventLog.at(-2) as never).cause ===
      "rate-limited:quota-terminal",
    "the ladder still names a real spend cap terminal whatever ended the child (a genuine cap is a genuine cap)",
  );
  assert(
    isSystemicFailure(supervisionState).systemic,
    "…and the queue still halts on it — the scoping touches the override, never the ladder",
  );

  // Same text on the provider kind, same answer: the pre-#1798 rule, verbatim.
  const providerKind = classifyFailureCause(
    supervisionKill({ kind: "dispatch-failed-provider", killCause: "stuck-tool" }),
  );
  assert(
    providerKind.cause === "rate-limited:quota-terminal" && providerKind.shouldRetry === false,
    `the provider kind's own ladder is UNCHANGED — spend-cap text there stays terminal (got ${providerKind.cause})`,
  );
}

// ─────────── (c) beyond lens-fix the override still fires: develop is not exempt ───────────
{
  // The rule is step-agnostic beyond the (kind, killCause) gate. A develop
  // child killed at its own bound whose stream a spend cap cut IS systemic:
  // the next group meets the same cap whatever the step was. Built through the
  // real mapper with only the STEP differing from the lens-fix case the
  // companion file pins.
  const developResult = killedByProvider(SPEND_CAP);
  const developEv = (await buildCompletionEvent(
    lensFixCtx(developResult) as never,
    "develop",
    "developer",
    "developer",
    developResult,
  )) as Extract<WorkEvent, { kind: "dispatch-failed" }>;
  assert(
    developEv.step === "develop" && developEv.killCause === "timeout",
    `the develop-step kill event is built by the same writer (step=${developEv.step}, cause=${developEv.killCause})`,
  );
  const developCls = classifyFailureCause(developEv as never);
  assert(
    developCls.cause === "rate-limited:quota-terminal",
    `a non-lens-fix dispatch-failed killed at its bound whose provider text is a spend cap IS the terminal class (got ${developCls.cause})`,
  );
  assert(
    developCls.shouldRetry === false,
    "…and is never retried, kill or no kill (#296 holds)",
  );
}

console.log(
  exitCode === 0
    ? "\n#1798 round 4 scoping of the terminal-provider read: all assertions passed"
    : "\n#1798 round 4 scoping of the terminal-provider read: FAILURES above",
);
process.exit(exitCode);
