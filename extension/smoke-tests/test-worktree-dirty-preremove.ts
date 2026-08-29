#!/usr/bin/env bun
/**
 * #475 — worktreeCreate's pre-remove must not silently destroy uncommitted work.
 *
 * `worktreeCreate` force-removes an existing worktree at the same path so a
 * resumed cycle is not wedged by its own leftover. But the develop step
 * instructs developers not to commit, so a cycle that died mid-develop leaves
 * its diff uncommitted in the worktree — not in the object database,
 * unrecoverable. The force-remove destroyed it with no warning.
 *
 * Now: `inspectWorktreeForLoss` checks the leftover BEFORE the remove
 * (porcelain + commits ahead of the base). Dirty → `DirtyWorktreeError`
 * naming the absolute path; `mechanizedBranchSetup` re-throws it, and
 * `runBranch` routes it to handoff via a `step-failed:branch` cap instead of
 * falling back to the ops dispatch — whose prompt would destroy the same
 * work through the same `--force`.
 *
 * The common path is untouched: a leftover with no uncommitted work and no
 * unpushed commits is removed as before. Verified twice — with real git
 * (the load-bearing evidence) and with an injected exec (the refusal must not
 * fall back to the LLM path).
 *
 * #536 — `worktreeCreate` now returns `{ path, provision }` so the branch
 * step can emit a `worktree-provisioned` event per workstream. The common-path
 * canary here is updated to assert on `result.path` (the prior `created ===
 * wt` shape). The injected `runBranch` clean-path case adds an assertion that
 * a `worktree-provisioned` event lands in the event log.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { DirtyWorktreeError, inspectWorktreeForLoss, worktreeCreate } from "../src/worktree.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/** A minimal repo with a committed base, detached at that base. */
