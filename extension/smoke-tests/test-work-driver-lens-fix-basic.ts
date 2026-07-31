#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: Issue #305 sections 46/46b: driver commits after successful lens-fix + committed diff visible to next round.
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

// 46. Issue #305 — driver commits after a successful lens-fix.
//
// Pre-seed the cycle at lens-fix with a lens-issues-found event.
// The lens-fix dispatch makes changes in the working tree.
// After the dispatch, the driver commits and pushes.
// This bridges the gap between runLensFix (edits working tree) and
// runLens (reads committed state via `git diff origin/<base>..HEAD`).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-fix-commit-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // Real git repo with a committed feature branch.
    await execp("git init -q", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: dir,
      shell: "/bin/bash",
    });
    await fs.writeFile(path.join(dir, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp("git checkout -qb feature/lens-fix-test", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "const x = eval(input);\n");
    await execp("git add feature.txt && git commit -q -m 'feature with bug'", {
      cwd: dir,
      shell: "/bin/bash",
    });

    // Record commit count before lens-fix.
    const { stdout: beforeLog } = await execp("git rev-list --count origin/main..HEAD", {
      cwd: dir,
    });
    const beforeCount = Number.parseInt(beforeLog.trim(), 10);

    // Pre-seed at lens-fix step with a lens-issues-found event.
    let s = initialState(305, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "commit-pr",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/lens-fix-test",
        prNumber: 3050,
        reviewRound: 1,
      },
      eventLog: [
        {
          kind: "lens-issues-found" as const,
          at: 2_000_000,
          jobId: "j-lens-1",
          round: 1,
          findings: JSON.stringify([
            {
              lens: "SECURITY",
              severity: "MEDIUM",
              path: "feature.txt",
              line: 1,
              title: "eval() usage",
              description: "Use of eval is unsafe",
              suggestion: "Replace with safe alternative",
            },
          ]),
          verdict: "ISSUES_FOUND" as const,
        },
      ],
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 305,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // lens-fix dispatch: make a change in the working tree.
        if (opts?.label?.startsWith("developer:lens-fix")) {
          await fs.writeFile(path.join(dir, "feature.txt"), "const x = safeParse(input);\n");
          return mkResult({
            role: "developer",
            ok: true,
            text: "Fixed the eval usage.",
          });
        }

        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }

        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () => {
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED.",
        });
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 305);
    const events = after?.eventLog ?? [];

    // Verify the lens-fix dispatch happened.
    const lensFixCompleted = events.find(
      (e) => e.kind === "dispatch-completed" && e.step === "lens-fix",
    );
    assert(
      lensFixCompleted !== undefined && lensFixCompleted.ok,
      "lens-fix dispatch completed successfully",
    );

    // Verify the driver committed (extra commit after lens-fix).
    const { stdout: afterLog } = await execp("git rev-list --count origin/main..HEAD", {
      cwd: dir,
    });
    const afterCount = Number.parseInt(afterLog.trim(), 10);
    assert(
      afterCount === beforeCount + 1,
      `driver committed the lens-fix (before=${beforeCount}, after=${afterCount})`,
    );

    // Verify the commit message contains the lens-fix marker.
    const { stdout: log } = await execp("git log --format=%s -1", { cwd: dir });
    assert(log.includes("fix(lens)"), `commit message references lens-fix (got: ${log.trim()})`);

    // Verify the committed diff contains the fix.
    const { stdout: diff } = await execp("git diff origin/main..HEAD", { cwd: dir });
    assert(diff.includes("safeParse"), "committed diff contains the fix from lens-fix");

    // Cycle advances past lens-fix to adversarial (which fails without
    // adversarialLoopFn injected) → handoff. The driver committed the
    // fix during runLensFix before advancing, so the committed diff
    // contains the repair even though the cycle ends at handoff.
    assert(
      after?.pipelineStatus !== "running",
      "cycle has exited the running loop (advanced past lens-fix)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 46b. Issue #305 — committed diff after lens-fix is visible to next round.
//
// Verifies that the lens-fix commit produces a diff (via
// `git diff origin/main..HEAD`) that contains the fix, confirming the
// committed state that runLens would read for round 2. Does not
// exercise the full lens-review dispatch (runLensReview spawns real
// Pi children outside the mock dispatchFn).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-converge-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // Real git repo.
    await execp("git init -q", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: dir,
      shell: "/bin/bash",
    });
    await fs.writeFile(path.join(dir, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp("git checkout -qb feature/lens-converge", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "const x = eval(input);\n");
    await execp("git add feature.txt && git commit -q -m 'feature with bug'", {
      cwd: dir,
      shell: "/bin/bash",
    });

    // Pre-seed at lens-fix.
    let s = initialState(307, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "commit-pr",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/lens-converge",
        prNumber: 3070,
        reviewRound: 1,
      },
      eventLog: [
        {
          kind: "lens-issues-found" as const,
          at: 2_000_000,
          jobId: "j-lens-1",
          round: 1,
          findings: JSON.stringify([
            {
              lens: "SECURITY",
              severity: "MEDIUM",
              path: "feature.txt",
              line: 1,
              title: "eval() usage",
              description: "Unsafe eval",
              suggestion: "Replace with safe alternative",
            },
          ]),
          verdict: "ISSUES_FOUND" as const,
        },
      ],
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 307,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // lens-fix dispatch: fix the file.
        if (opts?.label?.startsWith("developer:lens-fix")) {
          await fs.writeFile(path.join(dir, "feature.txt"), "const x = safeParse(input);\n");
          return mkResult({
            role: "developer",
            ok: true,
            text: "Fixed.",
          });
        }

        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }

        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () => {
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED.",
        });
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    // After lens-fix → commit → adversarial-approved → nextStep = lens-review.
    // The committed diff should contain the fix — this is the input
    // runLens would read for round 2. Full lens-review dispatch is not
    // exercised here (runLensReview spawns real Pi children, not mocked).
    const { stdout: diff } = await execp("git diff origin/main..HEAD", { cwd: dir });
    assert(
      diff.includes("safeParse"),
      "committed diff contains the fix (input for next lens round)",
    );

    // The commit count should be 2 (original feature + lens-fix commit).
    const { stdout: logCount } = await execp("git rev-list --count origin/main..HEAD", {
      cwd: dir,
    });
    assert(Number.parseInt(logCount.trim(), 10) === 2, "exactly 2 commits (feature + lens-fix)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
