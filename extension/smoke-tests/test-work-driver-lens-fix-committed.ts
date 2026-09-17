#!/usr/bin/env bun
/**
 * Smoke test for the /work driver — committed-work-aware lens-fix detection
 * (#749, AGENTS.md §12 file-size limit).
 *
 * Covers: Issue #749 — four committed-fix shapes:
 *   50. tree-identical (landed): the fix is on the branch, no cap, no park.
 *   51. not-on-branch: the fix exists but the branch lacks it — either
 *       landed or parked with evidence naming the branch that lacks it.
 *   52. genuinely-empty: no commits, clean worktree — still parks with
 *       the committed-work evidence (not a porcelain check).
 *   53. ref-collision: a tag named like the branch does not shadow it.
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
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) =>
      sent.push(typeof content === "string" ? content : JSON.stringify(content)),
  } as unknown as ExtensionAPI;
  return { pi, sent };
}
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
});
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_FORGE = "none";
// Handoff-consolidate cherry-picks committed work onto the branch after a
// cap-hit park, masking the silent-non-integration bug case 51 pins down.
process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE = "0";
setupSpawnGuard();
// 50. Issue #749 — a committed lens-fix whose content is already on the
// branch (tree-identical, the #745 incident shape) is detected as landed
// and does NOT park. The cycle proceeds to re-review.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-committed-landed-"));
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
    await execp("git checkout -qb feature/lens-committed-landed", { cwd: root });
    const { stdout: baseShaOut } = await execp("git rev-parse HEAD", { cwd: root });
    const baseSha = baseShaOut.trim();
    await fs.writeFile(path.join(root, "feature.txt"), "buggy\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/lens-committed-landed", { cwd: root });
    await execp(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(baseSha)}`, {
      cwd: root,
    });

    // The worktree is at baseSha. The lens-fix developer commits a fix in
    // the worktree producing the SAME tree as the branch HEAD (#745 shape:
    // tree-identical but not ancestor). Worktree commits "lens-fix" creating
    // feature.txt = "fixed\n"; branch has "feature" ("buggy\n") on top of
    // baseSha. We make the branch contain the same content via a DIFFERENT
    // commit, so both trees are identical but the worktree commit is not
    // an ancestor of the branch.
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix'", {
      cwd: wt,
      shell: "/bin/bash",
    });
    // Make the branch contain the same content (tree-identical to worktree).
    await execp("git checkout -q feature/lens-committed-landed", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix (same content)'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q origin feature/lens-committed-landed", { cwd: root });

    let s = initialState(749, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "lens-fix",
        worktrees: { default: wt },
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
        branchName: "feature/lens-committed-landed",
        baseSha,
        prNumber: 7490,
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
              title: "bug",
              description: "needs fix",
              suggestion: "fix it",
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
      issue: 749,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Approved.",
        }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(root, 749);
    const events = after?.eventLog ?? [];
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    assert(cap === undefined, "a committed fix already on the branch does NOT park the cycle");
    const approved = events.find((e) => e.kind === "adversarial-approved");
    assert(
      approved !== undefined,
      "the adversarial gate approved (the committed fix was detected)",
    );
  } finally {
    // Do NOT rmSync here — the driver may still have async git operations
    // in flight (the handoff step). The OS cleans /tmp on reboot.
  }
}

// 51. Issue #749 — a committed lens-fix whose content is NOT on the branch
// (the #745 incident's true state) is either landed on the branch or
// parked with evidence naming the commit and the branch that lacks it.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-committed-not-on-branch-"));
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
    const { stdout: baseShaOut51 } = await execp("git rev-parse HEAD", { cwd: root });
    const baseSha51 = baseShaOut51.trim();
    await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/lens-not-on-branch", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "buggy\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/lens-not-on-branch", { cwd: root });
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: root });

    // The lens-fix developer commits a fix in the worktree. The branch
    // does NOT have this fix (the branch still has "buggy\n").
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix'", {
      cwd: wt,
      shell: "/bin/bash",
    });

    let s = initialState(750, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "lens-fix",
        worktrees: { default: wt },
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
        branchName: "feature/lens-not-on-branch",
        baseSha: baseSha51,
        prNumber: 7500,
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
              title: "bug",
              description: "needs fix",
              suggestion: "fix it",
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
      issue: 750,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Approved.",
        }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };

    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(root, 750);
    const events = after?.eventLog ?? [];
    // The branch CONTENT is the ground truth — not the event log.
    // `adversarial-approved` is appended BEFORE handleNoCommittedFix runs,
    // so asserting on it is tautological (#755 class). The real disjunction:
    // the branch actually carries the fix (landed), or the cycle parked.
    const { stdout: branchContent } = await execp(
      "git show feature/lens-not-on-branch:feature.txt",
      {
        cwd: root,
      },
    );
    const fixLanded = branchContent.trim() === "fixed";
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    assert(cap !== undefined || fixLanded, "either the fix was landed or the cycle parked");
    if (!fixLanded && cap && cap.kind === "cap-hit") {
      assert(
        (cap.evidence ?? "").includes("NOT on branch") ||
          (cap.evidence ?? "").includes("could not be landed"),
        `the cap evidence names the branch that lacks the fix (got: ${cap.evidence})`,
      );
    }
  } finally {
    // Do NOT rmSync here — the driver may still have async git operations
    // in flight (the handoff step). The OS cleans /tmp on reboot.
  }
}

// 52. Issue #749 — a genuinely empty followup (no commits, clean worktree)
// still raises the lens-fix-not-integrated cap. This is the guard against
// weakening the existing cap.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-genuinely-empty-"));
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
    await execp("git checkout -qb feature/lens-genuinely-empty", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "ok\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/lens-genuinely-empty", { cwd: root });
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: root });

    // The worktree is clean and has NO commits ahead of the branch.

    let s = initialState(751, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "commit-pr",
        worktrees: { default: wt },
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
        branchName: "feature/lens-genuinely-empty",
        prNumber: 7510,
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
              title: "bug",
              description: "needs fix",
              suggestion: "fix it",
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
      issue: 751,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label?.startsWith("developer:lens-fix"))
          return mkResult({ role: "developer", ok: true, text: "No changes needed." });
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Approved.",
        }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(root, 751);
    const events = after?.eventLog ?? [];
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    assert(
      cap !== undefined,
      "a genuinely empty followup (no commits, clean worktree) still raises the cap",
    );
    if (cap && cap.kind === "cap-hit") {
      assert(
        (cap.evidence ?? "").includes("no committed fix"),
        `the cap evidence names the committed-work detection (got: ${cap.evidence})`,
      );
    }
  } finally {
    // Do NOT rmSync here — the driver may still have async git operations
    // in flight. The OS cleans /tmp on reboot.
  }
}

// 53. Issue #749 — ref-namespace collision: a tag named like the branch
// shadows the branch in bare-name resolution; the driver must resolve it.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-ref-collision-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    const { countCommittedAhead, detectCommittedFix } = await import(
      "../src/work-driver-lens-fix-commit.ts"
    );
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
    await execp("git checkout -qb feature/ref-collision", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "buggy\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/ref-collision", { cwd: root });
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: root });
    // The fixer commits a fix, then a tag shadows the branch name.
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix'", {
      cwd: wt,
      shell: "/bin/bash",
    });
    await execp("git tag -f feature/ref-collision", { cwd: wt });
    // Sanity: the BARE name is tag-shadowed (the driver's old measurement shape).
    const { stdout: bareCount } = await execp("git rev-list --count feature/ref-collision..HEAD", {
      cwd: wt,
    });
    assert(
      Number.parseInt(bareCount.trim(), 10) === 0,
      "setup: the bare name is tag-shadowed (rev-list against it reports 0)",
    );
    const execFn = (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) =>
      new Promise<{ stdout: string; stderr?: string }>((resolve, reject) =>
        exec(cmd, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer }, (err, stdout, stderr) =>
          err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr }),
        ),
      );
    const count = await countCommittedAhead(execFn, wt, "feature/ref-collision");
    assert(
      count === 1,
      `the count is the TRUE committed count despite the tag shadow (got: ${count})`,
    );
    const fix = await detectCommittedFix(execFn, wt, "feature/ref-collision");
    assert(
      fix.status === "committed" && fix.count === 1 && fix.diffEmpty === false,
      `detectCommittedFix reports the fix as committed with content NOT on the branch (got: ${JSON.stringify(fix)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
