#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: Issue #305 sections 48b/49: adversarial receives lens-fix diff before commit + N>1 workstream lens-fix commit.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import { mkLensSummary, setupSpawnGuard } from "./test-helpers.ts";

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

setupSpawnGuard();

// 48b. Issue #305 — adversarial receives lens-fix diff BEFORE commit.
//
// Proves the fix: commit AFTER adversarial-approved (changed in this PR)
// means adversarial reads the working-tree diff (git diff HEAD) which
// contains the uncommitted lens-fix changes. If commit happened BEFORE
// adversarial (bug #305 original state), the tree would be clean at
// adversarial review time and params.diff would be empty — this test
// would FAIL, exposing the defect.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-fix-adversarial-diff-"));
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
    await execp("git checkout -qb feature/lens-adversarial-diff", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "const x = eval(input);\n");
    await execp("git add feature.txt && git commit -q -m 'feature with bug'", {
      cwd: dir,
      shell: "/bin/bash",
    });

    // Pre-seed at lens-fix step with a lens-issues-found event.
    let s = initialState(309, 1_000_000);
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
        branchName: "feature/lens-adversarial-diff",
        prNumber: 3090,
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
              suggestion: "Replace with safeParse(input)",
            },
          ]),
          verdict: "ISSUES_FOUND" as const,
        },
      ],
    };
    await writeState(dir, s);

    // Capture the diff passed to adversarialLoopFn.
    const capturedDiffs: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 309,
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
      adversarialLoopFn: async (params) => {
        // Capture the diff BEFORE the commit happens.
        capturedDiffs.push(params.diff);
        // APPROVE the fix.
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED.",
        });
      },
      lensReviewFn: async () => {
        return mkLensSummary({ verdict: "APPROVED" });
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    // Verify adversarial received a diff containing the fix.
    assert(
      capturedDiffs.length === 1,
      `adversarialLoopFn called once (got ${capturedDiffs.length})`,
    );
    assert(
      capturedDiffs.some((d) => d.includes("safeParse")),
      "adversarial diff contains the lens-fix changes (uncommitted before review)",
    );
    assert(
      capturedDiffs[0].includes("-const x = eval(input);"),
      "adversarial diff shows the removed unsafe eval line",
    );
    assert(
      capturedDiffs[0].includes("+const x = safeParse(input);"),
      "adversarial diff shows the added safeParse line",
    );

    // Verify the driver still committed after adversarial approved.
    const { stdout: log } = await execp("git log --format=%s -1", { cwd: dir });
    assert(log.includes("fix(lens)"), `commit message references lens-fix (got: ${log.trim()})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 49. Issue #305 — lens-fix commit happens for N>1 workstreams.
//
// Bug #305 original commit had a guard `&& ids.length === 1` that
// prevented lens-fix commits on multi-workstream (N>1) cycles.
// This test verifies the fix by seeding THREE workstreams at lens-fix.
// The lens-fix dispatch modifies a file at repoRoot (after consolidation),
// and after adversarial approves, the driver commits at repoRoot.
// The test FAILS if the `ids.length === 1` guard is restored.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-fix-n3-"));
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
    await execp("git checkout -qb feature/lens-fix-n3", { cwd: dir });
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

    // Pre-seed at lens-fix step with THREE workstreams and a lens-issues-found event.
    let s = initialState(310, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "commit-pr",
        worktrees: { ws1: dir, ws2: dir, ws3: dir },
        workstreams: {
          ws1: { id: "ws1", scope: "test", paths: ["feature.txt"], outOfScope: [] },
          ws2: { id: "ws2", scope: "test", paths: ["other.txt"], outOfScope: [] },
          ws3: { id: "ws3", scope: "test", paths: ["third.txt"], outOfScope: [] },
        },
        branchName: "feature/lens-fix-n3",
        prNumber: 3100,
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
      issue: 310,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // lens-fix dispatch: make a change in the working tree at repoRoot.
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
      lensReviewFn: async () => {
        return mkLensSummary({ verdict: "APPROVED" });
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 310);
    const events = after?.eventLog ?? [];

    // Verify the lens-fix dispatch happened.
    const lensFixCompleted = events.find(
      (e) => e.kind === "dispatch-completed" && e.step === "lens-fix",
    );
    assert(
      lensFixCompleted !== undefined && lensFixCompleted.ok,
      "lens-fix dispatch completed successfully",
    );

    // Verify the driver committed (extra commit after lens-fix) at repoRoot.
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
    // fix during runAdversarial before advancing, so the committed diff
    // contains the repair even though the cycle ends at handoff.
    assert(
      after?.pipelineStatus !== "running",
      "cycle has exited the running loop (advanced past lens-fix)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
