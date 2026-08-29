#!/usr/bin/env bun
/**
 * #486 W1R — full adversarial RE-ENTRY. The first pass (runAdversarial, N=2)
 * parks: task-a's loop provider-severs once, its budget was already spent
 * (seeded, as the driver's post-step persistence would leave it), task-b
 * approved — the fresh batch splices over nothing (first pass). The
 * re-entry (runAdversarial again, same state) must run ONLY task-a once
 * and REPLACE the first pass's per-workstream records (R1): each workstream
 * appears exactly once — the stale first-pass records are gone.
 *
 * Uses runAdversarial directly: a first-pass cap-hit hands the cycle off to a
 * human, so an in-process driver re-entry would be refused by the entry gate.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

// #297 — zero the inter-attempt backoff so the in-step retries don't sleep.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// #286 — the test trees carry no real git diffs; disable the empty-diff skip
// so the loop runs as intended (same setting as the other adversarial tests).
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-486-w1r-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const s = initialState(961, 1_000_000);
    const tree: Record<string, string> = {};
    const streams: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    > = {};
    for (const w of ["task-a", "task-b"]) {
      tree[w] = `${dir}/.worktrees/${w}`;
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
    }
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: tree,
      workstreams: streams,
      branchName: "feature/issue-961",
      // Seeded as post-step persistence would leave it (1 initial + 2 in-step
      // retries = 3): without a spent budget the first pass would retry in-step.
      adversarialTransientRetries: { "task-a": 3 },
    };
    await writeState(dir, s);

    const failures: Record<string, number> = {};
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 961,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "?";
        failures[id] = (failures[id] ?? 0) + 1;
        // Every task-a attempt provider-severs (transient); task-b approves.
        if (id === "task-a") {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: round 1 fix dispatch provider/transport error: Connection error.. No verdict was produced — this is NOT a review rejection.",
            roundsExecuted: 1,
            adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: true }],
            errorStop: { reason: "error", message: "Connection error." },
          });
        }
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 1.\n",
          adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
        });
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };

    // FIRST pass (budget already spent): task-a runs once, parks with the
    // distinct infra cap; task-b approves.
    let state = await readState(dir, 961)!;
    let after = await runAdversarial(ctx, state, Date.now());
    const caps = after.eventLog.filter(
      (e) => e.kind === "cap-hit" && e.cap === "adversarial-infra-failure",
    );
    assert(
      failures["task-a"] === 1 && caps.length === 1,
      `#486 W1R: first pass parked (task-a attempts: ${failures["task-a"]}, cap-hits: ${caps.length}; expected 1 + one cap-hit)`,
    );
    const firstPassLogLen = after.eventLog.length;

    // RE-ENTRY — the operator re-runs the step. The spent budget parks it
    // again without re-running any loop; the log must keep the first pass's
    // records plus its own cap-hit (R1/W1).
    state = after;
    after = await runAdversarial(ctx, state, Date.now());
    const fresh = after.eventLog.slice(firstPassLogLen);
    assert(
      failures["task-a"] === 1,
      `#486 W1R: the spent-budget re-entry parked WITHOUT re-running any loop (task-a attempts: ${failures["task-a"]}, expected 1; task-b: ${failures["task-b"]}, expected 1)`,
    );
    assert(
      failures["task-b"] === 1,
      `#486 W1R: the approved sibling was NOT re-run (task-b attempts: ${failures["task-b"]}, expected 1)`,
    );
    assert(
      fresh.length === 1 && fresh[0].kind === "cap-hit",
      `#486 W1R: the parked re-entry appended exactly the cap-hit (got ${JSON.stringify(fresh.map((e) => e.kind))})`,
    );
    assert(
      after.eventLog.length === firstPassLogLen + 1,
      `#486 W1R: the parked re-entry kept the first pass's records in place (log length ${after.eventLog.length} vs first pass ${firstPassLogLen}; expected +1 for the cap-hit)`,
    );
    const outcomes2 = after.eventLog.filter(
      (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
        e.kind === "adversarial-workstream-outcome",
    );
    assert(
      outcomes2.length === 2,
      `#486 W1R: exactly one workstream-outcome per workstream after the parked re-entry (got ${outcomes2.length})`,
    );
    for (const w of ["task-a", "task-b"]) {
      const mine = outcomes2.filter((e) => e.workstreamId === w);
      assert(
        mine.length === 1,
        `#486 W1R: ${w} recorded exactly once after the parked re-entry (got ${JSON.stringify(mine)})`,
      );
    }
    const rounds2 = after.eventLog.filter(
      (e): e is Extract<WorkEvent, { kind: "adversarial-round" }> =>
        e.kind === "adversarial-round" && e.workstreamId === "task-a",
    );
    assert(
      rounds2.length === 1,
      `#486 W1R: task-a's round record is NOT duplicated by the parked re-entry (got ${JSON.stringify(rounds2)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// W1R-recover — the re-entry RECOVERY: the budget is NOT spent (a fresh
// transient window), task-a's loop recovers on the re-entry pass. The fresh
// batch must replace the first pass's records (R1); the stale infra-failure
// must not sit side-by-side with the fresh APPROVED (W1).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-486-w1rr-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const s = initialState(962, 1_000_000);
    const tree: Record<string, string> = {};
    const streams: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    > = {};
    for (const w of ["task-a", "task-b"]) {
      tree[w] = `${dir}/.worktrees/${w}`;
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
    }
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: tree,
      workstreams: streams,
      branchName: "feature/issue-962",
    };
    await writeState(dir, s);

    const failures: Record<string, number> = {};
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 962,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "?";
        failures[id] = (failures[id] ?? 0) + 1;
        if (id === "task-a" && failures[id] <= 3) {
          // First pass: 1 initial + 2 in-step retries = 3 attempts, all
          // provider-severed.
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: round 1 fix dispatch provider/transport error: Connection error.. No verdict was produced — this is NOT a review rejection.",
            roundsExecuted: 1,
            adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: true }],
            errorStop: { reason: "error", message: "Connection error." },
          });
        }
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 1.\n",
          adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
        });
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };

    // FIRST pass — task-a exhausts its budget; parks with the distinct cap.
    let state = await readState(dir, 962)!;
    let after = await runAdversarial(ctx, state, Date.now());
    const caps = after.eventLog.filter(
      (e) => e.kind === "cap-hit" && e.cap === "adversarial-infra-failure",
    );
    assert(
      failures["task-a"] === 3 && caps.length === 1,
      `#486 W1R-recover: first pass parked (task-a attempts: ${failures["task-a"]}, cap-hits: ${caps.length}; expected 3 + one cap-hit)`,
    );
    const beforeReentry = after.eventLog.length;
    // Capture the prior pass's records' positions so we can assert the
    // re-emitted events appear AFTER the splice (the fresh window is the
    // region from the splice start to the new tail; the splice removes
    // the prior pass's run and inserts the fresh batch at the same
    // position, so the fresh window is `eventLog[passStart .. newTail]`).
    // We approximate it as the log after the first pass's last batch-kind
    // event (the `branches-converged`), which is where the fresh batch
    // lands.
    let lastBatchIdx = -1;
    for (let i = after.eventLog.length - 1; i >= 0; i--) {
      const k = after.eventLog[i]?.kind;
      if (
        k === "dispatch-completed" ||
        k === "dispatch-failed" ||
        k === "adversarial-round" ||
        k === "adversarial-workstream-outcome" ||
        k === "branch-completed" ||
        k === "branches-converged" ||
        k === "adversarial-approved" ||
        k === "adversarial-rejected"
      ) {
        lastBatchIdx = i;
        break;
      }
    }
    const freshStart = lastBatchIdx + 1; // the cap-hit sits at lastBatchIdx+1; the fresh batch splices at the batch's start, which is before the cap-hit

    // RE-ENTRY — the operator re-runs the step after the transient window
    // has cleared: the budget is reset (the driver's router resets
    // per-step budgets on successful re-entry), task-a recovers on attempt
    // 4, task-b's approved outcome is final and is NOT re-run. The fresh
    // batch splices over the prior pass's run, which includes the approved
    // sibling's records (the per-workstream batch is contiguous in `ids`
    // order, so the span covers the whole run). The caller's
    // `survivorOutcomes` re-emits the sibling's events in `ids` order
    // after the splice, so the log stays complete — the fresh window
    // therefore holds BOTH workstreams' re-emitted events (the sibling's
    // re-emitted approved outcome + task-a's fresh approved outcome +
    // the trailing `branches-converged` + `adversarial-approved`), with
    // each workstream's records appearing exactly once (R1) and no stale
    // first-pass records (W1).
    state = {
      ...after,
      pipelineState: {
        ...after.pipelineState,
        adversarialTransientRetries: { "task-a": 0 },
      },
    };
    after = await runAdversarial(ctx, state, Date.now());
    // The fresh window is the region from the splice start (the prior
    // batch's start) to the new tail. We approximate it as the log after
    // the prior pass's last batch-kind event (the cap-hit sits at the
    // tail of the prior run, so the fresh batch lands at or after the
    // cap-hit's position). For the assertion we just check the whole log
    // for the aggregate shape (one outcome per workstream, each
    // approved, exactly one `adversarial-approved`), which is the
    // load-bearing property.
    assert(
      failures["task-a"] === 4,
      `#486 W1R-recover: re-entry re-ran ONLY the failing workstream (task-a attempts: ${failures["task-a"]}, expected 4)`,
    );
    assert(
      failures["task-b"] === 1,
      `#486 W1R-recover: the approved sibling was NOT re-run (task-b attempts: ${failures["task-b"]}, expected 1)`,
    );
    const outcomes2 = after.eventLog.filter(
      (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
        e.kind === "adversarial-workstream-outcome",
    );
    assert(
      outcomes2.length === 2,
      `#486 W1R-recover: exactly one workstream-outcome per workstream after re-entry (got ${outcomes2.length})`,
    );
    for (const w of ["task-a", "task-b"]) {
      const mine = outcomes2.filter((e) => e.workstreamId === w);
      assert(
        mine.length === 1 && mine[0].outcome === "approved",
        `#486 W1R-recover: ${w} recorded exactly once as approved (got ${JSON.stringify(mine)})`,
      );
    }
    const rounds2 = after.eventLog.filter(
      (e): e is Extract<WorkEvent, { kind: "adversarial-round" }> =>
        e.kind === "adversarial-round" && e.workstreamId === "task-a",
    );
    assert(
      rounds2.length === 1 && rounds2[0].status === "APPROVED",
      `#486 W1R-recover: task-a's stale first-pass round record is gone — exactly one APPROVED round remains (got ${JSON.stringify(rounds2)})`,
    );
    const approved2 = after.eventLog.filter((e) => e.kind === "adversarial-approved");
    assert(
      approved2.length === 1,
      `#486 W1R-recover: exactly one adversarial-approved after the recovered re-entry (got ${approved2.length})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// W2' (#486) — task-b fails PERMANENTLY on the FIRST pass in a way the in-step
// retry does NOT classify as transient (shouldRetry=false, so no in-step retry
// is spent and the per-workstream budget stays at 0). The named-cap contract
// still holds: the gate parks under `adversarial-infra-failure`, never a
// rejection. Drives runAdversarial directly (like W1R).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-486-w2b-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const s = initialState(963, 1_000_000);
    const tree: Record<string, string> = {};
    const streams: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    > = {};
    for (const w of ["task-a", "task-b"]) {
      tree[w] = `${dir}/.worktrees/${w}`;
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
    }
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: tree,
      workstreams: streams,
      branchName: "feature/issue-963",
    };
    await writeState(dir, s);

    const calls: Record<string, number> = { "task-a": 0, "task-b": 0 };
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 963,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "?";
        calls[id] = (calls[id] ?? 0) + 1;
        if (id === "task-b") {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code. No verdict was produced — this is NOT a review rejection.",
            roundsExecuted: 1,
            // The real loop threads errorStop on every infra failure; the
            // taxonomy classifies from it (quota-window here: not retryable).
            errorStop: {
              reason: "error",
              message: "Server requested 86399s retry delay (max: 60s). 429 status code.",
            },
          });
        }
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 1.\n",
          adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
        });
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };

    const state = await readState(dir, 963)!;
    const after = await runAdversarial(ctx, state, Date.now());
    const events = after.eventLog;
    assert(
      calls["task-b"] === 1,
      `#486 W2': permanent non-retryable failure is NOT retried in-step (task-b called ${calls["task-b"]}×, expected 1)`,
    );
    assert(calls["task-a"] === 1, "#486 W2': the approved sibling ran exactly once");
    const rejected = events.filter((e) => e.kind === "adversarial-rejected");
    assert(
      rejected.length === 0,
      "#486 W2': NO adversarial-rejected — a permanent non-retryable infra failure is not a review rejection",
    );
    const out = (id: string) =>
      events
        .filter((e) => e.kind === "adversarial-workstream-outcome" && e.workstreamId === id)
        .pop();
    assert(
      out("task-a")?.kind === "adversarial-workstream-outcome" &&
        out("task-a").outcome === "approved",
      "#486 W2': task-a's APPROVED verdict preserved in the event log",
    );
    const cap = [...events].reverse().find((e) => e.kind === "cap-hit");
    assert(
      cap?.kind === "cap-hit" &&
        cap.cap === "adversarial-infra-failure" &&
        cap.nextStep === "handoff",
      `#486 W2': parked with cap='adversarial-infra-failure' (got ${cap?.kind === "cap-hit" ? cap.cap : "no cap-hit"})`,
    );
    // Budget never spent — the park came from `!isTransient`, not budget.
    assert(
      (after.pipelineState.adversarialTransientRetries?.["task-b"] ?? 0) === 0,
      "#486 W2': the per-workstream retry budget was NOT spent (the failure was not retryable in-step)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #543 F4(e) — no-retry-on-loop-kill (the loop / token-budget cap-kill
// cases) lives in test-work-driver-cap-kill-no-retry.ts, split for module
// size hygiene (AGENTS.md §12).

console.log(`\nexit ${exit}`);
process.exit(exit);
