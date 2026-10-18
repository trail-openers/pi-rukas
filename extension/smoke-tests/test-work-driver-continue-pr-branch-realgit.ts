#!/usr/bin/env bun
/**
 * #1468 — the branch step in `--continue-pr` mode against REAL git: a bare
 * origin, the driver's clone and a second clone that plays the PR author.
 *
 * Clean case: the worktree HEAD is a merge commit with parents [P, M] and
 * ps.baseSha is M. Conflict case: MERGE_HEAD stays and conflictPaths are
 * recorded. A head that moved after the lookup, a local branch ahead of P
 * and an adopted leftover worktree each cap. No case dispatches. Without
 * the flag, runBranch still stops with existing-pr-detected.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { execp } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

gitTestEnv();
process.env.PI_ENSEMBLE_FORGE = "github";
const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", args, { cwd })).stdout.trim();
const ok = async (cwd: string, args: string[]) =>
  execFileP("git", args, { cwd }).then(
    () => true,
    () => false,
  );

async function identity(dir: string) {
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
}

const HEAD = "feature/issue-5-thing";
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1468-branch-"));
let n = 0;

/** origin with main at M and HEAD at P (P branches off main's parent). */
async function fixture(conflict: boolean) {
  const dir = path.join(root, `case-${++n}`);
  const origin = path.join(dir, "origin.git");
  const author = path.join(dir, "author");
  const repo = path.join(dir, "repo");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["clone", "-q", origin, author]);
  await identity(author);
  await git(author, ["checkout", "-q", "-b", "main"]);
  writeFileSync(path.join(author, "a.txt"), "base\n");
  await git(author, ["add", "."]);
  await git(author, ["commit", "-q", "-m", "base"]);
  await git(author, ["push", "-q", "origin", "main"]);
  await execFileP("git", ["clone", "-q", origin, repo]);
  await identity(repo);
  await git(author, ["checkout", "-q", "-b", HEAD]);
  writeFileSync(path.join(author, conflict ? "a.txt" : "b.txt"), "pr side\n");
  await git(author, ["add", "."]);
  await git(author, ["commit", "-q", "-m", "pr work"]);
  await git(author, ["push", "-q", "origin", HEAD]);
  const P = await git(author, ["rev-parse", "HEAD"]);
  await git(author, ["checkout", "-q", "main"]);
  writeFileSync(path.join(author, conflict ? "a.txt" : "c.txt"), "main side\n");
  await git(author, ["add", "."]);
  await git(author, ["commit", "-q", "-m", "main moves"]);
  await git(author, ["push", "-q", "origin", "main"]);
  const M = await git(author, ["rev-parse", "HEAD"]);
  return { repo, author, P, M };
}

function ctxFor(
  repo: string,
  headRefOid: string,
  dispatched: string[],
  continuePr = true,
): CycleContext {
  const row = {
    number: 77,
    headRefName: HEAD,
    headRefOid,
    baseRefName: "main",
    isCrossRepository: false,
    headRepository: { name: "repo" },
    body: "Fixes #5",
  };
  const verifyExecFn: VerifyExecFn = async (cmd, opts) => {
    if (cmd === "gh" || cmd.startsWith("gh ")) return { stdout: JSON.stringify([row]) };
    return execp(cmd, opts);
  };
  return {
    repoRoot: repo,
    issue: 5,
    continuePr,
    verifyExecFn,
    emitSink: () => {},
    dispatchFn: async () => {
      dispatched.push("dispatch");
      throw new Error("the continue branch step must not dispatch");
    },
  } as unknown as CycleContext;
}

function capOf(state: WorkState): string | undefined {
  const hit = state.eventLog.findLast((e) => e.kind === "cap-hit");
  return hit?.kind === "cap-hit" ? hit.cap : undefined;
}