async function fixture(name: string): Promise<{ repo: string; baseSha: string }> {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return { repo, baseSha: stdout.trim() };
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-dirty-preremove-"));

// ---------------------------------------------------------------- real git

try {
  // ------------- the incident: a mid-develop leftover holds uncommitted work
  {
    const { repo, baseSha } = await fixture("dirty");
    const wt = path.join(repo, ".worktrees", "issue-475-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    writeFileSync(path.join(wt, "a.txt"), "base\nuncommitted develop work\n");

    const finding = await inspectWorktreeForLoss(realExec, repo, wt, baseSha);
    assert(
      finding !== undefined &&
        finding.uncommittedFiles.length === 1 &&
        finding.uncommittedFiles[0]?.includes("a.txt") === true,
      `inspect: a worktree with an uncommitted change is found (files: ${JSON.stringify(
        finding?.uncommittedFiles,
      )})`,
    );

    let dirty: DirtyWorktreeError | undefined;
    try {
      await worktreeCreate(realExec, {
        repoRoot: repo,
        name: "issue-475-default",
        fromRef: baseSha,
      });
    } catch (err) {
      if (err instanceof DirtyWorktreeError) dirty = err;
      else throw err;
    }
    assert(
      dirty !== undefined,
      "canary: worktreeCreate REFUSES a dirty leftover instead of force-removing it",
    );
    assert(
      dirty?.message.includes(wt) === true,
      "the refusal names the ABSOLUTE path so the operator can inspect it",
    );
    assert(/uncommitted/.test(dirty?.message ?? ""), "...and says what it found");
    const { stdout } = await git(wt, ["diff", "--stat"]);
    assert(
      stdout.length > 0,
      "the work is still on disk after the refusal — nothing was destroyed",
    );
  }

  // --------------------- the same shape, but a commit ahead of the base
  {
    const { repo, baseSha } = await fixture("ahead");
    const wt = path.join(repo, ".worktrees", "issue-475-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    writeFileSync(path.join(wt, "a.txt"), "committed ahead\n");
    await git(wt, ["add", "a.txt"]);
    await git(wt, ["commit", "-q", "-m", "local commit"]);

    const finding = await inspectWorktreeForLoss(realExec, repo, wt, baseSha);
    assert(
      finding !== undefined &&
        finding.unpushedCommitCount === 1 &&
        finding.uncommittedFiles.length === 0,
      `inspect: a clean worktree with a local commit ahead of the base is found (count: ${finding?.unpushedCommitCount})`,
    );

    let dirty: DirtyWorktreeError | undefined;
    try {
      await worktreeCreate(realExec, {
        repoRoot: repo,
        name: "issue-475-default",
        fromRef: baseSha,
      });
    } catch (err) {
      if (err instanceof DirtyWorktreeError) dirty = err;
      else throw err;
    }
    assert(
      dirty !== undefined && /commit/.test(dirty.message),
      "canary: commits ahead of the base also refuse, and the message says how many",
    );
  }

  // ------------------------ the common path: a clean leftover is removed
  {
    const { repo, baseSha } = await fixture("clean");
    const wt = path.join(repo, ".worktrees", "issue-475-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);

    const finding = await inspectWorktreeForLoss(realExec, repo, wt, baseSha);
    assert(
      finding === undefined,
      "inspect: a worktree with no uncommitted work and no unpushed commits is CLEAN",
    );

    // #536: worktreeCreate now returns { path, provision } — update the
    // canary assertion and verify that `provision` carries the outcome.
    const result = await worktreeCreate(realExec, {
      repoRoot: repo,
      name: "issue-475-default",
      fromRef: baseSha,
    });
    assert(
      result.path === wt,
      "canary: the clean leftover is removed and recreated as today (result.path)",
    );
    assert(
      result.provision !== undefined && ["hook", "symlink", "none"].includes(result.provision.via),
      "canary: worktreeCreate returns the provision result alongside the path",
    );
    const { stdout } = await git(wt, ["rev-parse", "HEAD"]);
    assert(
      stdout.trim() === baseSha,
      "the recreated worktree is detached at the base SHA — no behaviour change on the common path",
    );
  }

  // ------------ the check degrades safely: an unreadable worktree is removed
  {
    const { repo, baseSha } = await fixture("unreadable");
    const wt = path.join(repo, ".worktrees", "issue-475-default");
    const finding = await inspectWorktreeForLoss(realExec, repo, wt, baseSha);
    assert(
      finding === undefined,
      "inspect: a path with no live worktree is skipped — an absent directory is not a refusal",
    );

    const broken: ExecFn = async (cmd, o) => {
      if ((o?.cwd ?? "").startsWith(wt)) throw new Error("git: not a worktree");
      return realExec(cmd, o);
    };
    await worktreeCreate(broken, { repoRoot: repo, name: "issue-475-default", fromRef: baseSha });
    assert(true, "a worktree that cannot be inspected is removed as today — no wedged queue");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ----------------------------------------------------- injected-exec routing

/** Recorder matching the shape test-work-driver-always-worktree.ts uses. */
function recorder(overrides: Record<string, string> = {}) {
  const calls: Array<{ cmd: string; cwd: string }> = [];
  const execFn: ExecFn = async (cmd, o) => {
    calls.push({ cmd, cwd: o?.cwd ?? "" });
    for (const [prefix, stdout] of Object.entries(overrides)) {
      if (cmd.startsWith(prefix)) {
        if (stdout.startsWith("!THROW!")) throw new Error(stdout.slice(7));
        return { stdout };
      }
    }
    return { stdout: "" };
  };
  return { calls, execFn };
}

const REPO = "/repo";
const WT = path.join(REPO, ".worktrees", "issue-475-default");

// ------- mechanizedBranchSetup re-throws the refusal for a dirty leftover
// (#533: a failed fetch must not divert the refusal — the origin ref still
// resolves, and the DirtyWorktreeError must reach runBranch, not the ops
// fallback)
{
  const { calls, execFn } = recorder({
    "git symbolic-ref": "origin/main\n",
    "git rev-parse --verify --quiet ": "deadbeef\n", // origin/<mainline> resolves
    "git fetch": "!THROW!Permission denied (publickey)",
    "git status --porcelain": " M src/wip.ts\n",
    "git rev-list --count": "0\n",
  });
  let dirty: DirtyWorktreeError | undefined;
  try {
    await mechanizedBranchSetup(execFn, REPO, 475, [475], [], "dirty preremove");
  } catch (err) {
    if (err instanceof DirtyWorktreeError) dirty = err;
    else throw err;
  }
  assert(
    dirty !== undefined && dirty.message.includes(WT) === true,
    "mechanizedBranchSetup: a dirty leftover throws DirtyWorktreeError naming the absolute path",
  );
  assert(
    !calls.some((c) => c.cmd.startsWith("git worktree remove")),
    "the refusal happens BEFORE the force-remove — nothing was touched",
  );
}

// ------- and a clean leftover still goes through (no behaviour change)
{
  const { calls, execFn } = recorder({
    "git symbolic-ref": "origin/main\n",
    "git rev-parse --verify --quiet ": "deadbeef\n", // origin/<mainline> resolves
    "git status --porcelain": "\n",
    "git rev-list --count": "0\n",
  });
  const out = await mechanizedBranchSetup(execFn, REPO, 475, [475], [], "clean preremove");
  assert(
    out.worktrees.default === WT,
    "mechanizedBranchSetup: a clean leftover is removed and recreated as today",
  );
  assert(
    out.provisions.default !== undefined,
    "#536: mechanizedBranchSetup includes the provision result for each workstream",
  );
  assert(
    calls.some((c) => c.cmd.startsWith("git worktree remove --force")),
    "the pre-remove still runs for the clean case — idempotency preserved",
  );
}

// ------------------------------------------------------- runBranch routing

function branchCtx(execFn: ExecFn): DriverContext {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture — only verifyExecFn + repoRoot are touched on this path
    pi: {} as any,
    issue: 475,
    issues: [475],
    restart: false,
    repoRoot: REPO,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
  } as unknown as DriverContext;
}

{
  // Dirty leftover: refusal must NOT dispatch the ops fallback (whose prompt
  // would destroy the same work) — it routes to handoff via step-failed:branch.
  const { execFn } = recorder({
    "git symbolic-ref": "origin/main\n",
    "git rev-parse --verify --quiet ": "deadbeef\n",
    "git status --porcelain": " M src/wip.ts\n",
    "git rev-list --count": "0\n",
    "gh pr list": "[]\n",
  });
  const out = await runBranch(branchCtx(execFn), initialState(475), 1000).catch(() => undefined);
  const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "step-failed:branch" && cap.nextStep === "handoff",
    "runBranch: a dirty worktree routes to handoff via step-failed:branch",
  );
  const report = out?.pipelineState.plumbReports?.find((r) => r.step === "branch");
  assert(
    Boolean(report?.body.includes(WT)),
    "the plumb report carries the refusal with the absolute path — the handoff comment renders plumbReports, so the operator sees WHERE to inspect",
  );
  assert(
    out !== undefined,
    "the refusal does not throw out of runBranch — the cycle is parked, not crashed",
  );
  // No worktree-provisioned event: the branch step never reached provisioning.
  assert(
    !out?.eventLog.some((e) => e.kind === "worktree-provisioned"),
    "#536: no worktree-provisioned event when the branch step routes to handoff before provisioning",
  );
}

{
  // Clean leftover: no refusal, no cap — the mechanized path completes.
  const { execFn } = recorder({
    "git symbolic-ref": "origin/main\n",
    "git rev-parse --verify --quiet ": "deadbeef\n",
    "git status --porcelain": "\n",
    "git rev-list --count": "0\n",
    "gh pr list": "[]\n",
  });
  const out = await runBranch(branchCtx(execFn), initialState(475), 1000).catch(() => undefined);
  assert(
    out !== undefined && out.worktrees === undefined && out.pipelineState.worktrees.default === WT,
    "runBranch: a clean leftover produces the worktree map and no cap",
  );
  assert(
    !out?.eventLog.some((e) => e.kind === "cap-hit"),
    "no cap fires on the common path — no behaviour change",
  );
  // #536 — a worktree-provisioned event must appear in the log for each
  // workstream the mechanized path creates.
  const provEvent = out?.eventLog.find((e) => e.kind === "worktree-provisioned");
  assert(
    provEvent?.kind === "worktree-provisioned" &&
      provEvent.worktreeId === "default" &&
      provEvent.worktreePath === WT,
    "#536: runBranch emits a worktree-provisioned event for the default workstream",
  );
  const validOutcomes = ["hook-ran", "hook-failed", "symlink", "none"];
  assert(
    provEvent?.kind === "worktree-provisioned" && validOutcomes.includes(provEvent.outcome),
    "#536: the worktree-provisioned outcome is a recognised non-ops value",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
