#!/usr/bin/env bun
/**
 * #1170 — the commit-pr integrate step must not treat the cycle's OWN
 * develop worktree as a foreign leftover.
 *
 * The incident: develop commits its change in `.worktrees/issue-<N>-default`
 * (detached). Consolidation commits the same tree under a new SHA on the
 * branch, so the develop commit is tree-identical to the branch head but
 * has a different SHA. The integrate step's sibling scan then read that
 * worktree as "1 unpushed commit" and parked the cycle with
 * `integration-worktree-violation`, opening no PR.
 *
 * Real-git coverage (ensureIntegrateWorktree, the production seam):
 *  1. An in-cycle develop worktree, clean and tree-identical to the branch
 *     head (different SHA) → the integrate worktree is created, no throw.
 *  2. The same in-cycle worktree WITH an uncommitted edit → still refused.
 *  3. An in-cycle worktree whose tree DIFFERS from the branch head → the
 *     integrate step succeeds and does NOT remove it (never force-removed).
 *
 * The cycle's worktrees are read from the state file's pipelineState.worktrees.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureIntegrateWorktree } from "../src/work-driver-integrate-worktree.ts";
import { worktreePath } from "../src/worktree.ts";
import { git, realExecWithStderr as realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const headOf = async (cwd: string) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-tree-equal-"));

/**
 * A real repo: main @ base, branch `feature/issue-17-x` @ A (the consolidated
 * change), and a state file recording the cycle's develop worktree.
 */
async function fixture(name: string, devWorktree: "tree-equal" | "differs") {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = await headOf(repo);

  const branch = "feature/issue-17-x";
  await git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(path.join(repo, "a.txt"), "base\nchange\n");
  await git(repo, ["commit", "-q", "-am", "consolidated change"]);
  await git(repo, ["checkout", "-q", "main"]);

  // The cycle's develop worktree, detached at the base.
  const wt = worktreePath(repo, "issue-17-default");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  if (devWorktree === "tree-equal") {
    // Same tree as the branch head, different SHA — the develop commit that
    // consolidation re-committed under a new SHA.
    writeFileSync(path.join(wt, "a.txt"), "base\nchange\n");
    await git(wt, ["commit", "-q", "-am", "develop"]);
  } else {
    writeFileSync(path.join(wt, "a.txt"), "base\nother change\n");
    await git(wt, ["commit", "-q", "-am", "develop differs"]);
  }

  const stateFile = path.join(repo, ".pi", "work-state", "17.json");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ pipelineState: { worktrees: { default: wt }, branchName: branch, baseSha } }),
  );
  return { repo, baseSha, branch, wt, stateFile };
}

try {
  // 1. tree-identical, clean, in-cycle → proceeds (the #1170 repro)
  {
    const { repo, baseSha, branch, stateFile } = await fixture("tree-equal", "tree-equal");
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        realExec,
        { repoRoot: repo, issue: 17, branchName: branch, baseSha },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(
      err === undefined,
      `a clean tree-identical in-cycle develop worktree does not block the integrate step (${err ? (err as Error).message.split("\n")[0] : "ok"})`,
    );
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(list.includes("issue-17-integrate"), "the integrate worktree was created");
  }

  // 2. tree-identical in-cycle WITH uncommitted edits → still refused
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("dirty-equal", "tree-equal");
    writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        realExec,
        { repoRoot: repo, issue: 17, branchName: branch, baseSha },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof Error && /uncommitted/.test(err.message),
      "an in-cycle worktree with uncommitted edits still refuses the integrate step",
    );
    const { stdout: status } = await git(wt, ["status", "--porcelain"]);
    assert(status.includes("scratch.txt"), "the refused in-cycle worktree's edit is intact");
  }

  // 3. in-cycle, tree DIFFERS from the branch head → not removed
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("differs", "differs");
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        realExec,
        { repoRoot: repo, issue: 17, branchName: branch, baseSha },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(err === undefined, "an in-cycle worktree whose tree differs does not block the step");
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(list.includes(wt), "the in-cycle worktree whose tree differs is NOT removed");
  }
  // 4. an unreadable `git status` in an in-cycle tree keeps the refusal
  // (fail closed — an unreadable tree is not proven clean)
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("unreadable", "tree-equal");
    const failingStatus: typeof realExec = async (cmd, o) => {
      if (cmd.startsWith("git status --porcelain") && o?.cwd === wt) throw new Error("simulated");
      return realExec(cmd, o);
    };
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        failingStatus,
        { repoRoot: repo, issue: 17, branchName: branch, baseSha },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof Error && /could not read/.test(err.message),
      "an unreadable git status in an in-cycle tree keeps the refusal",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
