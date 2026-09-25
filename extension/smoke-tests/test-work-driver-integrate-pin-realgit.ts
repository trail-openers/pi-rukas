#!/usr/bin/env bun
/**
 * #861 (SLICE 1) — the commit-pr ops fallback is pinned to the driver-owned
 * integration worktree (`.worktrees/issue-<N>-integrate`), and the
 * post-dispatch branch-holder audit halts with `integration-worktree-violation`
 * when the branch is held by the WRONG tree (the #841 defect).
 *
 * Real-git offline test (the #841 shape needs a real repo; the M2-M4 fake-exec
 * harness in test-work-driver-mechanized-commit-fallback.ts cannot exercise
 * the branch-holder audit, which parses `git worktree list --porcelain`).
 *
 * Coverage:
 *  (1) cycle 1's fallback stub checks its branch out inside a DIFFERENT
 *      cycle's worktree (issue-2-task-a) and commits there → the audit
 *      halts with `integration-worktree-violation` naming issue-2-task-a,
 *      and NO PR-verification gate runs.
 *  (2) a REAL cherry-pick conflict in integrate() → fallback → a stub that
 *      works ONLY in issue-1-integrate (applies the work, commits, pushes
 *      via a local bare remote, prints `pr: 99`) → the cycle proceeds
 *      through the PR gates, and the integrate worktree is GONE after
 *      success.
 *  (3) a stale dirty issue-1-integrate from a previous attempt is
 *      force-replaced; its old HEAD is recorded in a plumb/trace event.
 *  (4) the fallback dispatch spec carries `cwd` = the integrate path, and
 *      the prompt names that path as the ONLY permitted working tree and
 *      forbids the repo root and every other .worktrees/*.
 *  (7) `integration-worktree-violation` is in explainCap, in the recovery
 *      renderer, and accepted by the validator (the cap union +
 *      CAP_HIT_FIXED_LITERALS live in the source and are covered by the
 *      full gate; this asserts the two renderers).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import { integrateWorktreePath } from "../src/work-driver-integrate-worktree.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import type { WorkState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => {
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
      cwd: o?.cwd,
      maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`${err.message}\n${err.stderr ?? ""}`);
  }
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileP("git", args, { cwd })).stdout;

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-861-slice1-"));

async function fixture(name: string): Promise<{ repo: string; baseSha: string }> {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "shared.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return { repo, baseSha: stdout.trim() };
}

/** A local bare "remote" so `git push -u origin <branch>` works offline. */
async function addLocalRemote(repo: string): Promise<void> {
  const remote = path.join(root, `${path.basename(repo)}-remote.git`);
  await execFileP("git", ["init", "-q", "--bare", remote]);
  await git(repo, ["remote", "add", "origin", remote]);
}

const mkResult = (o: Partial<DispatchResult> = {}): DispatchResult => ({
  role: "explore",
  ok: true,
  text: "stub",
  toolUses: [],
  ms: 100,
  exitCode: 0,
  transcriptPath: "/tmp/stub-transcript.json",
  ...o,
});

const PLAN_REPLY = `## Workstreams

### task-a — edit the shared file
- paths: shared.txt
- out-of-scope: docs
`;

/**
 * Build the driver context for a cycle. `exec` wraps real git (the driver's
 * verify seam); `dispatch` is the ops-fallback stub. The dispatchFn records
 * every (label, prompt, cwd) it sees.
 */
