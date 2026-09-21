#!/usr/bin/env bun
// Lens-fix edge cases: #305 (47/48), #492/#749 (49), #776 conflict-park (54).
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

// PR11 — default issue-body fetcher; avoids the empty-body halt guard.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
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

// #297 — zero backoff for persistent-failure tests.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";
// The #654 empty-diff tests reach handoff (the no-diff cap parks the cycle).
// handoffForge() would otherwise resolve a real forge and attempt an in-process
// `gh` post (no remote in the test repos). PI_ENSEMBLE_FORGE=none makes
// handoffForge() return undefined, so the fallback is skipped (the handoff is
// still recorded via the ops:handoff dispatch-completed event).
process.env.PI_ENSEMBLE_FORGE = "none";

setupSpawnGuard();
// 47. Issue #305 — lens-fix making NO change does NOT produce an empty commit.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-fix-no-change-"));
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
    await execp("git checkout -qb feature/lens-no-change", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "ok\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: dir,
      shell: "/bin/bash",
    });
    const wt = path.join(dir, ".wt");
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: dir });
    const { stdout: beforeLog } = await execp("git rev-list --count origin/main..HEAD", { cwd: dir });
    const beforeCount = Number.parseInt(beforeLog.trim(), 10);
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
        if (opts?.label?.startsWith("developer:lens-fix"))
          return mkResult({ role: "developer", ok: true, text: "No changes needed." });
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "APPROVED." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const { stdout: afterLog } = await execp("git rev-list --count origin/main..HEAD", { cwd: dir });
    const afterCount = Number.parseInt(afterLog.trim(), 10);
    assert(afterCount === beforeCount, `no empty commit after no-change lens-fix`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// 49. Issue #492/#749 — no-diff lens-fix: cap evidence names rev-list count.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-no-diff-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
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
    const finding = {
      lens: "SIMPLICITY" as const,
      severity: "MEDIUM" as const,
      path: "feature.txt",
      line: 1,
      title: "trivial",
      description: "nothing to fix",
      suggestion: "leave as is",
    };
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
          findings: JSON.stringify([finding]),
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
        if (opts?.label?.startsWith("developer:lens-fix"))
          return mkResult({ role: "developer", ok: true, text: "No changes needed." });
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "APPROVED." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const after492 = await readState(root, 492);
    const cap = after492
      ?.eventLog.filter((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated").at(-1);
    assert(cap !== undefined, "a no-diff lens-fix parks with the lens-fix-not-integrated cap");
    if (cap && cap.kind === "cap-hit") {
      assert(
        (cap.evidence ?? "").includes("no committed fix") &&
          (cap.evidence ?? "").includes("rev-list --count"),
        `the cap carries the committed-work evidence (got: ${cap.evidence})`,
      );
      assert(
        !(cap.evidence ?? "").includes("git status --porcelain"),
        `the cap does NOT cite a porcelain check (got: ${cap.evidence})`,
      );
      assert(
        cap.lensWorktreePath === wt,
        `the cap names the worktree it inspected (got: ${cap.lensWorktreePath})`,
      );
      assert(
        (after492?.pipelineState.plumbReports ?? []).length === 0,
        "a no-diff outcome is NOT an integration failure — it carries no plumb-report",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 48. Issue #305 — lens-fix creating a NEW (untracked) file is committed.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-new-file-"));
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
    await execp("git checkout -qb feature/lens-new-file", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "const x = eval(input);\n");
    await execp("git add feature.txt && git commit -q -m 'feature with bug'", {
      cwd: dir,
      shell: "/bin/bash",
    });
    const { stdout: beforeLog } = await execp("git rev-list --count origin/main..HEAD", { cwd: dir });
    const beforeCount = Number.parseInt(beforeLog.trim(), 10);
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
            { lens: "SECURITY", severity: "MEDIUM", path: "feature.txt", line: 1, title: "eval() usage", description: "Unsafe eval", suggestion: "Extract to helper module" },
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
        if (opts?.label?.startsWith("developer:lens-fix")) {
          await fs.writeFile(path.join(dir, "safe-helper.ts"), "export const safeParse = (x) => JSON.parse(x);\n");
          await fs.writeFile(path.join(dir, "feature.txt"), "import { safeParse } from './safe-helper';\n");
          return mkResult({ role: "developer", ok: true, text: "Fixed." });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
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

    const { stdout: diff } = await execp("git diff origin/main..HEAD", { cwd: dir });
    assert(diff.includes("safeParse"), "committed diff includes new file content");
    const { stdout: lsFiles } = await execp("git ls-files safe-helper.ts", { cwd: dir });
    assert(lsFiles.trim() === "safe-helper.ts", "new file is tracked in the committed tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// 54. Issue #776 — conflict-park: cap evidence names the reason; fix SHA recoverable.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-conflict-"));
  try {
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    const fs = await import("node:fs/promises");
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
    await execp("git checkout -qb feature/lens-conflict", { cwd: root });
    const branchShaBefore = (await execp("git rev-parse HEAD", { cwd: root })).stdout.trim();
    await execp(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(branchShaBefore)}`, {
      cwd: root,
    });
    await fs.writeFile(path.join(wt, "base.txt"), "worktree fixed version\n");
    await execp('git config user.email "t@t" && git config user.name "T" && git add base.txt && git commit -q -m "lens fix"', {
      cwd: wt,
      shell: "/bin/bash",
    });
    await fs.writeFile(path.join(root, "base.txt"), "branch version\n");
    await execp("git add base.txt && git commit -q -m 'branch change'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp(`git push -q -u origin feature/lens-conflict`, { cwd: root });
    const wtHead = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
    const baseSha = (await execp("git rev-parse origin/main", { cwd: root })).stdout.trim();

    let s = initialState(776, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "commit-pr",
        worktrees: { default: wt },
        workstreams: {
          default: { id: "default", scope: "test", paths: ["base.txt"], outOfScope: [] },
        },
        branchName: "feature/lens-conflict",
        baseSha,
        prNumber: 7760,
        reviewRound: 1,
      },
      eventLog: [
        {
          kind: "lens-issues-found" as const,
          at: 2_000_000,
          jobId: "j-lens-1",
          round: 1,
          findings: JSON.stringify([
            { lens: "SIMPLICITY", severity: "MEDIUM", path: "base.txt", line: 1, title: "trivial", description: "nothing", suggestion: "leave" },
          ]),
          verdict: "ISSUES_FOUND" as const,
        },
      ],
    };
    await writeState(root, s);
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: root,
      issue: 776,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, _spec, opts) => {
        if (opts?.label?.startsWith("developer:lens-fix"))
          return mkResult({ role: "developer", ok: true, text: "Fix committed." });
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "APPROVED." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const cap = (await readState(root, 776))
      ?.eventLog.filter((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated").at(-1);
    assert(cap !== undefined, "a conflicting lens-fix integration parks with the cap");
    if (cap && cap.kind === "cap-hit") {
      assert(
        (cap.evidence ?? "").includes("conflict") ||
          (cap.evidence ?? "").includes("genuinely failed"),
        `cap evidence names the reason (got: ${cap.evidence})`,
      );
      assert(cap.lensWorktreePath === wt, `cap names the worktree`);
      const wtHeadNow = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
      assert(wtHeadNow === wtHead, `worktree still holds the fix commit`);
      const ancestorOut = await execp(
        `git merge-base --is-ancestor ${JSON.stringify(wtHead)} feature/lens-conflict && echo yes || echo no`,
        { cwd: root },
      ).catch(() => ({ stdout: "yes" }));
      assert(
        ancestorOut.stdout.trim() === "no",
        `fix commit ${wtHead.slice(0, 8)} NOT on branch (conflict — not landed)`,
      );
      const { stdout: aheadOut } = await execp(
        `git rev-list --count ${JSON.stringify(baseSha)}..HEAD`,
        { cwd: wt },
      );
      assert(
        Number.parseInt(aheadOut.trim(), 10) > 0,
        "worktree is ahead of base — captureCommittedWork would record the SHA",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`\nexit ${exit}`);
process.exit(exit);
