#!/usr/bin/env bun
/**
 * Smoke test for the /work driver — committed-work-aware lens-fix detection
 * (#749, #776).
 *
 * Covers:
 *   50. tree-identical (landed): the fix is on the branch, no cap, no park.
 *   51. not-on-branch: the fix exists but the branch lacks it — either
 *       landed or parked with evidence naming the branch that lacks it.
 *   52. genuinely-empty: no commits, clean worktree — still parks.
 *   53. untracked debris at repoRoot: does NOT block integration of a
 *       committed lens-fix in a separate worktree (#776).
 *   54. #797 — a lens-fix integration that hits a cherry-pick conflict:
 *       repoRoot is restored to the pre-integration ref and VERIFIED clean
 *       (porcelain empty, no merge/cherry-pick in progress), the cap
 *       evidence + handoff body state the restore outcome, and the
 *       worktree's commits survive intact.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
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
process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE = "0";
setupSpawnGuard();

// Shared fixture: bare origin + root repo + detached worktree at a feature
// branch's head. Returns the paths needed to drive a lens-fix scenario.
async function mkFixture(
  dir: string,
  branch: string,
): Promise<{ root: string; wt: string; baseSha: string; execp: (cmd: string, o?: { cwd?: string; shell?: string }) => Promise<{ stdout: string; stderr?: string }> }> {
  const { promisify } = await import("node:util");
  const { exec } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const execp = promisify(exec) as typeof exec;
  const origin = path.join(dir, "origin.git");
  const root = path.join(dir, "root");
  const wt = path.join(dir, "wt");
  await execp(`git init -q --bare --initial-branch=main origin.git`, { cwd: dir });
  await execp("git init -q --initial-branch=main root", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', { cwd: root, shell: "/bin/bash" });
  writeFileSync(path.join(root, ".git", "info", "exclude"), "\n.pi/\n");
  await fs.writeFile(path.join(root, "base.txt"), "hello\n");
  await execp("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
  await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
  await execp("git push -q -u origin main", { cwd: root });
  await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", { cwd: root });
  await execp(`git checkout -qb ${branch}`, { cwd: root });
  const baseSha = (await execp("git rev-parse HEAD", { cwd: root })).stdout.trim();
  await fs.writeFile(path.join(root, "feature.txt"), "buggy\n");
  await execp(`git add feature.txt && git commit -q -m 'feature' && git push -q -u origin ${branch}`, { cwd: root, shell: "/bin/bash" });
  await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: root });
  return { root, wt, baseSha, execp };
}

function mkLensState(
  issue: number,
  branch: string,
  baseSha: string,
  wt: string,
  opts: { currentStep: "adversarial" | "lens-fix"; lastCompletedStep: string; dispatchFn: DriverContext["dispatchFn"] },
) {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: opts.currentStep,
      lastCompletedStep: opts.lastCompletedStep,
      worktrees: { default: wt },
      workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
      branchName: branch,
      baseSha,
      prNumber: issue * 10,
      reviewRound: 1,
    },
    eventLog: [
      {
        kind: "lens-issues-found" as const,
        at: 2_000_000,
        jobId: "j-lens-1",
        round: 1,
        findings: JSON.stringify([
          { lens: "SECURITY", severity: "MEDIUM", path: "feature.txt", line: 1, title: "bug", description: "needs fix", suggestion: "fix it" },
        ]),
        verdict: "ISSUES_FOUND" as const,
      },
    ],
  };
}

const defaultDispatchFn: DriverContext["dispatchFn"] = async (_pi, spec, opts) => {
  if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
  if (opts?.label?.startsWith("developer:lens-fix"))
    return mkResult({ role: "developer", ok: true, text: "No changes needed." });
  throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
};

// 50. tree-identical (landed): the fix is on the branch, no cap, no park.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-committed-landed-"));
  try {
    const { root, wt, baseSha, execp } = await mkFixture(dir, "feature/lens-committed-landed");
    const fs = await import("node:fs/promises");
    // The worktree is at baseSha. The lens-fix developer commits a fix in
    // the worktree producing the SAME tree as the branch HEAD (#745 shape:
    // tree-identical but not ancestor). We make the branch contain the same
    // content via a DIFFERENT commit, so both trees are identical but the
    // worktree commit is not an ancestor of the branch.
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix'", { cwd: wt, shell: "/bin/bash" });
    await execp("git checkout -q feature/lens-committed-landed", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix (same content)' && git push -q origin feature/lens-committed-landed", { cwd: root, shell: "/bin/bash" });
    const s = mkLensState(749, "feature/lens-committed-landed", baseSha, wt, {
      currentStep: "adversarial", lastCompletedStep: "lens-fix", dispatchFn: defaultDispatchFn,
    });
    await writeState(root, s);
    const ctx: DriverContext = {
      pi: makeFakePi().pi, repoRoot: root, issue: 749,
      issueBodyFetcherFn: mockIssueBodyOk, dispatchFn: defaultDispatchFn,
      adversarialLoopFn: async () => mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "Approved." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const events = (await readState(root, 749))?.eventLog ?? [];
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    assert(cap === undefined, "a committed fix already on the branch does NOT park the cycle");
    const approved = events.find((e) => e.kind === "adversarial-approved");
    assert(approved !== undefined, "the adversarial gate approved (the committed fix was detected)");
  } finally {
    // Do NOT rmSync here — the driver may still have async git operations
    // in flight (the handoff step). The OS cleans /tmp on reboot.
  }
}

// 51. not-on-branch: the fix exists but the branch lacks it.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-committed-not-on-branch-"));
  try {
    const { root, wt, baseSha, execp } = await mkFixture(dir, "feature/lens-not-on-branch");
    const fs = await import("node:fs/promises");
    // The lens-fix developer commits a fix in the worktree. The branch
    // does NOT have this fix (the branch still has "buggy\n").
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix'", { cwd: wt, shell: "/bin/bash" });
    const s = mkLensState(750, "feature/lens-not-on-branch", baseSha, wt, {
      currentStep: "adversarial", lastCompletedStep: "lens-fix", dispatchFn: defaultDispatchFn,
    });
    await writeState(root, s);
    const ctx: DriverContext = {
      pi: makeFakePi().pi, repoRoot: root, issue: 750,
      issueBodyFetcherFn: mockIssueBodyOk, dispatchFn: defaultDispatchFn,
      adversarialLoopFn: async () => mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "Approved." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const events = (await readState(root, 750))?.eventLog ?? [];
    // The branch CONTENT is the ground truth — not the event log.
    const { stdout: branchContent } = await execp("git show feature/lens-not-on-branch:feature.txt", { cwd: root });
    const fixLanded = branchContent.trim() === "fixed";
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    assert(cap !== undefined || fixLanded, "either the fix was landed or the cycle parked");
    if (!fixLanded && cap && cap.kind === "cap-hit") {
      assert(
        (cap.evidence ?? "").includes("NOT on branch") || (cap.evidence ?? "").includes("could not be landed"),
        `the cap evidence names the branch that lacks the fix (got: ${cap.evidence})`,
      );
    }
  } finally {
    // Do NOT rmSync here — the driver may still have async git operations
    // in flight. The OS cleans /tmp on reboot.
  }
}

// 52. genuinely-empty: no commits, clean worktree — still parks.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-genuinely-empty-"));
  try {
    const { root, wt, baseSha } = await mkFixture(dir, "feature/lens-genuinely-empty");
    const s = mkLensState(751, "feature/lens-genuinely-empty", baseSha, wt, {
      currentStep: "lens-fix", lastCompletedStep: "commit-pr", dispatchFn: defaultDispatchFn,
    });
    await writeState(root, s);
    const ctx: DriverContext = {
      pi: makeFakePi().pi, repoRoot: root, issue: 751,
      issueBodyFetcherFn: mockIssueBodyOk, dispatchFn: defaultDispatchFn,
      adversarialLoopFn: async () => mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "Approved." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const events = (await readState(root, 751))?.eventLog ?? [];
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    assert(cap !== undefined, "a genuinely empty followup (no commits, clean worktree) still raises the cap");
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

// 53. Issue #776 — an untracked directory at repoRoot does NOT block
// integration of a committed lens-fix in a separate worktree. The debris
// is left untouched on disk; the fix is landed on the branch (or the cycle
// parks with the debris named in the evidence — not a generic "not safely
// restorable").
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-untracked-debris-"));
  try {
    const { root, wt, baseSha, execp } = await mkFixture(dir, "feature/lens-untracked-debris");
    const fs = await import("node:fs/promises");
    // The lens-fix developer commits a fix in the worktree.
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix'", { cwd: wt, shell: "/bin/bash" });
    // #776 — untracked debris at repoRoot (the #742 incident shape).
    await fs.mkdir(path.join(root, "debris-dir"), { recursive: true });
    await fs.writeFile(path.join(root, "debris-dir", "scratch.txt"), "junk\n");
    const s = mkLensState(776, "feature/lens-untracked-debris", baseSha, wt, {
      currentStep: "adversarial", lastCompletedStep: "lens-fix", dispatchFn: defaultDispatchFn,
    });
    await writeState(root, s);
    const ctx: DriverContext = {
      pi: makeFakePi().pi, repoRoot: root, issue: 776,
      issueBodyFetcherFn: mockIssueBodyOk, dispatchFn: defaultDispatchFn,
      adversarialLoopFn: async () => mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "Approved." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const events = (await readState(root, 776))?.eventLog ?? [];
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    // The debris must still be on disk (never stashed or deleted).
    const { existsSync } = await import("node:fs");
    assert(existsSync(path.join(root, "debris-dir", "scratch.txt")), "the untracked debris survived (not stashed or deleted)");
    // The branch content is the ground truth — either the fix landed or
    // the cycle parked with the debris named in the evidence.
    const { stdout: branchContent53 } = await execp("git show feature/lens-untracked-debris:feature.txt", { cwd: root });
    const fixLanded = branchContent53.trim() === "fixed";
    assert(fixLanded || cap !== undefined, "either the fix was landed or the cycle parked");
    if (!fixLanded && cap && cap.kind === "cap-hit") {
      const ev = cap.evidence ?? "";
      assert(
        ev.includes("debris-dir") || ev.includes("scratch") || ev.includes("??"),
        `the park evidence names the untracked debris (got: ${ev})`,
      );
      assert(!ev.includes("not safely restorable"), "the evidence is not the generic 'not safely restorable' string");
    }
  } finally {
    // Do NOT rmSync here — the driver may still have async git operations
    // in flight. The OS cleans /tmp on reboot.
  }
}

// 54. Issue #797 — a failed lens-fix integration (cherry-pick conflict / git
// commit failure on unmerged index) must leave repoRoot in a USABLE state:
// the checkout is on a named ref (the ref the integration left it on, NOT
// left dangling on the feature branch mid-merge), the porcelain is empty
// of tracked dirt, no merge/cherry-pick is in progress, the worktree's
// commits survive, and BOTH the cap evidence and the handoff body state
// the restore outcome. The driver records the pre-integration ref on the
// cap event (`restoredToRef`) so the post-condition is checkable from the
// state file alone.
//
// The fixture sets repoRoot to the feature branch BEFORE the cycle runs —
// the driver's landCommittedFix checks out the feature branch, so the
// pre-integration ref IS the feature branch; the restore returns to that
// same ref. The incident (#782) had the same shape: repoRoot ended on the
// feature branch with unmerged index; the fix must leave it on the feature
// branch with a clean index, not on main (which is not where the cycle
// started) and not in an unmerged state.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-fix-797-"));
  try {
    const { root, wt, baseSha, execp } = await mkFixture(dir, "feature/lens-fix-797");
    const fs = await import("node:fs/promises");
    // The fixture leaves repoRoot on the feature branch (the mkFixture helper
    // checks out the feature branch at the end). Confirm that, then record
    // it as the pre-integration ref.
    const { stdout: rootRefBefore } = await execp("git symbolic-ref --quiet --short HEAD", { cwd: root });
    const preIntegrationRef = rootRefBefore.trim();
    assert(preIntegrationRef === "feature/lens-fix-797", `fixture leaves repoRoot on the feature branch (got '${preIntegrationRef}')`);

    // The lens-fix worktree (detached at the feature branch head) commits a
    // fix that edits feature.txt.
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix commit 1' && git commit -q --allow-empty -m 'lens-fix commit 2' && git commit -q --allow-empty -m 'lens-fix commit 3'", { cwd: wt, shell: "/bin/bash" });
    const fixSha = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();

    // Now advance the feature branch to a commit that ALSO edits
    // feature.txt, so cherry-picking the fix's commits onto the branch hits
    // a real content conflict. repoRoot holds the branch, so the branch is
    // reset via `git reset --hard` in repoRoot (no temp worktree needed —
    // the sweep refuses to remove repoRoot, and a temp worktree would be
    // caught by the sweep and removed, but the simpler approach is to just
    // update the branch pointer directly).
    await fs.writeFile(path.join(root, "feature.txt"), "branch-side change\n");
    await execp("git add feature.txt && git commit -q -m 'branch-side change'", { cwd: root, shell: "/bin/bash" });

    // The state: the worktree map points at the lens-fix worktree; the
    // driver's landCommittedFix will cherry-pick the fix's commits onto
    // feature/lens-fix-797, which now has a different feature.txt →
    // cherry-pick conflict → git commit fails with "unmerged files".
    const s = mkLensState(797, "feature/lens-fix-797", baseSha, wt, {
      currentStep: "adversarial", lastCompletedStep: "lens-fix", dispatchFn: defaultDispatchFn,
    });
    await writeState(root, s);
    const ctx: DriverContext = {
      pi: makeFakePi().pi, repoRoot: root, issue: 797,
      issueBodyFetcherFn: mockIssueBodyOk, dispatchFn: defaultDispatchFn,
      adversarialLoopFn: async () => mkResult({ role: "adversarial-loop", ok: true, loopOutcome: "approved", text: "Approved." }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };
    await runWorkDriver(ctx).catch(() => {});
    const events = (await readState(root, 797))?.eventLog ?? [];
    const cap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated");
    // 1. The cycle parked with the cap (the cherry-pick conflict / unmerged
    //    index is a genuine integration failure).
    assert(cap !== undefined, "a failed lens-fix integration parks the cycle");
    // 2. repoRoot is on a named ref (the pre-integration ref) — NOT left
    //    on the feature branch mid-merge with unmerged index.
    const { stdout: rootRefAfter } = await execp("git symbolic-ref --quiet --short HEAD", { cwd: root }).catch(() => ({ stdout: "" }));
    assert(rootRefAfter.trim() === preIntegrationRef, `repoRoot is on the pre-integration ref (${preIntegrationRef}); got '${rootRefAfter.trim()}'`);
    // 3. Porcelain is empty of tracked dirt. The cherry-pick conflict would
    //    have left UU entries if unhandled — the exact #782 incident shape.
    const { stdout: porcelain } = await execp("git status --porcelain", { cwd: root });
    const dirt = porcelain
      .split("\n")
      .filter((l: string) => l.trim() && !l.startsWith("??") && !/^\.\.\s+"?\.worktrees\//.test(l));
    assert(dirt.length === 0, `repoRoot porcelain is empty of tracked dirt after the restore (got: ${dirt.join(", ") || "(empty)"})`);
    // 4. No merge or cherry-pick in progress.
    const hasMergeHead = await execp("git rev-parse MERGE_HEAD", { cwd: root }).then(() => true).catch(() => false);
    const hasCherryPickHead = await execp("git rev-parse CHERRY_PICK_HEAD", { cwd: root }).then(() => true).catch(() => false);
    assert(!hasMergeHead && !hasCherryPickHead, "no merge or cherry-pick is in progress at repoRoot after the restore");
    // 5. The worktree's commits survived the restore.
    const { stdout: wtHead } = await execp("git rev-parse HEAD", { cwd: wt });
    assert(wtHead.trim() === fixSha, "the lens-fix worktree's HEAD is unchanged (the commits survived the restore)");
    // 6. The cap event names the restore outcome AND records the
    //    pre-integration ref (so the operator can verify the post-condition
    //    without re-deriving it from the event log prose).
    if (cap && cap.kind === "cap-hit") {
      const ev = cap.evidence ?? "";
      assert(
        ev.includes("repoRoot was verified restored") || ev.includes("repoRoot was restored") || ev.includes("repoRoot was NOT restored"),
        `the cap evidence names the repoRoot restore outcome (got: ${ev.slice(0, 300)})`,
      );
      assert(
        cap.restoredToRef === preIntegrationRef,
        `the cap event records the pre-integration ref (restoredToRef=${JSON.stringify(cap.restoredToRef)}), expected '${preIntegrationRef}'`,
      );
    }
    // 7. The worktree's commits are still reachable (the worktree wasn't
    //    deleted or reset by the restore).
    const { stdout: wtCommits } = await execp(`git rev-list --count ${baseSha}..HEAD`, { cwd: wt });
    const commitCount = Number.parseInt(wtCommits.trim(), 10);
    assert(commitCount >= 3, `the worktree still has ${commitCount} commit(s) ahead of base (expected >=3, the fixer's commits)`);
    // 8. The handoff body (explainCap output) states the repoRoot condition
    //    (not just the cap evidence) and names the specific ref — the
    //    operator following the recovery steps must know the state BEFORE
    //    running anything in repoRoot.
    const { explainCap } = await import("../src/work-driver-explain.ts");
    const state = await readState(root, 797);
    const handoffText = state ? explainCap("lens-fix-not-integrated", state) : "";
    assert(
      handoffText.includes("repoRoot was verified restored") || handoffText.includes("repoRoot was restored") || handoffText.includes("repoRoot was NOT restored") || handoffText.includes("not recorded"),
      `the handoff body states the repoRoot condition (got: ${handoffText.slice(0, 200)})`,
    );
    assert(handoffText.includes(preIntegrationRef), `the handoff body names the pre-integration ref '${preIntegrationRef}'`);
  } finally {
    // Do NOT rmSync here — the driver may still have async git operations
    // in flight. The OS cleans /tmp on reboot.
  }
}
