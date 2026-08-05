#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 33-34: PR8 runAdversarial per-workstream fanout + parseAdversarialRounds.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
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

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// #286 — this test exercises PR8 per-workstream fanout (adversarial loop
// verdicts) and does not set up real git diffs. Disable the empty-diff
// skip so the loop runs as intended.
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// 33. PR8 — runAdversarial fans out per-workstream for N>1 (instead of
// reviewing a fragmented `## workstream:` merged diff). Empirical /work
// 553 2026-06-24: pre-PR8 single-shot adversarial on merged fanout
// flagged phantom CRITICALs from cross-workstream merge artifacts and
// fix-loop fragmented state by dispatching into one cwd only.
//
// This test mocks ctx.adversarialLoopFn so we can verify:
//   - one loop call per workstream (N parallel, each in its own cwd)
//   - all-approved → adversarial-approved → routes to commit-pr
//   - any-rejected → adversarial-rejected + cap-hit → routes to handoff
{
  // 33a — all 3 workstreams APPROVED → aggregate adversarial-approved.
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-fanout-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(910, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
          "task-c": { id: "task-c", scope: "c", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-910",
      },
    };
    await writeState(dir, s);

    const seenWorkCwds: string[] = [];
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 910,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        seenWorkCwds.push(params.workCwd ?? "<no cwd>");
        // APPROVED on round 1 for all three.
        return mkResult({
          role: "adversarial-developer",
          ok: true,
          text: "Adversarial APPROVED after round 1.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // commit-pr ops returns a PR number so the cycle can advance into
        // lens-review territory; we throw there to halt the test bounded.
        if (opts?.label === "ops:commit-pr") {
          return mkResult({ role: "ops", text: "Done.\npr: 5101\n" });
        }
        throw new Error(`unexpected dispatch (halting test): ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 910);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      seenWorkCwds.length === 3,
      `33a all-approved: 3 adversarialLoopFn calls (one per workstream); got ${seenWorkCwds.length}`,
    );
    assert(
      seenWorkCwds.includes(`${dir}/.worktrees/task-a`) &&
        seenWorkCwds.includes(`${dir}/.worktrees/task-b`) &&
        seenWorkCwds.includes(`${dir}/.worktrees/task-c`),
      "33a all-approved: each adversarial loop runs in its own worktree's cwd (no shared cwd)",
    );
    const advBranchEvents = (after?.eventLog ?? []).filter(
      (e) => e.kind === "branch-completed" && e.step === "adversarial",
    );
    assert(
      advBranchEvents.length === 3 &&
        advBranchEvents.every((e) => e.kind === "branch-completed" && e.ok),
      "33a all-approved: 3 branch-completed events for adversarial, all ok",
    );
    assert(
      kinds.includes("branches-converged"),
      "33a all-approved: branches-converged emitted for adversarial fanout",
    );
    assert(
      kinds.filter((k) => k === "adversarial-approved").length === 1,
      "33a all-approved: exactly one synthesised adversarial-approved aggregate event",
    );
    // The fanout-approve cycle should route forward to commit-pr.
    assert(
      seenLabels.includes("ops:commit-pr"),
      "33a all-approved: cycle advanced to commit-pr (aggregate APPROVED → nextStep=commit-pr)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 33b — 1 of 3 workstreams REJECTED → aggregate adversarial-rejected
  // + cap-hit('adversarial-loop') → cycle routes to handoff.
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-fanout-rej-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(911, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
          "task-c": { id: "task-c", scope: "c", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-911",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 911,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        // task-b's workCwd → REJECTED after 3 rounds. Others APPROVED.
        if (params.workCwd?.endsWith("task-b")) {
          return mkResult({
            role: "adversarial-developer",
            ok: false,
            text:
              "Adversarial REJECTED after round 3.\n" +
              "Findings: still has the same critical issue.\n",
          });
        }
        return mkResult({
          role: "adversarial-developer",
          ok: true,
          text: "Adversarial APPROVED after round 1.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 911);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(kinds.includes("branches-converged"), "33b mixed: branches-converged emitted");
    const advRejected = (after?.eventLog ?? []).filter((e) => e.kind === "adversarial-rejected");
    assert(
      advRejected.length === 1,
      "33b mixed: exactly one synthesised adversarial-rejected aggregate event",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "adversarial-loop",
      "33b mixed: cap='adversarial-loop' synthesised after any-rejection",
    );
    assert(
      after?.pipelineState.status === "handoff",
      "33b mixed: cycle terminates at handoff (per cap-hit nextStep)",
    );
    // Rejection findings should preserve per-workstream provenance so the
    // handoff renderer can tell the operator WHICH workstream failed.
    const rej = advRejected[0];
    assert(
      rej?.kind === "adversarial-rejected" && rej.findings.includes("[workstream task-b]"),
      "33b mixed: aggregate findings tag the rejected workstream's slice",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 34. PR8 — parseAdversarialRounds helper covers all 3 marker shapes
// (the per-workstream max-rounds aggregation depends on this).
//
// (Helper isn't exported, so test via the synthesised adversarial-approved
// rounds field — exercise round 1/2/3 paths individually via mocked loops.)
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-rounds-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(912, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-912",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 912,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        // task-a APPROVED in 1 round; task-b APPROVED in 2 rounds.
        // Aggregate rounds should be max = 2.
        if (params.workCwd?.endsWith("task-a")) {
          return mkResult({
            role: "adversarial-developer",
            ok: true,
            text: "Adversarial APPROVED after round 1.\n",
          });
        }
        return mkResult({
          role: "adversarial-developer",
          ok: true,
          text: "Adversarial APPROVED after round 2.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:commit-pr") {
          return mkResult({ role: "ops", text: "Done.\npr: 5102\n" });
        }
        throw new Error(`halting after commit-pr: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 912);
    const approved = (after?.eventLog ?? []).find((e) => e.kind === "adversarial-approved");
    assert(
      approved?.kind === "adversarial-approved" && approved.rounds === 2,
      `aggregate rounds = max(per-workstream) = 2 (got: ${approved?.kind === "adversarial-approved" ? approved.rounds : "missing"})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