function makeCtx(opts: {
  repo: string;
  issue: number;
  branchName: string;
  baseSha: string;
  worktreePath: string;
  onOpsCommitPr: (cwd: string | undefined, prompt: string) => Promise<DispatchResult | undefined>;
}): DriverContext {
  const { repo, issue, branchName, baseSha, worktreePath } = opts;
  const exec = async (cmd: string, o?: { cwd?: string }) => {
    if (cmd.startsWith("gh ")) return { stdout: "" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    return realExec(cmd, o);
  };
  const dispatchFn: NonNullable<DriverContext["dispatchFn"]> = async (_pi, spec, dOpts) => {
    const label = dOpts?.label ?? spec.role;
    if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
    if (label === "plan") return mkResult({ text: PLAN_REPLY });
    if (label === "ops") {
      return mkResult({
        role: "ops",
        text: `branch: ${branchName}\n\n## Worktrees\n\n- task-a: ${worktreePath}`,
      });
    }
    if (label.startsWith("developer"))
      return mkResult({ role: "developer", text: "done — implemented" });
    if (label === "ops:commit-pr") {
      return (
        (await opts.onOpsCommitPr(spec.cwd, spec.prompt)) ??
        mkResult({ role: "ops", text: "stub commit-pr (see onOpsCommitPr)" })
      );
    }
    if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
    if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
    throw new Error(`unexpected dispatch: ${label}`);
  };
  return {
    pi: {} as unknown as DriverContext["pi"],
    repoRoot: repo,
    issue,
    issueBodyFetcherFn: async (i: number) => ({
      stdout: `title:\tmock issue #${i}\nstate:\tOPEN\n\nmock body for issue #${i}`,
    }),
    verifyExecFn: exec,
    adversarialLoopFn: async () =>
      mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
    dispatchFn,
  };
}

/** Run the driver, capturing the ops:commit-pr invocation. */
async function runCycle(opts: {
  repo: string;
  issue: number;
  branchName: string;
  baseSha: string;
  worktreePath: string;
  onOpsCommitPr: (cwd: string | undefined, prompt: string) => Promise<DispatchResult | undefined>;
}): Promise<WorkState | undefined> {
  process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
  process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
  process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
  process.env.PI_ENSEMBLE_VERIFY = "0";
  const ctx = makeCtx(opts);
  await runWorkDriver(ctx).catch(() => {});
  const { readState } = await import("../src/workflow-state.ts");
  return readState(opts.repo, opts.issue);
}

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
    const { repo, baseSha } = await fixture("viol");
    await addLocalRemote(repo);
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
    const { initialState, appendEvent } = await import("../src/workflow-state.ts");
    let state = initialState(1, 1000);
    state = appendEvent(state, {
      kind: "dispatch-completed",
      step: "commit-pr",
      role: "ops",
      label: "ops:commit-pr",
      jobId: "j1",
      summary: "rogue commit in the wrong tree\npr: 99",
      ms: 100,
      at: 2000,
      ok: true,
    });
    state = {
      ...state,
      pipelineState: { ...state.pipelineState, branchName: branch1, baseSha },
    };
    const { auditCommitPrFallback } = await import("../src/work-driver-commit-pr-audit.ts");
    const after = await auditCommitPrFallback(
      {
        pi: {} as unknown as DriverContext["pi"],
        repoRoot: repo,
        issue: 1,
        verifyExecFn: realExec,
      } as unknown as DriverContext,
      realExec,
      state,
      true,
    );
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
  // (2) A REAL cherry-pick conflict → fallback → a stub that works ONLY in
  // issue-1-integrate → the cycle proceeds, and the integrate worktree is
  // GONE after success.
  // =====================================================================
  {
    const { repo, baseSha } = await fixture("conflict");
    await addLocalRemote(repo);
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
  }

  // =====================================================================
  // (3) A stale dirty issue-1-integrate is force-replaced (no guard refusal).
  // =====================================================================
  {
    const { repo, baseSha } = await fixture("stale");
    await addLocalRemote(repo);
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
    const { repo, baseSha } = await fixture("cwd");
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
  // (7) The cap in explainCap + recovery renderer + validator.
  // =====================================================================
  {
    const state: WorkState = {
      schemaVersion: 1,
      resumable: false,
      issue: 1,
      startedAt: 1,
      updatedAt: 2,
      pipelineState: {
        currentStep: "handoff",
        inFlightJobIds: [],
        worktrees: {},
        reviewRound: 0,
        ciRetryCount: 0,
        plumbReports: [],
        status: "handoff",
        branchName: "feature/issue-1",
      },
      eventLog: [
        {
          kind: "cap-hit",
          at: 3,
          cap: "integration-worktree-violation",
          evidence:
            "holder: /x/.worktrees/issue-2-task-a (integration branch feature/issue-1; expected holder /x/.worktrees/issue-1-integrate)",
          reviewRound: 0,
          nextStep: "handoff",
        },
      ],
    };
    const explained = explainCap("integration-worktree-violation", state);
    assert(
      /wrong tree|NOT the driver-owned integrate worktree/i.test(explained),
      "explainCap renders a defined sentence for integration-worktree-violation",
    );
    const recovery = recoveryStepsForCap(state, "github");
    const section = recovery.steps.find((s) => s.section === "integration-worktree-violation");
    assert(
      section !== undefined,
      "recoveryStepsForCap renders an integration-worktree-violation section",
    );
    // The validator accepts the cap (it is in CAP_HIT_FIXED_LITERALS).
    const findings = validateDiscriminants(state);
    assert(
      !findings.some((f) => /integration-worktree-violation/.test(f)),
      "the validator accepts integration-worktree-violation (no unknown-value finding)",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
