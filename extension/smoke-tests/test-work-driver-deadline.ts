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
 *     park only once the deadline is within the handoff grace ("do not start
 *     a new step after this point" — a step's worst case is not reserved);
 *  5. the driver loop: a running step finishes, and the park lands at the
 *     NEXT boundary, routing to handoff.
 */

import { explainCap } from "../src/work-driver-explain.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import {
  deadlineCheck,
  readCycleDeadline,
} from "../src/work-driver-deadline.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState } from "../src/workflow-state.ts";

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
  // The canonical shape is what the queue's OWN writer produces: `parkReason`
  // returns `cap ${cap.cap}${suffix}`, so a deadline park reaches
  // `humanActionFor` as `cap deadline`. (`cap-hit: deadline` — the event's
  // field name as a prefix — was never a reason any writer emitted.)
  const action = humanActionFor("cap deadline", 1238);
  assert(
    action.includes("deadline") && action.includes("--restart"),
    `queue action for a deadline park names the deadline + restart (got: ${action})`,
  );
  assert(
    !/^inspect \.pi\/work-state/.test(action),
    "a `cap deadline` reason is not the generic inspect-the-state-file fallback",
  );
  // #1101 fix-round — the match is ANCHORED, because a queue-raised park's
  // free-text detail is not a cycle's verdict. A stranded group whose blocker
  // happened to contain the word must still get the queue's own action, not
  // the deadline one.
  const notDeadline = humanActionFor(
    "cap queue-stranded:dependency group(s) group-a never reached its deadline",
    1238,
  );
  assert(
    !/PI_ENSEMBLE_CYCLE_DEADLINE/.test(notDeadline),
    `a queue park merely MENTIONING a deadline gets no deadline advice (got: ${notDeadline})`,
  );
  assert(
    !action.includes("the fix loop did not converge"),
    `the deadline action is not the review-cap action`,
  );
}

// 4. readCycleDeadline: the two env forms + the persisted absolute.
const T0 = 1_800_000_000_000; // a realistic epoch ms (2027)
{
  const s = initialState(1238, 1) as WorkState;
  const setPersisted = (v?: number) => {
    (s.pipelineState as { cycleDeadlineMs?: number }).cycleDeadlineMs = v;
  };
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  assert(
    readCycleDeadline(s, T0) === undefined,
    "no env + no persisted value → no deadline (default behaviour unchanged)",
  );

  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(T0 + 1_000_000);
  assert(
    readCycleDeadline(s, T0) === T0 + 1_000_000,
    "PI_ENSEMBLE_CYCLE_DEADLINE is read as an absolute epoch ms",
  );
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(Math.floor((T0 + 1_000_000) / 1000));
  assert(
    readCycleDeadline(s, T0) === undefined,
    "an epoch in SECONDS (< 1e12) is ignored, not read as a 1970 deadline that parks at once",
  );
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = "not-a-number";
  assert(
    readCycleDeadline(s, T0) === undefined,
    "a malformed deadline env value is ignored (traced, never a cycle failure)",
  );
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;

  process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS = "500000";
  assert(
    readCycleDeadline(s, T0) === T0 + 500_000,
    "PI_ENSEMBLE_CYCLE_BUDGET_MS is a duration resolved from now",
  );
  setPersisted(T0 + 7_000);
  assert(
    readCycleDeadline(s, T0 + 5_000) === T0 + 7_000,
    "with the budget still set, the persisted deadline is kept (the clock carries across a resume)",
  );
  delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  assert(
    readCycleDeadline(s, T0) === undefined,
    "with both env vars cleared, a persisted deadline does NOT outlive them (no deadline)",
  );
}

