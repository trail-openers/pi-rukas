#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: #296/#297 T1-T4: transient-failure retry on HALT steps, budget exhaustion, escape hatch, killCause self-kill errorTail.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext } from "../src/work-driver-context.ts";
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

// ============================================================================
// #297 — transient-failure retry on HALT steps
// ============================================================================

// T1 (#297) — a single provider error-stop on the branch step (HALT class)
// retries and the cycle proceeds instead of aborting.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-transient-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(950, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "branch",
        lastCompletedStep: "plan",
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
      },
    };
    await writeState(dir, s);

    let branchAttempts = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 950,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "ops" && opts?.label !== "ops:handoff") {
          branchAttempts += 1;
          if (branchAttempts === 1) {
            // Transient: provider error-stop (the "Request timed out." shape).
            return mkResult({
              role: "ops",
              ok: false,
              exitCode: 0,
              text: "",
              errorStop: { reason: "error", message: "Request timed out." },
            });
          }
          return mkResult({
            role: "ops",
            text: "branch: feature/issue-950-transient-test\nworktrees:\n  default: " + dir,
          });
        }
        // Halt cleanly once develop dispatches (out of scope for this test).
        throw new Error("smoke: halting at develop");
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 950);
    assert(
      branchAttempts === 2,
      `#297 T1: branch re-dispatched after transient (got ${branchAttempts})`,
    );
    // (The develop-halt throw above produces its own step-failed:develop
    // cap-hit — only the BRANCH step must be cap-free here.)
    assert(
      !(after?.eventLog ?? []).some((e) => e.kind === "cap-hit" && e.cap === "step-failed:branch"),
      "#297 T1: no step-failed:branch cap-hit — transient did not abort the branch step",
    );
    assert(
      (after?.eventLog ?? []).some((e) => e.kind === "step-started" && e.step === "develop"),
      "#297 T1: cycle advanced past branch to develop",
    );
    assert(
      (after?.pipelineState.transientRetryAttempts?.branch ?? 0) === 0,
      "#297 T1: transient budget reset after the step succeeded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T2 (#297) — budget exhaustion: persistent transient failures (1 + 2
// retries) fall through to the HALT cap-hit → handoff.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-transient-exhaust-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(951, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "branch",
        lastCompletedStep: "plan",
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
      },
    };
    await writeState(dir, s);

    let branchAttempts = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 951,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") {
          branchAttempts += 1;
          return mkResult({
            role: "ops",
            ok: false,
            exitCode: 0,
            text: "",
            errorStop: { reason: "error", message: "terminated" },
          });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 951);
    assert(
      branchAttempts === 3,
      `#297 T2: 1 attempt + 2 transient retries before halt (got ${branchAttempts})`,
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:branch",
      "#297 T2: exhausted budget routes through cap-hit step-failed:branch",
    );
    assert(after?.pipelineState.status === "aborted", "#297 T2: cycle ends aborted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T3 (#297) — escape hatch: PI_ENSEMBLE_TRANSIENT_RETRY=0 restores
// halt-on-first-failure.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-transient-off-"));
  const prev = process.env.PI_ENSEMBLE_TRANSIENT_RETRY;
  process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(952, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "branch",
        lastCompletedStep: "plan",
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
      },
    };
    await writeState(dir, s);

    let branchAttempts = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 952,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") {
          branchAttempts += 1;
          return mkResult({
            role: "ops",
            ok: false,
            exitCode: 0,
            text: "",
            errorStop: { reason: "error", message: "terminated" },
          });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 952);
    assert(branchAttempts === 1, `#297 T3: opt-out → no retry (got ${branchAttempts})`);
    assert(after?.pipelineState.status === "aborted", "#297 T3: opt-out halts immediately");
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_TRANSIENT_RETRY;
    else process.env.PI_ENSEMBLE_TRANSIENT_RETRY = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// T4 (#296) — a killCause-carrying developer result produces an accurate
// self-kill errorTail (never provider blame) and, after transient retries
// exhaust, the developer-timeout cap shape (previously dead code).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-killcause-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(953, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-953-test",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 953,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "developer") {
          return mkResult({
            role: "developer",
            ok: false,
            exitCode: 143,
            text: "partial work text that must NOT become the errorTail",
            killCause: "timeout",
            killBudgetMs: 5_400_000,
          });
        }
        if (spec.role === "explore") return mkResult({ role: "explore", text: "spec ctx" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 953);
    const fail = (after?.eventLog ?? []).find(
      (e) => e.kind === "dispatch-failed" && e.step === "develop",
    );
    assert(
      fail?.kind === "dispatch-failed" &&
        /\[pi-ensemble\] killed after 5400000ms timeout/.test(fail.errorTail ?? ""),
      "#296 T4: kill-cause produces the self-kill errorTail naming the budget",
    );
    assert(
      fail?.kind === "dispatch-failed" &&
        (fail.errorTail ?? "").includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER"),
      "#296 T4: errorTail names the per-role override knob",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "developer-timeout",
      "#296 T4: developer cap kill classifies as cap='developer-timeout'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
