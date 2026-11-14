#!/usr/bin/env bun
/**
 * smoke-tests/lib/lean-verified-handback-deadline-rig — the drive that gets a lean
 * run to a DEADLINE STOP with a `fixed` review as its newest work step, through the
 * production reporting wiring.
 *
 * `test-lean-verified-handback-deadline.ts` asserts what the record and the comment
 * say; this holds the only part of it that is machinery rather than claim: the clock
 * rig that lands the crossing where the engine will act on it, the scripted walk that
 * reaches the review without a forge or a model, and the drive that reads the result
 * back off the file the run wrote rather than off the object it returned.
 *
 * The clock is `crossingAfter` (`lib/lean-host-contract-fixture.ts`) keyed on the
 * run's own record: the loop resolves its deadline and takes its stop test BEFORE it
 * writes the next step ahead, so the record still names the step the run has just
 * finished while the boundary being judged is the one after it. Keying on the newest
 * STEP instead would arm one read late, past the decision, and the step would be
 * half-run at the early instant — a record no real drive leaves.
 */

import { MINUTE_MS } from "../../src/lean/deadline.ts";
import { runLean } from "../../src/lean/engine.ts";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { MAX_BUILD_ATTEMPTS } from "../../src/lean/machine.ts";
import { reportHandlers } from "../../src/lean/report-handlers.ts";
import type { LeanState, Outcome, Step } from "../../src/lean/state.ts";
import { loadRun } from "../../src/lean/state.ts";
import { crossingAfter, recording } from "./lean-host-contract-fixture.ts";
import { BRANCH, ISSUE } from "./lean-verified-handback-fixture.ts";

export const HANDOFF_MS = 2 * MINUTE_MS;

/** The cycle budget `crossing` resolves its two clock positions against — fixed at
 *  240 minutes by the rig, and read here because the allowance below is stated
 *  against it. */
const BUDGET_MS = 240 * MINUTE_MS;

/** How far short of the budget the rig's late position sits, so the boundary the
 *  crossing lands on is INSIDE the allowance and the stop is a deadline stop. */
const SHORTFALL_MS = 3 * MINUTE_MS;

/** The rule's own wording for the arm this file records, quoted from
 *  `handback-heads.ts`. Asserted as a QUOTE, not as a paraphrase: the operator reads
 *  this line and the assertion has to fail if it stops saying what the rule says. */
export const NO_HEAD_REASON =
  "the green verify recorded no head, so there is no verified head to ship";

/** The comment body the pre-recording handback posted for the (b) log, captured from
 *  the handback at commit a3b2bebb2b^ (pre-recording). */
export const PRE_RECORD_BODY = [
  "work-lean: issue #2242 is handed back — this is still needed:",
  "",
  "```text",
  "frozen tests and project tiers passed",
  "```",
  "",
  "Frozen acceptance tests:",
  "- tests/AC1-verified-head.test.sh",
  "",
  "Branch: `lean/issue-2242`",
  "PR: https://github.com/o/r/pull/1",
].join("\n");

/** The env every case pins: the host channel makes `outcome.report` the delivered
 *  body, the allowance is the number the crossing was calibrated against, and the
 *  forge is off so no arm can reach a real adapter underneath the drive. */
export const ENV = {
  PI_ENSEMBLE_HANDOFF_CHANNEL: "host",
  PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(HANDOFF_MS),
  PI_ENSEMBLE_CYCLE_BUDGET_MS: String(BUDGET_MS),
  PI_ENSEMBLE_FORGE: "none",
} as const;

/** The scripted plan up to the review, with the gate's verdict supplied by the case.
 *
 * `build` and `challenge` carry TWO entries each. The clock `crossing` arms counts
 * the loop's clock reads and only treats the read at index 1 of each four-read
 * boundary as the stop test, so a drive has to consume at least eight boundaries
 * before the review for the crossing to be reachable at all — a walk straight from
 * `challenge` into its gate never gets that far and the case would silently be a
 * no-deadline drive. The extra rounds are ordinary work the table routes: a second
 * `ok` build re-enters `challenge` (its queue holds one entry, so that round answers
 * `none`) and the gate is then reached with the walk's rounds spent. `publish` holds
 * ONE entry on purpose: the walk visits it once, and a second visit means the
 * re-verification ran — which is the thing the deadline is supposed to prevent, and a
 * queue that answered it would hide that the clock never stopped anything.
 */
/**
 * The plan of the deadline cases, with the review step the drive must REACH.
 *
 * `review` is deliberately NOT one of the recorded states. `crossing` decides its
 * crossing from the number of clock reads the loop has consumed — the read at index 1
 * of each four-read boundary is the one the stop test takes — and that arithmetic
 * assumes a handler consumes exactly one read of the clock, which is true of every
 * scripted queue and FALSE of the production `review` step (`review.ts` calls
 * `ctx.now()` for its own step clock). A drive that let the real reviewer run would
 * have its parity shifted by the step's internal reads and its crossing would land
 * inside the review rather than at the boundary after it — where the run stops AT the
 * reviewing step instead of on its way into the re-verification, which is the other
 * case and has its own fixtures. So the review is answered from the queue like every
 * other early state, and only the step that decides who hears the verdict — the
 * handback — is the production wiring.
 */