// 4b. deadlineCheck: parks only once the deadline is within the handoff
// grace; never parks handoff/merged.
{
  const makeCtx = () =>
    ({
      repoRoot: "/tmp/x",
      issue: 1238,
      host: { sendUserMessage: () => {}, sendUserMessageAsync: () => {}, emit: () => {} },
    }) as unknown as Parameters<typeof deadlineCheck>[0];
  delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  delete process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS; // grace = 8 min default
  const GRACE = 8 * 60_000;
  const withDeadline = (d: number) => {
    process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(d);
    return initialState(1238, 1) as WorkState;
  };

  {
    // 1h left: far less than the 2h spawn backstop, but more than the grace.
    const r = await deadlineCheck(makeCtx(), withDeadline(T0 + 3_600_000), "develop", T0);
    assert(r.parked === false, "1h left does not park develop — its worst-case bound is not reserved");
    assert(r.state.eventLog.at(-1)?.kind !== "cap-hit", "no cap-hit appended when a step may start");
    assert(
      r.state.pipelineState.cycleDeadlineMs === T0 + 3_600_000,
      "the resolved deadline rides on the returned state (status line, persistence)",
    );
  }
  {
    const r = await deadlineCheck(makeCtx(), withDeadline(T0 + GRACE), "lens-fix", T0);
    assert(r.parked === true, "now + grace >= deadline parks before a new step");
    const tail = r.state.eventLog.at(-1);
    assert(
      tail?.kind === "cap-hit" && tail.cap === "deadline" && tail.nextStep === "handoff",
      "the park appends cap-hit deadline → handoff",
    );
  }
  {
    const r = await deadlineCheck(makeCtx(), withDeadline(T0 + GRACE + 1), "lens-fix", T0);
    assert(r.parked === false, "1 ms beyond the grace still starts the step");
  }
  {
    const r = await deadlineCheck(makeCtx(), withDeadline(T0 - 1), "handoff", T0);
    assert(r.parked === false, "the handoff step is never parked, even past the deadline");
    const m = await deadlineCheck(makeCtx(), withDeadline(T0 - 1), "merged", T0);
    assert(m.parked === false, "the merged step is never parked");
  }
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  {
    // A stale persisted deadline with no env var is dropped from the state.
    const s = initialState(1238, 1) as WorkState;
    (s.pipelineState as { cycleDeadlineMs?: number }).cycleDeadlineMs = T0;
    const r = await deadlineCheck(makeCtx(), s, "develop", T0 + 1);
    assert(r.parked === false, "no env var → a stale persisted deadline never parks");
    assert(r.state.pipelineState.cycleDeadlineMs === undefined, "...and is dropped from the state");
  }
  {
    process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS = "3600000";
    const r = await deadlineCheck(makeCtx(), initialState(1238, 1) as WorkState, "explore", T0);
    assert(
      r.state.pipelineState.cycleDeadlineMs === T0 + 3_600_000 && r.parked === false,
      "a 1h budget resolves to an absolute epoch and lets explore start",
    );
    delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  }
}

// 5. The driver loop: explore starts with time left, runs PAST the point
// where the deadline enters the grace, finishes, and the park lands at the
// NEXT boundary — that step is never dispatched, the handoff runs, and the
// state ends parked with cap `deadline` (not running, not safety-aborted).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-deadline-loop-"));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "5000";
  process.env.PI_ENSEMBLE_VERIFY = "0";
  process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS = "1000";
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(Date.now() + 3_000);
  try {
    const labels: string[] = [];
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1238,
      issueBodyFetcherFn: async (n) => ({
        stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nbody for #${n}`,
      }),
      dispatchFn: async (_pi, spec, opts) => {
        const label = String(opts?.label ?? spec.role);
        labels.push(label);
        // The first step outlives the grace window: it started in time, so it finishes.
        if (label === "explore") await new Promise((r) => setTimeout(r, 2_100));
        return {
          role: spec.role,
          ok: true,
          text: "VERDICT: NEEDS_WORK",
          toolUses: [],
          ms: 1,
          exitCode: 0,
          transcriptPath: "/tmp/stub-transcript.json",
        } as Awaited<ReturnType<NonNullable<DriverContext["dispatchFn"]>>>;
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 1238);
    const caps = (after?.eventLog ?? []).flatMap((e) => (e.kind === "cap-hit" ? [e.cap] : []));
    const parkEv = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit" && e.cap === "deadline");
    assert(labels[0] === "explore", `the first step starts and runs (dispatched: ${labels.join(",")})`);
    assert(
      labels.filter((l) => l !== "explore" && l !== "ops:handoff").length === 0,
      `no step after explore is dispatched (dispatched: ${labels.join(",")})`,
    );
    assert(labels.includes("ops:handoff"), "the park routes to the handoff dispatch");
    assert(caps.includes("deadline"), `the state carries cap-hit deadline (caps: ${caps.join(",")})`);
    assert(
      parkEv?.kind === "cap-hit" && !String(parkEv.evidence).includes('"explore"'),
      `the park lands at a LATER boundary, not before explore (${parkEv?.kind === "cap-hit" ? parkEv.evidence : "none"})`,
    );
    assert(
      after?.pipelineState.status !== "running" && after?.pipelineState.status !== "aborted",
      `the cycle ends parked, not running or safety-aborted (status: ${after?.pipelineState.status})`,
    );
  } finally {
    delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
    delete process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS;
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);
