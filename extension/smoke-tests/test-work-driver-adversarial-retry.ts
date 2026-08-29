#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: #298 T5-T6: adversarial loop REJECTED-verdict vs infra-failure
 * retry, and #486 per-workstream infra retry in an N>1 fan-out.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
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

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
// Offline suite: the full-driver tests below are fully stubbed (injected
// loopFn + rejecting dispatchFn), so no real spawn can start; these caps
// only keep any accidental path from hanging the suite.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

function makeFakePi(): ExtensionAPI {
  // biome-ignore lint/suspicious/noExplicitAny: stub; only sendUserMessage is called
  return { sendUserMessage: () => {} } as any;
}

// PR11 — non-empty issue body so runExplore's empty-body halt guard
// (PR11 §C) doesn't fire in tests without a GitHub remote.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// ============================================================================
// #298 — adversarial loop: REJECTED is a verdict, infra failure is retried
// ============================================================================

// T5 (#298) — REJECTED verdict records dispatch-completed (not dispatch-failed-with-menu-errorTail) + adversarial-rejected.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-rejected-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(954, 1_000_000);
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
        branchName: "feature/issue-954",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 954,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: false,
          exitCode: 1,
          loopOutcome: "rejected",
          text: "❌ Adversarial REJECTED after 3 rounds. Last verdict: ISSUES_FOUND\n\nreal findings here",
        }),
      dispatchFn: async (_pi, spec, opts) =>
        opts?.label === "ops:handoff"
          ? mkResult({ role: "ops", text: "Posted." })
          : Promise.reject(new Error(`unexpected: ${spec.role}`)),
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 954);
    const events = after?.eventLog ?? [];
    assert(
      !events.some((e) => e.kind === "dispatch-failed" && e.step === "adversarial"),
      "#298 T5: REJECTED verdict records NO dispatch-failed event",
    );
    assert(
      events.some((e) => e.kind === "dispatch-completed" && e.step === "adversarial"),
      "#298 T5: REJECTED verdict records dispatch-completed (the review DID complete)",
    );
    assert(
      events.some((e) => e.kind === "adversarial-rejected"),
      "#298 T5: adversarial-rejected verdict event present",
    );
    assert(after?.pipelineState.status === "handoff", "#298 T5: cycle routes to handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T6 (#298) — infra-failure → RETRY_ONCE re-run + recovery.

// ============================================================================
// #486 — per-workstream infra retry in an N>1 fan-out
// ============================================================================

function advFanoutState(issue: number, dir: string, worktrees: string[]): typeof initialState {
  const s = initialState(issue, 1_000_000);
  const tree: Record<string, string> = {};
  const streams: Record<
    string,
    { id: string; scope: string; paths: string[]; outOfScope: string[] }
  > = {};
  for (const w of worktrees) {
    tree[w] = `${dir}/.worktrees/${w}`;
    streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
  }
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: tree,
      workstreams: streams,
      branchName: `feature/issue-${issue}`,
    },
  };
}

