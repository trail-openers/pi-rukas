#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: Issue #305 sections 48b/49: adversarial receives lens-fix diff before commit + N>1 workstream lens-fix commit.
 * Plus #492 section 49b: when a diff EXISTS but staging fails, the cap-hit
 * carries the integration-failure classification and a plumb-report is surfaced.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { __resetIntegrationLock } from "../src/work-driver-integrate.ts";
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

// A lens-issues-found event (the only event the pre-seeded state needs).
function lensIssuesFoundEvent(title: string, description: string) {
  return {
    kind: "lens-issues-found" as const,
    at: 2_000_000,
    jobId: "j-lens-1",
    round: 1,
    findings: JSON.stringify([{
      lens: "SECURITY", severity: "MEDIUM", path: "feature.txt", line: 1, title, description,
    }]),
    verdict: "ISSUES_FOUND" as const,
  };
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
// Proves the fix: commit AFTER adversarial-approved means adversarial
// reads the working-tree diff (git diff HEAD) which contains the
// uncommitted lens-fix changes. If commit happened BEFORE adversarial
// (bug #305 original state), params.diff would be empty.
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
      eventLog: [lensIssuesFoundEvent("eval() usage", "Use of eval is unsafe")],
    };
    await writeState(dir, s);

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
// Bug #305 original commit had a guard `&& ids.length === 1` that prevented
// lens-fix commits on multi-workstream (N>1) cycles. Seeding THREE
// workstreams at lens-fix, the test FAILS if the guard is restored.
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
      eventLog: [lensIssuesFoundEvent("eval() usage", "Use of eval is unsafe")],
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
    assert(lensFixCompleted?.ok, "lens-fix dispatch completed successfully");

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

// 49b. Issue #492 — a lens-fix whose diff EXISTS but staging fails is
// classified as an integration failure, not as "the fixer wrote nothing".
//
// The two causes require opposite responses: no-diff means the findings
// may be false positives (adjudicate them); an integration failure means a
// structural problem and the fix is still in the worktree. Pre-#492 both
// parked with the same cap and no evidence. Fails `git add` in the worktree
// so staging returns 0 with a diff present.
{
  __resetIntegrationLock();
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-stage-fail-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // Real git repo: bare origin + repoRoot (integration point) + worktree
    // (the lens-fix tree). `.git/info/exclude` keeps the driver's state file
    // out of integrate()'s dirty preflight.
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
    await execp("git remote add origin " + JSON.stringify(origin), { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/lens-stage-fail", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "buggy\n");
    await execp("git add feature.txt && git commit -q -m 'feature with bug'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/lens-stage-fail", { cwd: root });
    await execp("git worktree add --detach " + JSON.stringify(wt) + " HEAD", { cwd: root });

    let s = initialState(493, 1_000_000);
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
        branchName: "feature/lens-stage-fail",
        prNumber: 4930,
        reviewRound: 1,
      },
      eventLog: [lensIssuesFoundEvent("bug", "fix it")],
    };
    await writeState(root, s);

    // The real git executor, with `git add` made to fail inside the
    // worktree — staging returns 0 even though a diff exists.
    const realExec = (async (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) => {
      const r = await execp(cmd, opts);
      return { stdout: r.stdout, stderr: r.stderr };
    }) as (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) => Promise<unknown>;
    const failingExec = (async (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) => {
      if (opts?.cwd === wt && cmd.startsWith("git add")) {
        throw new Error("simulated staging failure (git add refused)");
      }
      return realExec(cmd, opts);
    }) as typeof realExec;

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: root,
      issue: 493,
      issueBodyFetcherFn: mockIssueBodyOk,
      verifyExecFn: failingExec,
      dispatchFn: async (_pi, spec, opts) => {
        // lens-fix: modify a file — the diff EXISTS.
        if (opts?.label?.startsWith("developer:lens-fix")) {
          await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
          return mkResult({ role: "developer", ok: true, text: "Fixed." });
        }
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED.",
        }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };

    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(root, 493);
    const cap = [...(after?.eventLog ?? [])].reverse().find(
      (e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated",
    );
    assert(
      cap !== undefined,
      "a staging-failure lens-fix parks with the lens-fix-not-integrated cap",
    );
    if (cap && cap.kind === "cap-hit") {
      // The classification ("staging or integration failed") lives in the
      // plumb-report; the cap carries the verbatim git error and the
      // inspected worktree. The no-diff classification (a git status
      // reading) must not be used for an integration failure.
      const reports = after?.pipelineState.plumbReports ?? [];
      assert(
        reports.length === 1 &&
          (reports[0].body ?? "").includes("staging or integration failed"),
        "the integration failure is surfaced as a plumb-report (not flattened into the cap only)",
      );
      assert(
        (cap.evidence ?? "").includes("simulated staging failure"),
        `the cap carries the git error verbatim (got: ${cap.evidence})`,
      );
      assert(
        !(cap.evidence ?? "").includes("git status --porcelain"),
        "the no-diff git status reading is not misused as an integration failure's evidence",
      );
      assert(
        cap.lensWorktreePath === wt,
        `the cap names the worktree it inspected (got: ${cap.lensWorktreePath})`,
      );
    }
    // The fix is still on disk in the worktree — the operator can recover it.
    const { stdout: wtStatus } = await execp("git status --porcelain", { cwd: wt });
    assert(wtStatus.trim().length > 0, "the fix is still on disk in the worktree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
