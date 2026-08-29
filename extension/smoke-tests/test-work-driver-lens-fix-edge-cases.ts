#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: Issue #305 sections 47/48: no-op lens-fix produces no empty commit + new untracked file gets committed.
 * Plus #492 section 49: a no-op lens-fix's cap-hit carries the "no diff produced" classification,
 * the git evidence that establishes it, and the worktree path it inspected.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
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

// 47. Issue #305 — lens-fix making NO change does NOT produce an empty commit.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-fix-no-change-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // Real git repo with a committed feature branch, plus a separate
    // worktree (so the driver's inWorktree branch is exercised).
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
    await execp("git checkout -qb feature/lens-no-change", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "ok\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: dir,
      shell: "/bin/bash",
    });
    const wt = path.join(dir, ".wt");
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: dir });

    // Record the commit count BEFORE lens-fix.
    const { stdout: beforeLog } = await execp("git rev-list --count origin/main..HEAD", {
      cwd: dir,
    });
    const beforeCount = Number.parseInt(beforeLog.trim(), 10);

    // Pre-seed at lens-fix step.
    let s = initialState(306, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "commit-pr",
        worktrees: { default: wt },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/lens-no-change",
        prNumber: 3060,
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
              lens: "SIMPLICITY",
              severity: "MEDIUM",
              path: "feature.txt",
              line: 1,
              title: "trivial",
              description: "nothing to fix",
              suggestion: "leave as is",
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
      issue: 306,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // lens-fix: do NOT modify any files (simulates developer deciding
        // the finding is a false positive and skipping it).
        if (opts?.label?.startsWith("developer:lens-fix")) {
          return mkResult({
            role: "developer",
            ok: true,
            text: "Reviewed findings — no changes needed.",
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

    // Check that NO extra commit was created.
    const { stdout: afterLog } = await execp("git rev-list --count origin/main..HEAD", {
      cwd: dir,
    });
    const afterCount = Number.parseInt(afterLog.trim(), 10);
    assert(
      afterCount === beforeCount,
      `no empty commit after no-change lens-fix (before=${beforeCount}, after=${afterCount})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 49. Issue #492 — a lens-fix that produces nothing is classified as such.
//
// The `lens-fix-not-integrated` cap used to conflate two causes — "the fixer
// wrote nothing" vs "a diff existed but integration failed" — and the
// handoff told the operator to guess between them. This test drives the
// no-diff half through the real driver: the fixer writes nothing, the
// adversarial gate approves, and the cap-hit that fires must carry the
// no-diff classification, the git evidence that establishes it, and the
// worktree path it inspected.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-no-diff-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // Real git repo: bare origin + worktree (the lens-fix tree) + repoRoot
    // (the integration point, on the feature branch). `.git/info/exclude`
    // keeps the driver's own state file out of integrate()'s dirty preflight
    // — the worktree shares the main repo's .git, so one write covers both.
    const origin = path.join(dir, "origin.git");
    const root = path.join(dir, "root");
    const wt = path.join(dir, "wt");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
    await execp("git init -q --initial-branch=main root", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(dir, "root", ".git", "info", "exclude"), "\n.pi/\n");
    await fs.writeFile(path.join(root, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/lens-no-diff", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "ok\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/lens-no-diff", { cwd: root });
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: root });

    let s = initialState(492, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "commit-pr",
        worktrees: { default: wt },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/lens-no-diff",
        prNumber: 4920,
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
              lens: "SIMPLICITY",
              severity: "MEDIUM",
              path: "feature.txt",
              line: 1,
              title: "trivial",
              description: "nothing to fix",
              suggestion: "leave as is",
            },
          ]),
          verdict: "ISSUES_FOUND" as const,
        },
      ],
    };
    await writeState(root, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: root,
      issue: 492,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // lens-fix: do NOT modify any files (the fixer produced no diff).
        if (opts?.label?.startsWith("developer:lens-fix")) {
          return mkResult({ role: "developer", ok: true, text: "No changes needed." });
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
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };

    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(root, 492);
    const cap = [...(after?.eventLog ?? [])]
      .reverse()
      .find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    assert(cap !== undefined, "a no-diff lens-fix parks with the lens-fix-not-integrated cap");
    if (cap && cap.kind === "cap-hit") {
      assert(
        (cap.evidence ?? "").includes("git status --porcelain") &&
          (cap.evidence ?? "").includes("was empty"),
        `the cap carries the git evidence that the worktree was clean (got: ${cap.evidence})`,
      );
      assert(
        cap.lensWorktreePath === wt,
        `the cap names the worktree it inspected (got: ${cap.lensWorktreePath})`,
      );
      assert(
        (after?.pipelineState.plumbReports ?? []).length === 0,
        "a no-diff outcome is NOT an integration failure — it carries no plumb-report",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 48. Issue #305 — lens-fix creating a NEW (untracked) file is committed.
// Verifies that the explicit porcelain staging (not `git add -u`) picks
// up untracked files. Previously, `git add -u` staged only tracked files
// and silently dropped new files created by the developer.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-new-file-"));
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
    await execp("git checkout -qb feature/lens-new-file", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "const x = eval(input);\n");
    await execp("git add feature.txt && git commit -q -m 'feature with bug'", {
      cwd: dir,
      shell: "/bin/bash",
    });

    // Record the commit count BEFORE lens-fix.
    const { stdout: beforeLog } = await execp("git rev-list --count origin/main..HEAD", {
      cwd: dir,
    });
    const beforeCount = Number.parseInt(beforeLog.trim(), 10);

    // Pre-seed at lens-fix step.
    let s = initialState(308, 1_000_000);
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
        branchName: "feature/lens-new-file",
        prNumber: 3080,
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
              suggestion: "Extract to helper module",
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
      issue: 308,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // lens-fix: create a NEW (untracked) file and modify existing file.
        if (opts?.label?.startsWith("developer:lens-fix")) {
          await fs.writeFile(
            path.join(dir, "safe-helper.ts"),
            "export const safeParse = (x) => JSON.parse(x);\n",
          );
          await fs.writeFile(
            path.join(dir, "feature.txt"),
            "import { safeParse } from './safe-helper';\n",
          );
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
      lensReviewFn: async () => {
        return mkLensSummary({ verdict: "APPROVED" });
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    // Verify the driver committed (extra commit after lens-fix).
    const { stdout: afterLog } = await execp("git rev-list --count origin/main..HEAD", {
      cwd: dir,
    });
    const afterCount = Number.parseInt(afterLog.trim(), 10);
    assert(
      afterCount === beforeCount + 1,
      `driver committed the lens-fix with new file (before=${beforeCount}, after=${afterCount})`,
    );

    // Verify the committed diff includes the NEW file.
    const { stdout: diff } = await execp("git diff origin/main..HEAD", { cwd: dir });
    assert(diff.includes("safeParse"), "committed diff includes new file content");
    assert(diff.includes("safe-helper.ts"), "committed diff references the new file");

    // Verify the new file exists in the committed tree.
    const { stdout: lsFiles } = await execp("git ls-files safe-helper.ts", { cwd: dir });
    assert(lsFiles.trim() === "safe-helper.ts", "new file is tracked in the committed tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
