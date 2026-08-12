#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 43-44: PR11 runLens merge-base diff + empty-diff-genuine skip.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
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

// 43. PR11 — runLens uses merge-base diff (origin/<base>..HEAD), not
// `git diff HEAD`. Empirical /work 533+557 (v10r 2026-06-25): pre-PR11
// the empty-diff guard fired POST-commit on every cycle because the
// diff was committed and `git diff HEAD` was empty → lens-review skipped
// in 34 ms → code merged without six-pass review.
//
// This test wires a real git repo with a committed feature branch and a
// simulated origin/main, then runs runWorkDriver at lens-review and
// asserts the empty-diff guard does NOT fire (lens-review attempts to
// dispatch — captured via the dispatchFn throwing).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-postcommit-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // Real git repo: init, commit, branch, commit, simulate origin/main
    // pointing at the initial commit so git diff origin/main..HEAD shows
    // the feature branch's change.
    await execp("git init -q", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: dir,
      shell: "/bin/bash",
    });
    await fs.writeFile(path.join(dir, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
    // Simulate origin/main + origin/HEAD → main without an actual remote.
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp("git checkout -qb feature/pr11-test", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "world\n");
    await execp("git add feature.txt && git commit -q -m 'feature change'", {
      cwd: dir,
      shell: "/bin/bash",
    });

    // Confirm setup: git diff HEAD is empty, git diff origin/main..HEAD has content.
    const diffHead = await execp("git diff HEAD", { cwd: dir });
    const diffMerged = await execp("git diff origin/main..HEAD", { cwd: dir });
    assert(diffHead.stdout.trim() === "", "test setup: git diff HEAD is empty (post-commit)");
    assert(
      diffMerged.stdout.includes("feature.txt"),
      "test setup: git diff origin/main..HEAD shows the merged feature diff",
    );

    // Pre-seed state at lens-review with worktrees.default = dir so
    // runLens fetches the merged diff from this real repo. dispatchFn
    // throws on the lens-review child so we can halt and inspect.
    let s = initialState(820, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "commit-pr",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/pr11-test",
        prNumber: 8200,
      },
    };
    await writeState(dir, s);

    let lensDispatched = false;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 820,
      issueBodyFetcherFn: mockIssueBodyOk,
      lensReviewFn: async () => {
        return mkLensSummary({ verdict: "ISSUES_FOUND", findings: [], totalFindings: 0 });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "code-review-specialist") {
          lensDispatched = true;
          throw new Error("halt-lens-dispatch (test detected runLensReview was reached)");
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 820);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    // Either runLensReview was reached (lensDispatched=true, signalling our
    // halt was hit), OR a lens-review dispatch-completed/failed event
    // appears in the log. Both confirm the empty-diff guard did NOT fire.
    assert(
      lensDispatched || kinds.includes("dispatch-completed") || kinds.includes("dispatch-failed"),
      "PR11 §A: runLens did NOT skip on empty diff post-commit (merge-base fetcher saw the feature diff)",
    );
    assert(
      !kinds.includes("lens-skipped-empty-diff"),
      "PR11 §A: lens-skipped-empty-diff event was NOT emitted (the bug it prevented)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 44. PR11 — runLens still emits lens-skipped-empty-diff for genuinely
// empty cycles (feature branch == origin/main, no commits ahead).
// Regression guard so PR11 §A doesn't lose the PR6 guard's protection.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-empty-real-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

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
    await execp("git checkout -qb feature/pr11-empty", { cwd: dir });
    // No commits on the feature branch → origin/main..origin/<branch> is empty.
    // #384 — the remote ref must EXIST for this to be the genuine-empty case.
    // Without it `git diff origin/main..origin/feature/pr11-empty` fails with
    // "unknown revision", which pre-#384 returned "" and was indistinguishable
    // from empty — so this test was passing by exercising a git FAILURE, not
    // the no-work cycle it claims to cover.
    await execp("git update-ref refs/remotes/origin/feature/pr11-empty HEAD", { cwd: dir });

    let s = initialState(821, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "commit-pr",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/pr11-empty",
        prNumber: 8210,
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 821,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") return mkResult({ role: "ops", text: "CI_STATUS: success" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 821);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("lens-skipped-empty-diff"),
      "PR11 §A regression: lens-skipped-empty-diff still fires when origin/main..HEAD is empty (genuine no-work cycle)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
