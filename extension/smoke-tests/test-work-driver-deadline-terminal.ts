#!/usr/bin/env bun
/**
 * #1593 — the cycle deadline bounds the step in flight, and a clock that
 * ended a step is the cycle's terminal reason, not the step's verdict.
 *
 *  1. cycle-deadline-clock: a cycle's children are bounded by the deadline;
 *     the handoff's by the allowance after it, less the gh-fallback reserve;
 *     nothing outside a cycle (or without a deadline) is touched, and a bound
 *     is never loosened.
 *  2. terminalReasonAtHandoff, on the reference shape (developer
 *     killed at the 2 h backstop, fence verdict `verify-failed:develop` in the
 *     same millisecond): the backstop kill is the terminal cap; with the
 *     deadline passed, `deadline` is, and its evidence keeps the verdict.
 *  3. The verdicts that stand: no kill, a kill re-run to completion, a cap
 *     that already names a clock, `awaiting-human-merge`.
 *  4. deadlineCheck at the handoff boundary applies it (with and without a
 *     deadline), and the headless result reports the new cap.
 *  5. A child killed at the deadline says so in its errorTail.
 *  6. The handoff ops dispatch bound is clamped to the allowance left.
 *  7. The driver loop runs under the clock: a dispatch inside a cycle sees
 *     the bound the deadline leaves.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MIN_CLAMPED_BOUND_MS,
  clampToCycleDeadline,
  handoffFallbackReserveMs,
  noteCycleDeadline,
  runWithCycleClock,
} from "../src/cycle-deadline-clock.ts";
import { projectIssue } from "../src/headless/result.ts";
import type { DispatchResult } from "../src/types.ts";
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import { deadlineCheck } from "../src/work-driver-deadline.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runHandoffOpsDispatch } from "../src/work-driver-handoff-ops.ts";
import { terminalReasonAtHandoff } from "../src/work-driver-terminal-reason.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
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

const T0 = 1_792_283_276_000; // the measured cycle's start, epoch ms
const HOUR = 3_600_000;
const BACKSTOP = 2 * HOUR;

// 1. The clock.
{
  assert(
    clampToCycleDeadline(BACKSTOP, T0).timeoutMs === BACKSTOP,
    "outside a cycle, a child's bound is untouched",
  );
  await runWithCycleClock(async () => {
    assert(
      clampToCycleDeadline(BACKSTOP, T0).timeoutMs === BACKSTOP,
      "inside a cycle with no deadline resolved yet, the bound is untouched",
    );
    noteCycleDeadline(undefined, 480_000, "develop");
    assert(
      clampToCycleDeadline(BACKSTOP, T0).clamped === false,
      "a cycle without a deadline never clamps",
    );
    const D = T0 + 30 * 60_000;
    const A = 8 * 60_000;
    noteCycleDeadline(D, A, "develop");
    const c = clampToCycleDeadline(BACKSTOP, T0);
    assert(
      c.timeoutMs === 30 * 60_000 - A && c.clamped,
      `a developer started 30 min before the deadline is bounded at the deadline less the handoff grace (#1567 item 6), not the 2 h backstop (got ${c.timeoutMs})`,
    );
    const short = clampToCycleDeadline(10 * 60_000, T0);
    assert(
      short.timeoutMs === 10 * 60_000 && !short.clamped,
      "a bound already inside the deadline is never loosened",
    );
    const late = clampToCycleDeadline(BACKSTOP, D + 5_000);
    assert(
      late.timeoutMs === MIN_CLAMPED_BOUND_MS && late.clamped,
      "past the deadline a step child gets only the minimum bound",
    );
    noteCycleDeadline(D, A, "handoff");
    const h = clampToCycleDeadline(A, D + 5 * 60_000);
    const expected = D + A - handoffFallbackReserveMs(A) - (D + 5 * 60_000);
    assert(
      h.timeoutMs === expected && h.clamped,
      `a handoff that starts 5 min past the deadline ends before the kill (deadline + allowance), less the fallback reserve (got ${h.timeoutMs}, want ${expected})`,
    );
    assert(
      clampToCycleDeadline(A, D).timeoutMs === Math.min(A, A - handoffFallbackReserveMs(A)),
      "a handoff starting at the deadline keeps the allowance minus the reserve",
    );
  });
  assert(handoffFallbackReserveMs(480_000) === 60_000, "the fallback reserve is at most a minute");
  assert(handoffFallbackReserveMs(40_000) === 20_000, "...and at most half a small allowance");
  assert(
    clampToCycleDeadline(BACKSTOP, T0).timeoutMs === BACKSTOP,
    "the clock does not leak out of the cycle that set it",
  );
}

// The reference shape: the developer killed at the 2 h backstop,
// the fence gate's verdict recorded in the same millisecond.
const AT = Date.parse("2026-10-18T03:13:15.845Z");
const KILL_TAIL =
  "[pi-rukas] killed after 7200000ms timeout (override: PI_ENSEMBLE_SPAWN_TIMEOUT_MS)";
const FENCE =
  "workstream default touched out-of-scope path lib/questions.sh — declared fence violated (issue-fenced)";
function cycle175(extra: WorkEvent[] = []): WorkState {
  const s = initialState(175, T0) as WorkState;
  s.pipelineState.currentStep = "handoff";
  s.eventLog.push(
    { kind: "step-started", step: "develop", at: AT - BACKSTOP },
    {
      kind: "dispatch-failed",
      step: "develop",
      role: "developer",
      jobId: "j1",
      label: "developer:default",
      ms: BACKSTOP,
      at: AT,
      errorTail: KILL_TAIL,
      killCause: "timeout",
    } as WorkEvent,
    ...extra,
    {
      kind: "cap-hit",
      at: AT,
      cap: "verify-failed:develop",
      reviewRound: 0,
      nextStep: "handoff",
      evidence: FENCE,
    },
  );
  return s;
}
const lastCapOf = (s: WorkState) => {
  const e = [...s.eventLog].reverse().find((x) => x.kind === "cap-hit");
  return e?.kind === "cap-hit" ? e : undefined;
};

// 2. The backstop kill and the deadline win over the step's verdict.
{
  const out = terminalReasonAtHandoff(cycle175(), undefined, AT + 1);
  const cap = lastCapOf(out);
  assert(
    cap?.cap === "spawn-backstop",
    `175: a developer killed at its backstop is the terminal cap, not the fence verdict (got ${cap?.cap})`,
  );
  assert(
    String(cap?.evidence).includes("verify-failed:develop") &&
      String(cap?.evidence).includes("7200000ms"),
    `...and its evidence names both the kill and the verdict it replaces (${cap?.evidence})`,
  );
  assert(
    out.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop"),
    "the step's own verdict stays in the log",
  );
  const running = { ...out, pipelineState: { ...out.pipelineState, status: "running" as const } };
  assert(
    validateDiscriminants(running).length === 0,
    `the appended cap validates (${JSON.stringify(validateDiscriminants(running))})`,
  );
}
{
  const D = AT - 60_000;
  const out = terminalReasonAtHandoff(cycle175(), D, AT + 1);
  const cap = lastCapOf(out);
  assert(
    cap?.cap === "deadline",
    `past the deadline, the terminal cap is deadline (got ${cap?.cap})`,
  );
  const ev = String(cap?.evidence);
  assert(
    ev.includes(String(D)) && ev.includes('"develop"') && ev.includes("verify-failed:develop"),
    `the deadline evidence names the deadline, the step in flight and the verdict it replaces (${ev})`,
  );
  assert(ev.includes("developer:default"), "...and the child the step lost");
  const explain = explainCap("deadline", out);
  assert(
    explain.includes("ended the cycle") && !explain.includes("was within the handoff grace"),
    `explainCap tells a step that ran past the deadline from a boundary park (${explain.slice(0, 100)}…)`,
  );
  assert(
    out.eventLog.filter((e) => e.kind === "cap-hit").length === 2,
    "exactly one cap is appended (deadline, not deadline + spawn-backstop)",
  );
}
{
  const s = initialState(175, T0) as WorkState;
  s.eventLog.push(
    { kind: "step-started", step: "lens-review", at: AT - 1000 },
    { kind: "cap-hit", at: AT, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
  );
  const out = terminalReasonAtHandoff(s, AT - 1, AT);
  assert(
    lastCapOf(out)?.cap === "deadline",
    "a verdict reached past the deadline with no kill is still superseded by deadline",
  );
}

// 3. Verdicts that stand.
{
  const s = cycle175();
  s.eventLog.splice(1, 1); // no kill
  const out = terminalReasonAtHandoff(s, AT + HOUR, AT);
  assert(out === s, "no kill and the deadline not passed: the verdict stands");
}
{
  const rerun: WorkEvent[] = [
    {
      kind: "dispatch-completed",
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer:default",
      ms: 5,
      at: AT,
    } as WorkEvent,
  ];
  const s = cycle175(rerun);
  assert(
    terminalReasonAtHandoff(s, undefined, AT) === s,
    "a killed child re-run to completion: the verdict judged a whole tree and stands",
  );
}
for (const cap of [
  "spawn-backstop",
  "deadline",
  "verify-timeout:develop",
  "step-failed:develop",
]) {
  const s = cycle175();
  const last = s.eventLog.at(-1);
  if (last?.kind === "cap-hit") last.cap = cap as typeof last.cap;
  assert(
    terminalReasonAtHandoff(s, AT - 1, AT) === s,
    `a cap that already names what ended the step (${cap}) stands`,
  );
}
{
  const s = initialState(175, T0) as WorkState;
  s.eventLog.push(
    { kind: "step-started", step: "merged", at: AT - 1000 },
    { kind: "cap-hit", at: AT, cap: "awaiting-human-merge", reviewRound: 1, nextStep: "handoff" },
  );
  assert(
    terminalReasonAtHandoff(s, AT - 1, AT) === s,
    "awaiting-human-merge (finished work waiting on a person) stands past the deadline",
  );
}

// 4. deadlineCheck at the handoff boundary + the headless result.
{
  const ctx = { repoRoot: "/tmp/x", issue: 175 } as unknown as Parameters<typeof deadlineCheck>[0];
  delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  const none = await deadlineCheck(ctx, cycle175(), "handoff", AT + 1);
  assert(
    !none.parked && lastCapOf(none.state)?.cap === "spawn-backstop",
    "with no deadline set, the handoff boundary still records the backstop kill",
  );
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(AT - 1);
  const past = await deadlineCheck(ctx, cycle175(), "handoff", AT + 1);
  assert(
    !past.parked && lastCapOf(past.state)?.cap === "deadline",
    "past PI_ENSEMBLE_CYCLE_DEADLINE, the handoff boundary records deadline",
  );
  const result = projectIssue(past.state, "/tmp/x/.pi/work-state/175.json");
  assert(result.cap === "deadline", `the headless result's cap is deadline (got ${result.cap})`);
  assert(
    result.failedStep === "develop",
    `...and its failedStep is the step in flight (got ${result.failedStep})`,
  );
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(AT + HOUR);
  const before = await deadlineCheck(ctx, cycle175(), "handoff", AT + 1);
  assert(
    lastCapOf(before.state)?.cap === "spawn-backstop",
    "deadline not yet passed: the backstop kill, not deadline, is recorded",
  );
  delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
}

// 5. A child killed at the deadline says so.
{
  const ctx = { repoRoot: "/tmp/x", issue: 175 } as unknown as CycleContext;
  const res = {
    role: "developer",
    ok: false,
    text: "",
    toolUses: [],
    ms: 1_000,
    exitCode: null,
    killCause: "timeout",
    killBudgetMs: 1_000,
    killedAtCycleDeadline: true,
  } as DispatchResult;
  const ev = await buildCompletionEvent(ctx, "develop", "developer", "developer:default", res);
  const tail = ev.kind === "dispatch-failed" ? String(ev.errorTail) : "";
  assert(
    tail.includes("cycle deadline") && tail.includes("PI_ENSEMBLE_CYCLE_DEADLINE"),
    `a deadline kill names the deadline, not the spawn backstop knob (${tail})`,
  );
  assert(
    !tail.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS"),
    "...and does not send the reader to the backstop",
  );
}

// 6. The handoff ops dispatch bound.
{
  const dir = mkdtempSync(path.join(tmpdir(), "deadline-terminal-ops-"));
  process.env.PI_ENSEMBLE_RESUME = "0";
  process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS = String(10 * 60_000);
  try {
    let seen: number | undefined;
    const ctx = {
      repoRoot: dir,
      issue: 329,
      host: {},
      emitSink: createEmitSink(() => undefined),
      dispatchFn: async (_h: unknown, spec: { role: string }, opts?: { timeoutMs?: number }) => {
        seen = opts?.timeoutMs;
        return { role: spec.role, ok: true, text: "", toolUses: [], ms: 1, exitCode: 0 };
      },
    } as unknown as CycleContext;
    const A = 10 * 60_000;
    await runWithCycleClock(async () => {
      // The handoff begins 8 min past the deadline: 2 min of allowance left.
      const D = Date.now() - 8 * 60_000;
      noteCycleDeadline(D, A, "handoff");
      await runHandoffOpsDispatch(ctx, initialState(329) as WorkState, path.join(dir, "h.md"));
    });
    const left = 2 * 60_000 - handoffFallbackReserveMs(A);
    assert(
      seen !== undefined && seen <= left && seen > left - 5_000,
      `a late handoff's ops dispatch is bounded by the allowance left, not the full allowance (got ${seen}, want ≈${left})`,
    );
  } finally {
    delete process.env.PI_ENSEMBLE_RESUME;
    delete process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS;
    rmSync(dir, { recursive: true, force: true });
  }
}

// 7. The driver loop runs every step under the cycle's clock.
{
  const dir = mkdtempSync(path.join(tmpdir(), "deadline-terminal-loop-"));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  process.env.PI_ENSEMBLE_VERIFY = "0";
  process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS = "1000";
  const deadline = Date.now() + 60_000;
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(deadline);
  try {
    const bounds: Record<string, number> = {};
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1593,
      issueBodyFetcherFn: async (n) => ({
        stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nbody for #${n}`,
      }),
      dispatchFn: async (_pi, spec, opts) => {
        // What a real spawn would be given for a 2 h backstop at this moment.
        bounds[String(opts?.label ?? spec.role)] = clampToCycleDeadline(
          BACKSTOP,
          Date.now(),
        ).timeoutMs;
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
    const explore = bounds.explore;
    assert(
      explore !== undefined && explore <= 60_000 && explore > 50_000,
      `a step's child inside the driver loop is bounded by the deadline (explore: ${explore}ms)`,
    );
  } finally {
    delete process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
    delete process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS;
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);