try {
  {
    const { repo, P, M } = await fixture(false);
    const dispatched: string[] = [];
    const out = await runBranch(ctxFor(repo, P, dispatched), initialState(5), 1000);
    const ps = out.pipelineState;
    const wt = ps.worktrees?.default ?? "";
    assert(capOf(out) === undefined, "clean: no cap");
    const parents = wt
      ? (await git(wt, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" ")
      : [];
    assert(
      parents[1] === P && parents[2] === M,
      "clean: the worktree HEAD is a merge commit with parents [P, M]",
    );
    assert(ps.baseSha === M, "clean: ps.baseSha is M");
    assert(
      Object.keys(ps.worktrees ?? {}).join() === "default" &&
        ps.workstreamBaseShas?.default === M &&
        ps.workstreams === undefined,
      "clean: worktrees and workstreamBaseShas are {default}, workstreams cleared",
    );
    assert(ps.branchName === HEAD && ps.prNumber === 77, "clean: branchName and prNumber");
    assert(
      ps.continuedPr?.headSha === P &&
        ps.continuedPr.mainlineSha === M &&
        ps.continuedPr.conflictPaths.length === 0 &&
        ps.continuedPr.number === 77,
      "clean: continuedPr records P, M and no conflicts",
    );
    assert(
      (await git(repo, ["rev-parse", `refs/heads/${HEAD}`])) === P,
      "clean: local branch is P",
    );
    assert(
      out.eventLog.some((e) => e.kind === "step-started" && e.step === "branch") &&
        out.eventLog.some((e) => e.kind === "worktree-provisioned"),
      "clean: step-started and provision events",
    );
    assert(dispatched.length === 0, "clean: zero dispatches");
  }

  {
    const { repo, P } = await fixture(true);
    const dispatched: string[] = [];
    const out = await runBranch(ctxFor(repo, P, dispatched), initialState(5), 1000);
    const wt = out.pipelineState.worktrees?.default ?? "";
    assert(capOf(out) === undefined, "conflict: no cap");
    assert(
      wt !== "" && (await ok(wt, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])),
      "conflict: MERGE_HEAD is present in the worktree",
    );
    assert(
      out.pipelineState.continuedPr?.conflictPaths.join() === "a.txt",
      "conflict: conflictPaths records a.txt",
    );
    assert(dispatched.length === 0, "conflict: zero dispatches");
  }

  {
    const { repo, author, P } = await fixture(false);
    await git(author, ["checkout", "-q", HEAD]);
    writeFileSync(path.join(author, "d.txt"), "late\n");
    await git(author, ["add", "."]);
    await git(author, ["commit", "-q", "-m", "late push"]);
    await git(author, ["push", "-q", "origin", HEAD]);
    const dispatched: string[] = [];
    const out = await runBranch(ctxFor(repo, P, dispatched), initialState(5), 1000);
    assert(capOf(out) === "continue-pr-head-moved", "moved after the lookup: head-moved");
    assert(
      !(await ok(repo, ["rev-parse", "--verify", `refs/heads/${HEAD}`])),
      "moved: no local branch",
    );
    assert(dispatched.length === 0, "moved: zero dispatches");
  }

  {
    const { repo, P } = await fixture(false);
    await git(repo, ["fetch", "-q", "origin", HEAD]);
    await git(repo, ["checkout", "-q", "-b", HEAD, `origin/${HEAD}`]);
    writeFileSync(path.join(repo, "e.txt"), "local only\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "local only"]);
    const ahead = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "main"]);
    const dispatched: string[] = [];
    const out = await runBranch(ctxFor(repo, P, dispatched), initialState(5), 1000);
    assert(capOf(out) === "continue-pr-unsafe-head", "local branch ahead: unsafe-head");
    assert(
      (await git(repo, ["rev-parse", `refs/heads/${HEAD}`])) === ahead,
      "ahead: the local branch is untouched",
    );
    assert(dispatched.length === 0, "ahead: zero dispatches");
  }

  {
    const { repo, P } = await fixture(false);
    await git(repo, [
      "worktree",
      "add",
      "-q",
      "--detach",
      ".worktrees/issue-5-default",
      "origin/main",
    ]);
    const dispatched: string[] = [];
    const out = await runBranch(ctxFor(repo, P, dispatched), initialState(5), 1000);
    assert(capOf(out) === "step-failed:branch", "adopted leftover worktree: step-failed:branch");
    assert(out.pipelineState.continuedPr === undefined, "residue: nothing recorded");
    assert(dispatched.length === 0, "residue: zero dispatches");
  }

  {
    const { repo, P } = await fixture(false);
    const dispatched: string[] = [];
    const out = await runBranch(ctxFor(repo, P, dispatched, false), initialState(5), 1000);
    assert(
      capOf(out) === "existing-pr-detected",
      "no flag: runBranch still gives existing-pr-detected",
    );
    assert(dispatched.length === 0, "no flag: zero dispatches");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
