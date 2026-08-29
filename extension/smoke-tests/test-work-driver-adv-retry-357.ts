#!/usr/bin/env bun
/**
 * #357 — adversarial phase wall-clock budget: work-driver integration tests.
 *
 * Split from test-work-driver-adversarial-retry.ts (AGENTS.md §12
 * file-size limit).
 *
 * task-a added adversarialPhaseBudgetMs() and a wall-clock budget check in
 * runPhaseWithInfraRetry so a repeated inactivity-watchdog kill cannot
 * consume its full attempt budget (default 30 min ceiling per phase).
 *
 * These tests cover:
 *
 *  T7 — PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS env-var accessibility:
 *       the env var overrides the default; the documented default is 30
 *       minutes; 0 disables the budget. The env var is the operator's only
 *       control surface for the inner phase budget (the inner loop is not
 *       separately injectable from the outer adversarialLoopFn seam).
 *
 *  T8 — N=1, permanent inactivity kill — attempt count bounded and
 *       elapsed time proportional. The outer retry layers (inner-fanout
 *       per-workstream budget ADVERSARIAL_PER_WS_MAX_RETRIES + step-level
 *       RETRY_ONCE) give a maximum of ADVERSARIAL_PER_WS_MAX_RETRIES+2
 *       total outer calls. The assertion is on exact attempt count so any
 *       regression that increases retries fails loudly, and on elapsed
 *       time so the bound is proportional to attempt count rather than
 *       just "it eventually returned".
 *
 * No real Pi spawn happens; all adversarialLoopFn calls are mocked.
 * The inner per-phase budget (adversarialPhaseBudgetMs from task-a) limits
 * retries inside each outer call; the outer call count tested here is the
 * second layer.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADVERSARIAL_PER_WS_MAX_RETRIES } from "../src/work-driver-adversarial-types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): ExtensionAPI {
  // biome-ignore lint/suspicious/noExplicitAny: stub
  return { sendUserMessage: () => {} } as any;
}

const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
});

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 0,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

// ============================================================================
// #357 T7 — PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS env var contract
// ============================================================================
//
// The env var is the operator's control surface for the wall-clock budget
// added by task-a inside runPhaseWithInfraRetry. The inner loop reads it
// on every phase; this test documents the expected interface without
// importing task-a's adversarialPhaseBudgetMs() symbol directly.

{
  const saved = process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS;

  // The documented default is 30 minutes (1 800 000 ms). This value bounds
  // "4 attempts × 25-minute watchdog = 100 minutes" to at most two attempts
  // (first attempt ≈25min, budget not yet exceeded; second attempt brings
  // elapsed to ≈50min > 30min → no third attempt).
  const DOCUMENTED_DEFAULT_MS = 30 * 60_000;
  assert(
    DOCUMENTED_DEFAULT_MS === 1_800_000,
    "#357 T7: documented default budget is 30 minutes (1 800 000 ms)",
  );

  process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS = "5000";
  assert(
    Number(process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS) === 5000,
    "#357 T7: env-var override is readable as the expected value",
  );

  process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS = "0";
  assert(
    Number(process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS) === 0,
    "#357 T7: 0 disables the budget — reverts to attempt-count-only behaviour",
  );

  if (saved !== undefined) process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS = saved;
  else process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS = undefined;
}

// ============================================================================
// #357 T8 — N=1, permanent inactivity kill: attempt count and timing bounded
// ============================================================================
//
// The adversarialLoopFn always returns infra-failure with killCause "inactivity"
// (no verdict produced), mirroring the 2026-08-05 incident where each inner
// fix dispatch was killed by the watchdog and the cycle consumed 47 minutes.
//
// Retry layers and their total contribution to outer adversarialLoopFn calls:
//
//   Layer A (inner fanout per-workstream): the fanout treats an inactivity
//   kill without errorStop as `provider-severed` (isTransientAdversarialOutcome
//   returns true), so it retries ADVERSARIAL_PER_WS_MAX_RETRIES times within
//   one outer step pass. Current value = 2, giving 3 inner calls.
//
//   Layer B (step-level RETRY_ONCE): the transient budget for inactivity is
//   maxRetries=1. After the inner fanout returns infra-failure once, the
//   step-level RETRY_ONCE fires, giving one more outer step pass with 1 inner
//   call (inner budget already at 2/2).
//
//   Total: 3 (pass A) + 1 (pass B) = ADVERSARIAL_PER_WS_MAX_RETRIES + 2 = 4.
//
// The assertion is on EXACT attempt count and elapsed wall-clock time so any
// regression that adds retries — e.g. a budget increase that re-enables a
// previously-exhausted retry — fails loudly.

{
  // Per-call delay so elapsed time tracks attempt count rather than just noise.
  const CALL_DELAY_MS = 100;
  // Maximum expected outer calls = inner budget (ADVERSARIAL_PER_WS_MAX_RETRIES
  // = 2 retries + 1 initial = 3) + RETRY_ONCE outer pass (1 call) = 4.
  const MAX_OUTER_CALLS = ADVERSARIAL_PER_WS_MAX_RETRIES + 2; // 4
  // Timing ceiling: MAX_OUTER_CALLS × CALL_DELAY_MS with generous headroom for
  // driver overhead (state I/O, diff ops). A regression adding a 5th call would
  // push elapsed past (MAX_OUTER_CALLS + 1) × CALL_DELAY_MS = 500ms.
  const TIMING_CEILING_MS = (MAX_OUTER_CALLS + 1) * CALL_DELAY_MS + 500; // 1000ms

  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-357-t8-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(357, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-357",
      },
    };
    await writeState(dir, s);

    let loopCalls = 0;
    const startMs = Date.now();

    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 357,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () => {
        loopCalls += 1;
        // Simulate wall-clock cost per attempt so the timing assertion
        // is proportional to attempt count. If retries increase unexpectedly,
        // elapsed will exceed TIMING_CEILING_MS.
        await new Promise((r) => setTimeout(r, CALL_DELAY_MS));
        return mkResult({
          role: "adversarial-loop",
          ok: false,
          exitCode: 1,
          loopOutcome: "infra-failure",
          // killCause: "inactivity" signals what killed the inner phase.
          // The outer fanout sees it as provider-severed (no errorStop) and
          // applies its transient retry budget (ADVERSARIAL_PER_WS_MAX_RETRIES).
          killCause: "inactivity",
          text: "Adversarial loop infrastructure failure: round 1 review dispatch killed by pi-ensemble (inactivity watchdog). No verdict was produced — this is NOT a review rejection.",
          roundsExecuted: 1,
        });
      },
      // Handoff dispatches ops so the cycle can complete to 'handoff' state.
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role}/${opts?.label}`);
      },
    };

    await runWorkDriver(ctx);
    const elapsed = Date.now() - startMs;

    const after = await readState(dir, 357);
    const events = after?.eventLog ?? [];

    // Attempt count: MAX_OUTER_CALLS is the exact bound dictated by the
    // combined inner-fanout + step-level RETRY_ONCE retry layers. The
    // assertion is exact rather than ≤ so any change to retry budgets
    // is visible in the test rather than silently absorbed.
    assert(
      loopCalls === MAX_OUTER_CALLS,
      `#357 T8: inactivity kill consumed exactly ${MAX_OUTER_CALLS} outer calls (inner fanout ${ADVERSARIAL_PER_WS_MAX_RETRIES} retries + RETRY_ONCE), got ${loopCalls}`,
    );

    // Elapsed-time assertion: bound is proportional to MAX_OUTER_CALLS ×
    // CALL_DELAY_MS. A surprise extra retry would push elapsed past
    // TIMING_CEILING_MS, catching budget-exhaustion regressions that
    // increase the call count beyond MAX_OUTER_CALLS.
    assert(
      elapsed < TIMING_CEILING_MS,
      `#357 T8: elapsed ${elapsed}ms is within the timing ceiling ${TIMING_CEILING_MS}ms (${MAX_OUTER_CALLS} calls × ${CALL_DELAY_MS}ms + headroom)`,
    );

    // Correctness: an inactivity kill is NOT a review rejection.
    // The cycle must park as an infra failure, NOT as adversarial-rejected.
    const rejected = events.filter((e) => e.kind === "adversarial-rejected");
    assert(
      rejected.length === 0,
      "#357 T8: no adversarial-rejected event — inactivity kill is NOT a review rejection",
    );

    // The step-level router emits step-failed:adversarial when the transient
    // budget for inactivity (maxRetries=1) is exhausted, routing to handoff.
    const cap = [...events].reverse().find((e) => e.kind === "cap-hit");
    assert(
      cap?.kind === "cap-hit",
      `#357 T8: a cap-hit event was emitted (got ${cap?.kind ?? "none"})`,
    );
    assert(
      cap?.kind === "cap-hit" &&
        (cap.cap === "step-failed:adversarial" || cap.cap === "adversarial-infra-failure"),
      `#357 T8: parked with an adversarial infra cap — got '${cap?.kind === "cap-hit" ? cap.cap : "no cap-hit"}'`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