export function walkToReview(green: Outcome): Partial<Record<LeanState, Outcome[]>> {
  return {
    ready: [{ kind: "ok" }],
    // A frozen contract, so the comment carries a `Frozen acceptance tests:` section
    // and the byte-identity arm covers the WHOLE body.
    specify: [
      {
        kind: "ok",
        frozen: { "tests/AC1-verified-head.test.sh": "a".repeat(64) },
        tests: { AC1: ["tests/AC1-verified-head.test.sh"] },
      },
    ],
    // `MAX_BUILD_ATTEMPTS` rounds, so the cap is spent when the gate is asked the
    // second time: the red that routes the run to its report has no round left to
    // buy. The walk re-enters `challenge` once per round it dispatches, so the
    // challenge queue is priced off the same cap — a dry queue there would record an
    // `error` and end the run at its build rather than walk it to its review.
    build: Array.from({ length: MAX_BUILD_ATTEMPTS }, () => ({ kind: "ok" }) as Outcome),
    challenge: Array.from({ length: MAX_BUILD_ATTEMPTS }, () => ({ kind: "none" }) as Outcome),
    // ONE green, ONE publish. The re-verification the fixed review dispatches stays
    // UNANSWERED, which is the premise rather than an omission: `handbackHeads` reads
    // the newest DECIDED `verify` at or before the review, so a second verdict would
    // speak for the head and the rule would not fire. The run is stopped on its way
    // INTO that second gate visit and the report is the one step it takes past the
    // line (see {@link driveToDeadline}).
    verify: [green] as Outcome[],
    publish: [{ kind: "ok", prUrl: "https://github.com/o/r/pull/1" }],
    review: [{ kind: "fixed", reason: "one fix wave" }],
  };
}

/** What one drive settled on, read off the record the run WROTE rather than off the
 *  object the drive returned: the file is the durable record, and it is what a resumed
 *  run — and an operator with `/runs` — reads. */
export interface DrivenHandback {
  /** The run's terminal state and reason, for the failure messages. */
  state: string;
  reason: string;
  /** Whether the clock was ever found past the line. */
  crossed: boolean;
  /** The arm the engine persisted, and the late position the clock reached. */
  arm: number | undefined;
  past: number;
  /** The persisted `handback` step's outcome, or `undefined` when it wrote none. */
  outcome: Outcome | undefined;
  /** The whole log the run wrote, for the premise assertions. */
  steps: Step[];
  /** The newest step in the log. */
  newest: Step | undefined;
  /** The late instant this drive's clock reached: a case that re-drives the record past the
   *  same line reuses it, so the resume's stop test is judged at the instant the stop was. */
  armPast: number;
}

/**
 * Drive one run to its deadline stop through the PRODUCTION reporting wiring.
 *
 * The clock goes late on the report's OWN boundary, which is the only place this
 * premise and that step can both hold: the engine's deadline stop ends the run where
 * it stands without running a reporting step, and a run whose re-verification ANSWERED
 * would no longer be one the rule speaks for. So the queue answers up to and including
 * the review, the table routes `review:fixed` into the re-verification, the stop test
 * refuses it — and `handback`, the state the table reaches next, is the one state
 * `deadlineStopsSteps` never refuses. `crossingAfter` keys the late instant on the
 * record standing at the review's decided verdict, one boundary before that.
 */
export async function driveToDeadline(
  repoRoot: string,
  plan: Partial<Record<LeanState, Outcome[]>>,
  baseSha: string,
  /** Handlers layered OVER the production reporting wiring and the scripted walk — a case that
   *  needs to observe or replace one step (the reporting step, say) passes it here rather than
   *  reaching around the rig. */
  extra: Partial<LeanHandlers> = {},
): Promise<DrivenHandback> {
  // The late instant arrives with the record standing on its decided review: the next
  // boundary is the re-verification's, which the stop test refuses, and the boundary
  // after that is the report's, which it exempts.
  // The clock is handed to the LOOP only: the engine reads it for a step's
  // `startedAt`/`endedAt` and for its own stop test, and no scripted handler consumes
  // it. A handler that reached for `ctx.now()` would be counted as a boundary of the
  // state it belongs to, and the late instant would land somewhere other than the
  // report's exemption — the case would then pass with or without the rule it names.
  const calls: string[] = [];
  const clock = crossingAfter({
    at: "verify",
    after: 0,
    decidedBefore: "review",
    repoRoot,
    issue: ISSUE,
    shortfallMs: SHORTFALL_MS,
  });
  const driven = await runLean({
    repoRoot,
    issue: ISSUE,
    seed: { version: "test", baseSha, branch: BRANCH },
    handlers: {
      ...reportHandlers(repoRoot, ISSUE),
      ...recording(calls, plan),
      ...extra,
    },
    now: clock.now,
  });
  const persisted = loadRun(repoRoot, ISSUE);
  const steps = persisted?.steps ?? driven.run.steps;
  const handback = steps.filter((s) => s.state === "handback").pop();
  return {
    state: driven.state,
    reason: driven.run.result?.reason ?? "no reason recorded",
    crossed: clock.crossed(),
    arm: persisted?.deadlineMs ?? driven.run.deadlineMs,
    past: clock.past,
    outcome: handback?.outcome,
    steps,
    newest: steps[steps.length - 1],
    armPast: clock.past,
  };
}
