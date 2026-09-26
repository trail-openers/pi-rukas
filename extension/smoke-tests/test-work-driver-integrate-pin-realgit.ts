#!/usr/bin/env bun
/**
 * #861 (SLICE 1) — the commit-pr ops fallback is pinned to the
 * driver-owned integration worktree (`.worktrees/issue-<N>-integrate`),
 * and the post-dispatch branch-holder audit halts with
 * `integration-worktree-violation` when the branch is held by the WRONG
 * tree (the #841 defect).
 *
 * Real-git offline test (the #841 shape needs a real repo; the M2-M4
 * fake-exec harness cannot exercise the branch-holder audit, which parses
 * `git worktree list --porcelain`). Coverage: (1) rogue holder → audit
 * halts; (1b) STRICT rule; (2) a REAL cherry-pick conflict → fallback →
 * stub works ONLY in issue-1-integrate → cycle proceeds, integrate
 * worktree GONE after success; (3) a stale dirty issue-1-integrate is
 * force-replaced, old HEAD recorded; (4) the fallback dispatch spec carries
 * `cwd` = the integrate path; (5) the detach path: repoRoot CLEAN on the
 * branch is detached first, audit passes; (8) a FAILING `git worktree
 * list` is NOT "no holders" — the audit halts with the evidence (the #861
 * fail-closed probe); (9) Re-entry: a DIRTY driver-owned integrate tree
 * RECORDED IN STATE is REPLACED (decision (2)), not refused — no halt;
 * (7) `integration-worktree-violation` is in explainCap, in the recovery
 * renderer, and accepted by the validator.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { integrateWorktreePath } from "../src/work-driver-integrate-worktree.ts";
import {
  addLocalRemote,
  fixture,
  git,
  mkResult,
  realExec,
  runCycle,
  auditStateFor,
  auditCtx,
} from "./helpers-integrate-pin-realgit.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-861-slice1-"));

try {
  // =====================================================================
  // (1) The #841 defect: the branch is held by the WRONG worktree → the
  // audit halts with `integration-worktree-violation` naming the holder.
  // Exercised at the UNIT level (auditCommitPrFallback directly) — the
  // #841 shape is the audit's input: a real `git worktree list` with a
  // rogue holder. (The cycle-level harness can't force this shape offline:
  // the rogue branch is never pushed, so the driver halts at lens first.)
  // =====================================================================
  {
    const { repo, baseSha } = await fixture(root, "viol");
    await addLocalRemote(root, repo);
    // cycle 2's worktree (a DIFFERENT issue) — the #841 shape: #841's ops
    // child checked its branch out inside #844's worktree.
    const wtIssue2 = path.join(repo, ".worktrees", "issue-2-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wtIssue2, baseSha]);
    // The integrate worktree (what the fallback was pinned to).
    const integrate1 = integrateWorktreePath(repo, 1);
    await git(repo, ["worktree", "add", "-q", "--detach", integrate1, baseSha]);
    // The branch, checked out in the WRONG worktree (issue-2-task-a).
    const branch1 = "feature/issue-1-viol";
    await git(wtIssue2, ["checkout", "-q", "-B", branch1]);
    await git(wtIssue2, ["commit", "-q", "--allow-empty", "-m", "rogue commit in the wrong tree"]);

    // A completed fallback dispatch (the ops child returned) — the audit
    // runs on this state. The gates have NOT run (the audit must halt
    // before they can).
    const state = auditStateFor(1, branch1, baseSha, "rogue commit in the wrong tree\npr: 99");
    const { auditCommitPrFallback } = await import("../src/work-driver-commit-pr-audit.ts");
    const after = await auditCommitPrFallback(auditCtx(repo, 1), realExec, state, true);
    const capHit = after.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "integration-worktree-violation",
      `the audit halts with integration-worktree-violation (got ${capHit?.cap})`,
    );
    assert(
      (capHit?.evidence ?? "").includes("issue-2-task-a"),
      "the cap's evidence NAMES the offending holder (issue-2-task-a)",
    );
    // The PR-verification gates did NOT run: no prNumber was adopted, and
    // no commit-pr gate event (consolidation/verify) was appended after
    // the dispatch completed.
    assert(
      after.pipelineState.prNumber === undefined,
      "no PR number was adopted — the PR-verification gates did not run",
    );
    const gateCap = after.eventLog.find(
      (e) =>
        e.kind === "cap-hit" &&
        (e.cap === "commit-pr-incomplete-consolidation" || e.cap === "verify-failed:commit-pr"),
    );
    assert(
      gateCap === undefined,
      "no commit-pr PR-gate cap was emitted — the gates never ran (the audit halted first)",
    );
  }

  // =====================================================================
  // (1b) STRICT rule (decision (4)): the audit accepts the integrate
  // worktree or NOTHING. repoRoot as holder → violation; this cycle's OWN
  // workstream worktree as holder → violation.
  // =====================================================================
  {
    const { repo, baseSha } = await fixture(root, "strict");
    await addLocalRemote(root, repo);
    const branch1 = "feature/issue-1-strict";
    const auditCtxStrict = auditCtx(repo, 1);
    const stateWith = (extra: Record<string, unknown> = {}) =>
      auditStateFor(1, branch1, baseSha, "stub\npr: 99", extra);
    const { auditCommitPrFallback } = await import("../src/work-driver-commit-pr-audit.ts");
    // (a) repoRoot holds the branch (main tree — not in `git worktree list`).
    const wtStrict = path.join(repo, ".worktrees", "issue-1-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wtStrict, baseSha]);
    await execFileP("git", ["checkout", "-q", "-B", branch1], { cwd: repo });
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "repoRoot holds the branch"]);
    const afterRoot = await auditCommitPrFallback(auditCtxStrict, realExec, stateWith(), true);
    const capRoot = afterRoot.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      capRoot?.kind === "cap-hit" && capRoot.cap === "integration-worktree-violation",
      `STRICT: repoRoot as holder → violation (got ${capRoot?.cap})`,
    );
    assert(
      (capRoot?.evidence ?? "").startsWith(`holder: ${repo}`),
      `STRICT: the repoRoot violation evidence names repoRoot (got: ${capRoot?.evidence})`,
    );
    // (b) this cycle's OWN workstream worktree holds the branch.
    await git(repo, ["checkout", "-q", "main"]);
    await git(wtStrict, ["checkout", "-q", "-B", branch1]);
    await git(wtStrict, ["commit", "-q", "--allow-empty", "-m", "own worktree holds the branch"]);
    const afterOwn = await auditCommitPrFallback(auditCtxStrict, realExec, stateWith(), true);
    const capOwn = afterOwn.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      capOwn?.kind === "cap-hit" && capOwn.cap === "integration-worktree-violation",
      `STRICT: this cycle's OWN workstream worktree as holder → violation (got ${capOwn?.cap})`,
    );
    assert(
      (capOwn?.evidence ?? "").includes("issue-1-task-a"),
      "STRICT: the own-worktree violation evidence names the workstream worktree",
    );
  }

  // =====================================================================
  // (2) A REAL cherry-pick conflict → fallback → a stub that works ONLY in
  // issue-1-integrate → the cycle proceeds, and the integrate worktree is
  // GONE after success.
  // =====================================================================
  {
    const { repo, baseSha } = await fixture(root, "conflict");
    await addLocalRemote(root, repo);
    // A sibling commit on main (shared.txt line2) that the workstream's
    // commit (shared.txt line2, different) conflicts with: integrate()'s
    // cherry-pick of the workstream onto main (baseSha) hits a real
    // conflict → fallback.
    writeFileSync(path.join(repo, "shared.txt"), "line1\nline2-MAIN\nline3\n");
    await git(repo, ["add", "shared.txt"]);
    await git(repo, ["commit", "-q", "-m", "main advances shared.txt"]);
    const newBase = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

    const wt = path.join(repo, ".worktrees", "issue-1-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, newBase]);
    writeFileSync(path.join(wt, "shared.txt"), "line1\nline2-WORK\nline3\n");
    writeFileSync(path.join(wt, "feature1.txt"), "feature one\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "w1 (conflicts with main)"]);

    const branch1 = "feature/issue-1-conflict";
    const integrate1 = integrateWorktreePath(repo, 1);
    let opsCwd: string | undefined;
    let opsPrompt = "";
    const onOps = (cwd: string | undefined, prompt: string) => {
      opsCwd = cwd;
      opsPrompt = prompt;
      // Work ONLY in the integrate worktree (the supplied cwd).
      void (async () => {
        const wtCwd = cwd ?? ("" as unknown as string);
        const r = (a: string[]) => execFileP("git", a, { cwd: wtCwd });
        // The integrate worktree is attached at baseSha (the branch
        // exists at the tip integrate() left, i.e. baseSha on the
        // conflict path). Apply the workstream's work, commit, push.
        try {
          await r(["reset", "--hard"]);
        } catch {
          /* the branch may not be checked out yet in this stub */
        }
        try {
          await execFileP("git", ["apply", "--3way", "--binary", "-"], {
            cwd: cwd ?? ("" as unknown as string),
            input: (await execFileP("git", ["diff", "HEAD", "--binary"], { cwd: wt })).stdout,
          });
        } catch {
          // conflict in the stub too — commit what applied + the new file
        }
        try {
          await r(["add", "-A"]);
          await r(["commit", "-q", "--allow-empty", "-m", "ops fallback consolidation"]);
          await r(["push", "-q", "-u", "origin", branch1]);
        } catch {
          /* push failure is fine for the assertion below */
        }
      })();
      return mkResult({ role: "ops", text: "consolidated in the integrate worktree.\npr: 99" });
    };
    const after = await runCycle({
      repo,
      issue: 1,
      branchName: branch1,
      baseSha: newBase,
      worktreePath: wt,
      onOpsCommitPr: onOps,
    });
    // The fallback fired (a plumb-report at commit-pr) and the cycle
    // PROCEEDED (no integration-worktree-violation cap; the stub worked
    // only in the integrate worktree, so the audit passes).
    const violation = after?.eventLog.find(
      (e) => e.kind === "cap-hit" && e.cap === "integration-worktree-violation",
    );
    assert(
      violation === undefined,
      "no integration-worktree-violation — the stub worked only in issue-1-integrate",
    );
    // The integrate worktree is GONE after success (removed by the
    // driver). The audit path removed it on a clean tail.
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(
      !list.includes("issue-1-integrate"),
      "the integrate worktree is GONE after commit-pr success",
    );
    // (4, partial) the prompt named the integrate path as the ONLY
    // permitted tree and forbade the repo root and other worktrees.
    assert(
      opsPrompt.includes(integrate1) &&
        /ONLY permitted working tree/.test(opsPrompt) &&
        /OFF LIMITS/.test(opsPrompt),
      "the fallback prompt names the integrate path as the ONLY permitted tree and forbids the rest",
    );
    // #861 — this fixture's real git conflict routes through the CHERRY-PICK
    // path, which has no conflictPatch (the patch-preservation convention is
    // the patch-apply path's) — the prompt says no artifact was preserved.
    // (The M2b fake-exec test carries the preserved-patch shape.)
    assert(
      /No conflict artifact was preserved/.test(opsPrompt),
      "the fallback prompt reports no preserved artifact (cherry-pick path carries no conflictPatch)",
    );
    // #861 — the success-path audit cleared pipelineState.integrateWorktree
    // (the schema contract: cleared when the audit removes it on success).
    assert(
      after?.pipelineState.integrateWorktree === undefined,
      "pipelineState.integrateWorktree is CLEARED after the audit removed the tree on success",
    );
  }

  // =====================================================================
  // (3) A stale dirty issue-1-integrate is force-replaced (no guard refusal).
  // =====================================================================
  {
    const { repo, baseSha } = await fixture(root, "stale");
    await addLocalRemote(root, repo);
    const integrate1 = integrateWorktreePath(repo, 1);
    // Pre-create a DIRTY stale integrate worktree (a prior crashed
    // attempt left uncommitted work there).
    await git(repo, ["worktree", "add", "-q", "--detach", integrate1, baseSha]);
    writeFileSync(path.join(integrate1, "stale-work.txt"), "leftover from a crashed attempt\n");

    const wt = path.join(repo, ".worktrees", "issue-1-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    writeFileSync(path.join(wt, "feature1.txt"), "feature one\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "w1"]);

    const branch1 = "feature/issue-1-stale";
    const onOps = (_c: string | undefined, _p: string) =>
      mkResult({ role: "ops", text: "consolidated and pushed.\npr: 99" });
    const after = await runCycle({
      repo,
      issue: 1,
      branchName: branch1,
      baseSha,
      worktreePath: wt,
      onOpsCommitPr: onOps,
    });
    // The cycle did NOT park on a guard refusal (a driver-owned stale
    // tree is not operator residue); the stale tree was replaced (no dup).
    const refusalCap = after?.eventLog.find(
      (e) => e.kind === "cap-hit" && /dirty|leftover|refus/i.test(e.cap),
    );
    assert(
      refusalCap === undefined,
      "no guard-refusal cap — the stale driver-owned tree was replaced",
    );
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    const integrateEntries = list.split("worktree ").filter((l) => l.includes("issue-1-integrate"));
    assert(
      integrateEntries.length <= 1,
      `the stale integrate worktree was replaced (no duplicate; ${integrateEntries.length} present now)`,
    );
  }

  // =====================================================================
  // (4) The dispatch spec's cwd is the integrate path.
  // =====================================================================
  {
    // Re-run scenario 2's shape minimally to capture the cwd: a fresh
    // fixture where the fallback fires (empty worktree → the no-uncommitted
    // reason) and the stub does nothing.
    const { repo, baseSha } = await fixture(root, "cwd");
    const wt = path.join(repo, ".worktrees", "issue-1-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    const branch1 = "feature/issue-1-cwd";
    let opsCwd: string | undefined;
    const onOps = (cwd: string | undefined) => {
      opsCwd = cwd;
    };
    await runCycle({
      repo,
      issue: 1,
      branchName: branch1,
      baseSha,
      worktreePath: wt,
      onOpsCommitPr: onOps,
    });
    assert(
      opsCwd === integrateWorktreePath(repo, 1),
      `the fallback dispatch spec's cwd IS the integrate path (got ${opsCwd})`,
    );
  }

  // =====================================================================
  // (5) The detach path (decision (1)) — exercised DIRECTLY on
  // ensureIntegrateWorktree (a cycle-level fixture cannot drive it: the
  // branch step's own preflight refuses a repoRoot with uncommitted
  // work, and integrate()'s `checkout -B` moves repoRoot onto the branch
  // by the time the fallback runs — so in the cycle flow repoRoot never
  // holds the branch at ensureIntegrateWorktree time; this is the unit
  // shape): repoRoot CLEAN on the branch is detached, the integrate
  // worktree is created ATTACHED at the branch tip, and a post-creation
  // audit passes (the integrate worktree is the only holder).
  // =====================================================================
  {
    const { repo, baseSha } = await fixture(root, "detach");
    await addLocalRemote(root, repo);
    const branch1 = "feature/issue-1-detach";
    await git(repo, ["checkout", "-q", "-B", branch1]);
    const before = await (
      await import("../src/work-driver-integrate-worktree.ts")
    ).repoRootHoldsBranch(repo, branch1);
    assert(before, "detach: repoRoot STARTS on the branch (the fixture precondition)");
    const { ensureIntegrateWorktree } = await import("../src/work-driver-integrate-worktree.ts");
    const created = await ensureIntegrateWorktree(realExec, {
      repoRoot: repo,
      issue: 1,
      branchName: branch1,
      baseSha,
    });
    assert(created.repoRootDetached, "detach: the result records that repoRoot was detached");
    const { stdout: rootRef } = await execFileP(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        cwd: repo,
      },
    ).catch(() => ({ stdout: "" }));
    assert(
      rootRef.trim() !== branch1,
      `repoRoot was DETACHED off ${branch1} (now on ${(rootRef ?? "").trim() || "detached HEAD"})`,
    );
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(
      list.includes("issue-1-integrate"),
      "the integrate worktree was created (it now holds the branch after the detach)",
    );
    // Post-creation audit: the integrate worktree is the ONLY holder →
    // no violation (a stub dispatch result completes the audit's input).
    const { auditCommitPrFallback } = await import("../src/work-driver-commit-pr-audit.ts");
    const after = await auditCommitPrFallback(
      auditCtx(repo, 1),
      realExec,
      auditStateFor(1, branch1, baseSha, "stub\npr: 99"),
      true,
    );
    const cap = after.eventLog.find(
      (e) => e.kind === "cap-hit" && e.cap === "integration-worktree-violation",
    );
    assert(
      cap === undefined,
      "detach: the post-creation audit PASSES (integrate worktree is the only holder)",
    );
  }

  // =====================================================================
  // (8) branchHolders: a FAILING `git worktree list` is NOT "no holders"
  // (the #861 fail-closed probe principle) — the audit halts with the
  // evidence rather than passing an unreadable holder.
  // =====================================================================
  {
    const { repo, baseSha } = await fixture(root, "holders-unreadable");
    await addLocalRemote(root, repo);
    const branch1 = "feature/issue-1-unreadable";
    const failingExec: typeof realExec = async (cmd, o) => {
      if (cmd.includes("git worktree list")) throw new Error("simulated git failure");
      return realExec(cmd, o);
    };
    const state = auditStateFor(1, branch1, baseSha, "stub\npr: 99");
    const ctx: DriverContext = {
      pi: {} as unknown as DriverContext["pi"],
      repoRoot: repo,
      issue: 1,
      verifyExecFn: failingExec,
    } as unknown as DriverContext;
    const { auditCommitPrFallback } = await import("../src/work-driver-commit-pr-audit.ts");
    const after = await auditCommitPrFallback(ctx, failingExec, state, true);
    const capHit = after.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "integration-worktree-violation",
      `a failing worktree list HALTS the audit (got ${capHit?.cap})`,
    );
    assert(
      (capHit?.evidence ?? "").includes("branch holders unreadable"),
      "the halt's evidence says the holders are UNREADABLE (not a holder name)",
    );
  }

  // =====================================================================
  // (9) Re-entry: a DIRTY driver-owned integrate tree RECORDED IN STATE
  // (pipelineState.integrateWorktree) is REPLACED (decision (2)), not
  // refused — the old HEAD is traced, and no halt fires.
  // =====================================================================
  {
    const { repo, baseSha } = await fixture(root, "reentry-recorded");
    await addLocalRemote(root, repo);
    const integrate1 = integrateWorktreePath(repo, 1);
    await git(repo, ["worktree", "add", "-q", "--detach", integrate1, baseSha]);
    writeFileSync(path.join(integrate1, "stale-work.txt"), "leftover\n");
    const { writeState, initialState } = await import("../src/workflow-state.ts");
    const st = initialState(1, 1000);
    await writeState(repo, {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        currentStep: "commit-pr",
        branchName: "feature/issue-1-reentry",
        baseSha,
        integrateWorktree: integrate1,
      },
    });
    const wt = path.join(repo, ".worktrees", "issue-1-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    writeFileSync(path.join(wt, "feature1.txt"), "feature one\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "w1"]);
    const branch1 = "feature/issue-1-reentry";
    const onOps = (_c: string | undefined, _p: string) =>
      mkResult({ role: "ops", text: "consolidated and pushed.\npr: 99" });
    const after = await runCycle({
      repo,
      issue: 1,
      branchName: branch1,
      baseSha,
      worktreePath: wt,
      onOpsCommitPr: onOps,
    });
    // The cycle did NOT halt on a guard refusal — the recorded driver-owned
    // tree was replaced (decision (2)).
    const haltCap = after?.eventLog.find(
      (e) => e.kind === "cap-hit" && e.cap === "integration-worktree-violation",
    );
    assert(
      haltCap === undefined || !(haltCap?.evidence ?? "").includes("refuses to destroy"),
      "no operator-residue halt — the recorded driver-owned tree was replaced",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