// W1 (#486) — 3 workstreams; task-b's loop fails transiently on the first pass and succeeds on the in-step retry. The retry must occur (2 loop calls for task-b) and the aggregate must approve on task-b's recovered verdict — no handoff, no cap-hit.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-486-w1-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const s = advFanoutState(958, dir, ["task-a", "task-b", "task-c"]);
    await writeState(dir, s);

    const calls: Record<string, number> = { "task-a": 0, "task-b": 0, "task-c": 0 };
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 958,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "?";
        calls[id] = (calls[id] ?? 0) + 1;
        if (id === "task-b" && calls[id] === 1) {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: round 1 fix dispatch provider/transport error: Connection error.. No verdict was produced — this is NOT a review rejection.",
            roundsExecuted: 1,
            // Incident shape: errorStop "error" = provider-severed = retried.
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
      dispatchFn: async (_pi, spec, opts) => {
        throw new Error(`halting: ${spec.role}/${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 958);
    const events = after?.eventLog ?? [];
    assert(
      calls["task-b"] === 2,
      `#486 W1: transient failure retried in-step (task-b called ${calls["task-b"]}×, expected 2)`,
    );
    assert(
      calls["task-a"] === 1 && calls["task-c"] === 1,
      "#486 W1: healthy siblings were NOT re-run",
    );
    assert(
      events.some((e) => e.kind === "adversarial-approved"),
      "#486 W1: recovered verdict → aggregate adversarial-approved (no handoff)",
    );
    // #486 W1 — the gate itself emitted no cap-hit: the transient was
    // absorbed in-step. Scoped to the gate's caps on purpose — this test
    // repo is not a git tree, so the driver's mechanized commit-pr fails
    // downstream and parks with `step-failed:commit-pr` (a test artifact
    // of the mocked environment, not a gate verdict).
    assert(
      !events.some(
        (e) =>
          e.kind === "cap-hit" &&
          (e.cap === "adversarial-infra-failure" || e.cap === "adversarial-loop"),
      ),
      "#486 W1: no adversarial cap-hit — the transient was absorbed in-step",
    );
    const bOutcomes = events.filter(
      (e) => e.kind === "adversarial-workstream-outcome" && e.workstreamId === "task-b",
    );
    assert(
      bOutcomes.some(
        (e) => e.kind === "adversarial-workstream-outcome" && e.outcome === "approved",
      ),
      "#486 W1: task-b's final outcome recorded as approved",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// W2 (#486) — task-b fails PERMANENTLY (infra failure on every attempt,
// budget exhausted). task-a/task-c APPROVED verdicts must be preserved in
// the state file, and the cycle parks with the distinct infra cap — never
// an adversarial-rejected.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-486-w2-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const s = advFanoutState(959, dir, ["task-a", "task-b", "task-c"]);
    await writeState(dir, s);

    const calls: Record<string, number> = { "task-a": 0, "task-b": 0, "task-c": 0 };
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 959,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "?";
        calls[id] = (calls[id] ?? 0) + 1;
        if (id === "task-b") {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: round 1 fix dispatch provider/transport error: Connection error.. No verdict was produced — this is NOT a review rejection.",
            roundsExecuted: 1,
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
      dispatchFn: async (_pi, spec, opts) =>
        opts?.label === "ops:handoff"
          ? mkResult({ role: "ops", text: "Posted." })
          : Promise.reject(new Error(`unexpected: ${spec.role}`)),
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 959);
    const events = after?.eventLog ?? [];
    assert(
      calls["task-b"] === 3,
      `#486 W2: permanent failure attempted 3× (initial + 2 retries; got ${calls["task-b"]})`,
    );
    assert(
      calls["task-a"] === 1 && calls["task-c"] === 1,
      "#486 W2: approved siblings never re-run",
    );
    const out = (id: string) =>
      events
        .filter((e) => e.kind === "adversarial-workstream-outcome" && e.workstreamId === id)
        .pop();
    assert(
      out("task-a")?.kind === "adversarial-workstream-outcome" &&
        out("task-a").outcome === "approved",
      "#486 W2: task-a's APPROVED verdict preserved in the state file",
    );
    assert(
      out("task-c")?.kind === "adversarial-workstream-outcome" &&
        out("task-c").outcome === "approved",
      "#486 W2: task-c's APPROVED verdict preserved in the state file",
    );
    assert(
      out("task-b")?.kind === "adversarial-workstream-outcome" &&
        out("task-b").outcome === "infra-failure",
      "#486 W2: task-b recorded as infra-failure, NOT rejected",
    );
    const rejected = events.filter((e) => e.kind === "adversarial-rejected");
    assert(
      rejected.length === 0,
      "#486 W2: NO adversarial-rejected — a permanent infra failure is not a review rejection",
    );
    const cap = [...events].reverse().find((e) => e.kind === "cap-hit");
    assert(
      cap?.kind === "cap-hit" &&
        cap.cap === "adversarial-infra-failure" &&
        cap.nextStep === "handoff",
      `#486 W2: parked with cap='adversarial-infra-failure' (got ${cap?.kind === "cap-hit" ? cap.cap : "no cap-hit"})`,
    );
    assert(after?.pipelineState.status === "handoff", "#486 W2: cycle routes to handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// W3 (#486) — permanent infra failure in task-b plus a GENUINE rejection in
// task-a. The two verdicts must stay distinct: task-a's real objection is
// reported under cap 'adversarial-loop' (the rejection path), task-b's
// infra shortfall is never dressed up as a rejection, and task-c's
// approval survives in the state file.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-486-w3-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const s = advFanoutState(960, dir, ["task-a", "task-b", "task-c"]);
    await writeState(dir, s);

    const calls: Record<string, number> = { "task-a": 0, "task-b": 0, "task-c": 0 };
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 960,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "?";
        calls[id] = (calls[id] ?? 0) + 1;
        if (id === "task-a") {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "rejected",
            text: "❌ Adversarial REJECTED after 3 rounds. Last verdict: CRITICAL_ISSUES_FOUND\n\nreal findings: task-a ships an unhandled error path",
            adversarialRounds: [
              { round: 1, status: "CRITICAL_ISSUES_FOUND", verdictParsed: true },
              { round: 2, status: "CRITICAL_ISSUES_FOUND", verdictParsed: true },
              { round: 3, status: "CRITICAL_ISSUES_FOUND", verdictParsed: true },
            ],
          });
        }
        if (id === "task-b") {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: round 1 fix dispatch provider/transport error: Connection error.. No verdict was produced — this is NOT a review rejection.",
            roundsExecuted: 1,
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
      dispatchFn: async (_pi, spec, opts) =>
        opts?.label === "ops:handoff"
          ? mkResult({ role: "ops", text: "Posted." })
          : Promise.reject(new Error(`unexpected: ${spec.role}`)),
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 960);
    const events = after?.eventLog ?? [];
    const rejected = events.filter((e) => e.kind === "adversarial-rejected");
    assert(rejected.length === 1, "#486 W3: exactly one aggregate rejection (the genuine one)");
    assert(
      rejected[0]?.kind === "adversarial-rejected" &&
        rejected[0].findings.includes("[workstream task-a]") &&
        rejected[0].findings.includes("unhandled error path"),
      "#486 W3: the genuine rejection's findings are preserved",
    );
    assert(
      rejected[0]?.kind === "adversarial-rejected" &&
        !rejected[0].findings.includes("[workstream task-b]"),
      "#486 W3: task-b's infra shortfall is NOT tagged as a rejection workstream",
    );
    assert(
      rejected[0]?.kind === "adversarial-rejected" &&
        rejected[0].findings.includes("(never produced a verdict"),
      "#486 W3: task-b's shortfall is named explicitly (no verdict, NOT a rejection)",
    );
    const bOutcomes = events.filter(
      (e) => e.kind === "adversarial-workstream-outcome" && e.workstreamId === "task-b",
    );
    assert(
      bOutcomes.every(
        (e) => e.kind === "adversarial-workstream-outcome" && e.outcome === "infra-failure",
      ),
      "#486 W3: task-b's outcome stays infra-failure in the state file",
    );
    const cOut = events
      .filter((e) => e.kind === "adversarial-workstream-outcome" && e.workstreamId === "task-c")
      .pop();
    assert(
      cOut?.kind === "adversarial-workstream-outcome" && cOut.outcome === "approved",
      "#486 W3: task-c's approval preserved",
    );
    const cap = [...events].reverse().find((e) => e.kind === "cap-hit");
    assert(
      cap?.kind === "cap-hit" && cap.cap === "adversarial-loop" && cap.nextStep === "handoff",
      "#486 W3: genuine rejection still parks via cap 'adversarial-loop'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
