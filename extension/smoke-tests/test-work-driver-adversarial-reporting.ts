#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of
 * test-work-driver-adversarial-retry.ts (500-line cap).
 *
 * Covers: #485 — infra failure records rounds/verdicts as data, never as
 * "all rejected" (per-round verdict persistence, outcome reporting).
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// PR11 — default issue-body fetcher for tests. runExplore's empty-body
// halt guard (PR11 §C) would otherwise fire when execp("gh issue view N")
// rejects or returns empty stdout — true for almost every test (the test
// repos don't have GitHub remotes). Tests that deliberately exercise
// the empty-body path pass their own injection; everything else gets
// this stub so the cycle proceeds to plan/branch/develop normally.
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

// #297 — zero the inter-attempt backoff so persistent-failure tests don't
// sleep 5-10s per retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// #286 — these tests exercise adversarial loop verdicts and do not set up
// real git diffs. Disable the empty-diff skip so the loop runs as intended.
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// Offline-suite safety net: cap any accidental live spawn at 2s so the
// suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// ============================================================================
// #485 — infra failure records rounds/verdicts as data, never as "all rejected"
// ============================================================================

// R1 (#485) — the #478 incident: round 1's fix dispatch dies on a provider
// error. The state file must record 1 executed round with the round-1
// verdict, outcome infra-failure, and NO adversarial-rejected event whose
// findings claim a rejection the loop explicitly disavowed.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-485-r1-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(956, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
        branchName: "feature/issue-956",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 956,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: false,
          exitCode: 1,
          loopOutcome: "infra-failure",
          text: "Adversarial loop infrastructure failure: round 1 fix dispatch provider/transport error: Connection error.. No verdict was produced — this is NOT a review rejection.",
          // The real loop threads its own round table (#485); the driver
          // must prefer it over any prose parsing.
          adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: true }],
          roundsExecuted: 1,
        }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 956);
    const events = after?.eventLog ?? [];
    const rejected = events.filter((e) => e.kind === "adversarial-rejected");
    assert(
      rejected.length === 0,
      "#485 R1: infra failure records NO adversarial-rejected (nothing was rejected)",
    );
    const rounds = events.filter((e) => e.kind === "adversarial-round");
    assert(
      rounds.length === 1 &&
        rounds[0]?.kind === "adversarial-round" &&
        rounds[0].round === 1 &&
        rounds[0].status === "ISSUES_FOUND" &&
        rounds[0].verdictParsed === true,
      `#485 R1: the one executed round is recorded with its actual verdict (got ${JSON.stringify(rounds)})`,
    );
    // #486 two-state design: `adversarial` is RETRY_ONCE-class.
    //  - FIRST pass (this test): the step-level router
    //    (work-driver-step-router.ts) re-runs the step while the budget
    //    holds, so the adversarial step leaves a `dispatch-failed` event
    //    and NO cap-hit — nothing claims the gate rejected. (The overall
    //    event-log tail is `handoff-emitted`: the driver's own
    //    mechanized commit-pr path fails in this test's non-git tmp dir
    //    and parks at commit-pr — downstream of the gate this test pins.)
    //  - Re-entry (the router hands it back): the failure is permanent.
    //    runAdversarial parks with the DISTINCT cap
    //    `adversarial-infra-failure` (#486 requires a permanent failure
    //    to be NAMED rather than left looking like a bare dispatch
    //    failure).
    // The assertion is scoped to the gate: a dispatch-failed for the
    // adversarial step exists in the log, and no adversarial cap-hit or
    // rejection overrode it.
    const advDispatchFailed = events.find(
      (e) =>
        (e.kind === "dispatch-failed" || e.kind === "dispatch-failed-provider") &&
        e.step === "adversarial",
    );
    const rejected2 = events.filter((e) => e.kind === "adversarial-rejected");
    const advCap = events.find(
      (e) =>
        e.kind === "cap-hit" &&
        (e.cap === "adversarial-infra-failure" || e.cap === "adversarial-loop"),
    );
    assert(
      advDispatchFailed !== undefined &&
        (advDispatchFailed.kind === "dispatch-failed" ||
          advDispatchFailed.kind === "dispatch-failed-provider") &&
        advDispatchFailed.step === "adversarial" &&
        rejected2.length === 0 &&
        advCap === undefined,
      "#485 R1: the adversarial gate leaves a dispatch-failed (the RETRY_ONCE path) and no adversarial cap-hit or rejection",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// R2 (#485) — a normal 2-round loop (ISSUES_FOUND in round 1, APPROVED in
// round 2) records BOTH rounds' verdict tokens in the event log, so the
// gate is auditable from the state file without reading a transcript.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-485-r2-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(957, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
        branchName: "feature/issue-957",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 957,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 2.\n",
          adversarialRounds: [
            { round: 1, status: "ISSUES_FOUND", verdictParsed: true },
            { round: 2, status: "APPROVED", verdictParsed: true },
          ],
        }),
      dispatchFn: async (_pi, spec, opts) => {
        throw new Error(`halting after adversarial: ${spec.role}/${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 957);
    const events = after?.eventLog ?? [];
    const rounds = events.filter((e) => e.kind === "adversarial-round");
    assert(
      rounds.length === 2,
      `#485 R2: both rounds' verdicts recorded in the event log (got ${rounds.length})`,
    );
    const seq = rounds
      .filter(
        (e): e is Extract<(typeof events)[number], { kind: "adversarial-round" }> =>
          e.kind === "adversarial-round",
      )
      .map((e) => `${e.round}:${e.status}`)
      .join(", ");
    assert(
      seq === "1:ISSUES_FOUND, 2:APPROVED",
      `#485 R2: per-round verdicts survive verbatim (got: ${seq || "none"})`,
    );
    const approved = events.find((e) => e.kind === "adversarial-approved");
    assert(
      approved?.kind === "adversarial-approved" && approved.rounds === 2,
      "#485 R2: aggregate rounds = 2 (the count the loop reported, not a guess)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
