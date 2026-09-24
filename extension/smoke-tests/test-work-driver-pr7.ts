#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 29-32: PR7 branches-converged ALL-FAILED halt, partial failure handoff, explainCap fanout, handoff per-workstream verdicts.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { appendEvent, initialState, readState, writeState } from "../src/workflow-state.ts";

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

// 29. PR7 — runWorkDriver halts on branches-converged ALL-FAILED.
// Empirical /work 553 2026-06-24: all 3 develop workstreams provider-errored
// mid-stream; pre-PR7 the driver advanced into adversarial APPROVAL of an
// empty diff. After PR7, branches-converged with any ok:false → halt.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-bc-allfail-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(900, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
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
        branchName: "feature/issue-900-multi",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 900,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // All 3 developer dispatches return ok:false (provider-error shape).
        if (spec.role === "developer") {
          return mkResult({ role: "developer", ok: false, exitCode: 1, text: "" });
        }
        // Speculative explores (PR3 fanout) — ok so the develop converge
        // settles on the developer leg failures.
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "mock" });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 900);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(kinds.includes("branches-converged"), "branches-converged emitted");
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:develop",
      "all-failed: synthesises cap='step-failed:develop' (PR7 router intercepts)",
    );
    const advLabels = seenLabels.filter((l) => l.startsWith("adversarial"));
    assert(
      advLabels.length === 0,
      `all-failed: NO adversarial dispatch after branches-converged (the /work 553 cascade prevented; got: ${advLabels.join(",") || "none"})`,
    );
    assert(
      seenLabels.includes("ops:handoff"),
      "all-failed: handoff DID run (ops:handoff dispatch fired)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 30. PR7 — partial failure (1-of-3 branches failed) also routes to handoff.
// /work doctrine: ANY failed branch halts; out-of-scope-fence design implies
// a failed branch leaves the decomposition incoherent.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-bc-partial-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(901, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
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
        branchName: "feature/issue-901-partial",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 901,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (spec.role === "developer") {
          // task-b fails; task-a and task-c succeed.
          if (opts?.label === "developer[task-b]") {
            return mkResult({ role: "developer", ok: false, exitCode: 1, text: "" });
          }
          return mkResult({ role: "developer", text: "ok" });
        }
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "mock" });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 901);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:develop",
      "1-of-3 failed: still halts (any-failure routes to handoff)",
    );
    const advLabels = seenLabels.filter((l) => l.startsWith("adversarial"));
    assert(
      advLabels.length === 0,
      "1-of-3 failed: NO adversarial dispatch (partial-success ≠ valid input)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 31. PR7 — explainCap fanout parenthetical for multi-workstream halts.
// Uses the most-recent branches-converged event to count failed branches.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      branchName: "feature/issue-553",
    },
  };
  s = appendEvent(s, {
    kind: "branches-converged",
    step: "develop",
    verdicts: [
      { id: "task-a", ok: false },
      { id: "task-b", ok: false },
      { id: "task-c", ok: false },
    ],
    at: 1_000_500,
  });
  const sentence = explainCap("step-failed:develop", s);
  assert(
    sentence.includes("3/3 workstream branches failed"),
    `explainCap step-failed:develop surfaces fanout count (got: "${sentence}")`,
  );

  // No develop branches-converged (and no branch-completed fanout) → no parenthetical.
  const sNoFanout = initialState(540, 1_000_000);
  (sNoFanout as unknown as { pipelineState: Record<string, unknown> }).pipelineState.branchName =
    "feature/issue-540";
  const sentenceSingle = explainCap("step-failed:develop", sNoFanout);
  assert(
    !sentenceSingle.includes("workstream branches"),
    "explainCap step-failed:develop OMITS fanout text when no branches-converged event present",
  );
}

// 32. PR7 — renderHandoffUserMessage surfaces per-workstream verdicts
// when the cap-hit was multi-workstream (mirrors renderHandoffMarkdown).
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "aborted",
      branchName: "feature/issue-553",
    },
  };
  s = appendEvent(
    s,
    {
      kind: "branches-converged",
      step: "develop",
      verdicts: [
        { id: "task-a", ok: false },
        { id: "task-b", ok: false },
        { id: "task-c", ok: false },
      ],
      at: 1_000_400,
    },
    {
      kind: "cap-hit",
      at: 1_000_500,
      cap: "step-failed:develop",
      reviewRound: 0,
      nextStep: "handoff",
    },
    {
      kind: "handoff-emitted",
      at: 1_000_600,
      commentUrl: "https://github.com/x/y/issues/553#comment-1",
      labelApplied: true,
      handoffBodyPath: "/tmp/issue-553/handoff-comment.md",
    },
  );
  const msg = renderHandoffUserMessage(s, "/repo/nessie", "/repo/nessie/tmp/issue-553");
  assert(
    msg.includes("Workstream verdicts (develop fanout, 0/3 ok)"),
    "renderHandoffUserMessage: surfaces multi-workstream verdicts header with ratio",
  );
  assert(
    msg.includes("task-a: FAIL") && msg.includes("task-b: FAIL") && msg.includes("task-c: FAIL"),
    "renderHandoffUserMessage: lists each workstream's FAIL/ok verdict",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
