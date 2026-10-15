#!/usr/bin/env bun
/**
 * #1238 — the `deadline` cap-hit: the caller-set whole-cycle deadline parks
 * a cycle at the step boundary when the step cannot finish before it.
 *
 * Covers the four surfaces the literal must agree with:
 *  1. the validator accepts the cap (a running state file carrying it
 *     validates cleanly, so re-entry does not halt on "unknown value");
 *  2. `explainCap` returns the authored sentence (not the generic
 *     "step failed: …" fallback);
 *  3. the queue gives a deadline-specific human action (not the generic
 *     "inspect the state file and --restart");
 *  4. `readCycleDeadline` / `deadlineCheck` resolve the two env forms and
 *     park only when the bound + handoff grace would cross the deadline.
 */

import { explainCap } from "../src/work-driver-explain.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import {
  deadlineCheck,
  readCycleDeadline,
} from "../src/work-driver-deadline.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function parkedState(): WorkState {
  const s = initialState(1238, 1) as WorkState;
  s.pipelineState.currentStep = "handoff";
  s.pipelineState.lastCompletedStep = "lens-fix";
  s.pipelineState.branchName = "feature/issue-1238-deadline";
  s.pipelineState.prNumber = 118;
  s.pipelineState.reviewRound = 1;
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "deadline",
    reviewRound: 1,
    nextStep: "handoff",
    evidence:
      "caller deadline 9999999999999 (absolute epoch ms); 300000ms remained; step \"lens-fix\" needs ~5400000ms plus the 480000ms handoff grace",
  });
  return s;
}

// 1. The validator accepts the cap on a running state file (the mid-park
// window: the cap is appended, handoff not yet terminalized).
{
  const s = parkedState();
  s.pipelineState.status = "running";
  const findings = validateDiscriminants(s);
  assert(
    findings.length === 0,
    `a running state file carrying a deadline cap validates cleanly (got: ${JSON.stringify(
      findings,
    )})`,
  );
}

// The canary is not vacuous: a near-miss of the literal is still rejected.
{
  const s = parkedState();
  s.pipelineState.status = "running";
  s.eventLog[0] = {
    ...s.eventLog[0],
    cap: "deadline-exceeded",
  } as (typeof s.eventLog)[number];
  const findings = validateDiscriminants(s);
  assert(
    findings.some((f) => f.includes(".cap has unknown value")),
    `a fabricated deadline-exceeded is still rejected (got: ${JSON.stringify(findings)})`,
  );
}

// 2. explainCap returns the authored sentence.
{
  const s = parkedState();
  const explain = explainCap("deadline", s);
  assert(
    explain.includes("whole-cycle deadline"),
    `explainCap(deadline) names the caller's deadline (got: ${explain.slice(0, 120)}…)`,
  );
  assert(
    explain.includes("handoff"),
    `explainCap(deadline) says the handoff posts before the kill (got: ${explain.slice(0, 120)}…)`,
  );
  assert(
    !explain.startsWith("step failed:"),
    `explainCap(deadline) is not the generic fallback`,
  );
}

// 3. The queue gives a deadline-specific action.
{
  const action = humanActionFor("cap-hit: deadline", 1238);
  assert(
    action.includes("deadline") && action.includes("--restart"),
    `queue action for a deadline park names the deadline + restart (got: ${action})`,
  );
  assert(
    !action.includes("the fix loop did not converge"),
    `the deadline action is not the review-cap action`,
  );
}

// 4. readCycleDeadline: the two env forms + the persisted absolute.
{
  const s = initialState(1238, 1) as WorkState;
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  assert(
    readCycleDeadline(s, 1_000_000) === undefined,
    "no env + no persisted value → no deadline (default behaviour unchanged)",
  );

  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = "2000000";
  assert(
    readCycleDeadline(s, 1_000_000) === 2_000_000,
    "PI_ENSEMBLE_CYCLE_DEADLINE is read as an absolute epoch",
  );
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;

  process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS = "500000";
  assert(
    readCycleDeadline(s, 1_000_000) === 1_500_000,
    "PI_ENSEMBLE_CYCLE_BUDGET_MS is a duration resolved from now",
  );
  delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;

  (s.pipelineState as { cycleDeadlineMs?: number }).cycleDeadlineMs = 7_777_000;
  assert(
    readCycleDeadline(s, 1_000_000) === 7_777_000,
    "a persisted cycleDeadlineMs survives resume as the same absolute epoch",
  );

  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = "not-a-number";
  delete (s.pipelineState as { cycleDeadlineMs?: number }).cycleDeadlineMs;
  assert(
    readCycleDeadline(s, 1_000_000) === undefined,
    "a malformed deadline env value is ignored (traced, never a cycle failure)",
  );
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
}

// 4b. deadlineCheck: parks when bound + grace would cross the deadline,
// does not park when there is room, and never parks handoff/merged (the
// grace is the handoff's own bound; the merge gate is in-process).
{
  const makeCtx = () =>
    ({
      repoRoot: "/tmp/x",
      issue: 1238,
      host: {
        sendUserMessage: () => {},
        sendUserMessageAsync: () => {},
        emit: () => {},
      },
    }) as unknown as Parameters<typeof deadlineCheck>[0];
  // The handoff grace is 8 minutes by default; the spawn backstop is 2 h by
  // default. A dispatch step (explore) needs ~2h + 8m.
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;

  const s1 = initialState(1238, 1) as WorkState;
  (s1.pipelineState as { cycleDeadlineMs?: number }).cycleDeadlineMs =
    1_000_000 + 3_600_000; // 1h from now — less than 2h + 8m
  {
    const r = await deadlineCheck(makeCtx(), s1, "explore", 1_000_000);
    assert(r.parked === true, "deadline check parks explore when 1h < backstop + grace");
    const tail = r.state.eventLog.at(-1);
    assert(
      tail?.kind === "cap-hit" && tail.cap === "deadline" && tail.nextStep === "handoff",
      "the park appends cap-hit deadline → handoff",
    );
  }

  const s2 = initialState(1238, 1) as WorkState;
  (s2.pipelineState as { cycleDeadlineMs?: number }).cycleDeadlineMs =
    1_000_000 + 3_000_000_000; // far in the future
  {
    const r = await deadlineCheck(makeCtx(), s2, "explore", 1_000_000);
    assert(r.parked === false, "deadline check does not park when the deadline is far off");
    assert(
      r.state.eventLog.at(-1)?.kind !== "cap-hit",
      "no cap-hit appended when there is room",
    );
  }

  // The handoff is never parked (the grace IS its bound — the comment is the
  // whole point), and the deadline is still returned for persistence.
  {
    const r = await deadlineCheck(makeCtx(), s2, "handoff", 1_000_000);
    assert(r.parked === false, "the handoff step is never parked (it is the grace itself)");
    assert(r.deadline === s2.pipelineState.cycleDeadlineMs, "the resolved deadline is returned");
  }

  // The budget is persisted as an absolute epoch by the check itself, so a
  // resume keeps the same deadline.
  {
    process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS = "3600000";
    const s3 = initialState(1238, 1) as WorkState;
    const r = await deadlineCheck(makeCtx(), s3, "explore", 1_000_000);
    assert(
      (r.state.pipelineState as { cycleDeadlineMs?: number }).cycleDeadlineMs === 4_600_000,
      "a budget is persisted as an absolute epoch (now + budget), so a resume does not restart the clock",
    );
    assert(r.parked === true, "a 1h budget parks a step that needs ~2h + grace");
    delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  }
}

process.exit(exit);
