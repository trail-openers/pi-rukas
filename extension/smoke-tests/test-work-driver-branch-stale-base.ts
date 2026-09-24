#!/usr/bin/env bun
/**
 * #844 — `/work N --restart` reuses a stale local feature branch left by a
 * previous cycle as its base, instead of branching from fresh origin/main.
 *
 * The incident (#830): a parked cycle left a local feature branch at the
 * then-current main tip. A later merge moved origin/main forward. `--restart`
 * wiped the state file but not the local branch, so the restarted cycle's
 * branch step resolved baseSha to the old local ref and every workstream
 * worktree was created at the stale SHA. The PR would have silently reverted
 * merged work.
 *
 * Now: the branch step (mechanizedBranchSetup) inspects an existing local
 * branch of the resolved name BEFORE any worktree is created:
 *
 *  - a local branch that does NOT contain the freshly-fetched
 *    `origin/<mainline>` (behind, or diverged with everything merged) is
 *    force-moved to baseSha via `git update-ref` (works even when the
 *    branch is checked out at repoRoot) and a `branch-reset` event records
 *    the old tip SHA (recovery handle) and the new tip (= baseSha);
 *  - a local branch that IS ahead of the freshly-fetched base (unpushed
 *    work — only a human can decide what to do with it) halts the step
 *    with a `branch-ahead:<N>` cap naming the branch and its ahead count;
 *    nothing is reset and NO ops fallback runs (whose mainline guard would
 *    not catch this shape).
 *
 * The tests use REAL git (a bare "origin" on disk) because the whole point
 * is that git does the right thing — a mocked exec cannot prove that
 * `update-ref` moves a checked-out branch, or that `merge-base
 * --is-ancestor` exits correctly on a diverged branch.
 *
 * Branch name: the driver's `branchSlug` uses `issueBodyArtifact` to
 * derive the brief. The test provides a stub artifact so the slug matches
 * the local branch name the fixture creates.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";
import {
  BranchAheadError,
  branchSlug,
  mechanizedBranchSetup,
} from "../src/work-driver-branch-mechanized.ts";
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

/** Real shell exec, matching the driver's ExecFn contract. */
const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const TITLE = "stale branch reset ahead halt";
const BRANCH = branchSlug([844], TITLE);
// Stub issue body artifact so cachedIssueTitle() returns TITLE and
// the driver's branchSlug matches the local branch the fixture creates.
const TITLE_ARTIFACT = "/tmp/pi-ens-844-issue-title.txt";
writeFileSync(TITLE_ARTIFACT, `title: ${TITLE}\n`);

async function fixture(name: string) {
  const root = path.join(rootBase, name);
  const originDir = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  mkdirSync(root, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout: firstSha } = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  return {
    repo,
    originDir,
    firstSha: firstSha.trim(),
    advanceOrigin: async (fileContent: string, msg: string) => {
      writeFileSync(path.join(repo, "b.txt"), fileContent);
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-q", "-m", msg]);
      await git(repo, ["push", "-q", "origin", "main"]);
      const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
      return stdout.trim();
    },
  };
}

const rootBase = mkdtempSync(path.join(tmpdir(), "pi-ens-844-"));

/** Build a driver context for runBranch with real git + stubbed gh. */
function makeCtx(repo: string, execFn: ExecFn) {
  const noopDispatch = async () => ({
    role: "ops",
    ok: true,
    text: "noop",
    toolUses: [],
    ms: 0,
    exitCode: 0,
  });
  return {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture
    pi: {} as any,
    issue: 844,
    issues: [844],
    restart: true,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn: noopDispatch,
  } as unknown as import("../src/work-driver-context.ts").DriverContext;
}

/**
 * Build initialState with an issueBodyArtifact so cachedIssueTitle
 * returns TITLE and the branch slug includes the brief.
 */
function makeState(): WorkState {
  const st = initialState(844);
  st.pipelineState.issueBodyArtifact = TITLE_ARTIFACT;
  return st;
}

try {
  // ----------------------------------------------------------------
  // 1. Stale local branch (behind origin/main) → reset, branch-reset event
  // ----------------------------------------------------------------
  {
    const { repo, firstSha, advanceOrigin } = await fixture("stale-behind");
    await git(repo, ["branch", BRANCH, firstSha]);
    const newSha = await advanceOrigin("advanced\n", "advance main");

    const setup = await mechanizedBranchSetup(realExec, repo, 844, [844], [], TITLE);
    assert(setup.baseSha === newSha, `baseSha == freshly-fetched origin/main tip (${newSha.slice(0, 8)})`);
    assert(setup.branchName === BRANCH, `branchName is the resolved slug (${BRANCH})`);
    {
      const { stdout } = await git(repo, ["rev-parse", BRANCH]);
      assert(stdout.trim() === newSha, `local branch was force-moved from ${firstSha.slice(0, 8)} to ${newSha.slice(0, 8)}`);
    }
    {
      const wt = setup.worktrees.default ?? "";
      if (wt) {
        const { stdout } = await git(wt, ["rev-parse", "HEAD"]);
        assert(stdout.trim() === newSha, "worktree is detached at the freshly-fetched base");
      }
    }
    assert(setup.resetFromSha === firstSha, `resetFromSha records the pre-reset old tip (${firstSha.slice(0, 8)})`);
  }

  // ----------------------------------------------------------------
  // 2. Local branch checked out at repoRoot → reset (update-ref)
  // ----------------------------------------------------------------
  {
    const { repo, firstSha, advanceOrigin } = await fixture("stale-checked-out");
    await git(repo, ["branch", BRANCH, firstSha]);
    await git(repo, ["checkout", "-q", BRANCH]);
    await git(repo, ["checkout", "-q", "main"]);
    const newSha = await advanceOrigin("advanced\n", "advance main");

    const setup = await mechanizedBranchSetup(realExec, repo, 844, [844], [], TITLE);
    {
      const { stdout } = await git(repo, ["rev-parse", BRANCH]);
      assert(stdout.trim() === newSha, "a stale branch CHECKED OUT at repoRoot is also reset (update-ref)");
    }
    assert(setup.resetFromSha === firstSha, "resetFromSha records the old tip even when the branch is checked out");
  }

  // ----------------------------------------------------------------
  // 3. Local branch AHEAD of origin/main → BranchAheadError, no reset
  // ----------------------------------------------------------------
  {
    const { repo } = await fixture("ahead");
    await git(repo, ["checkout", "-q", "-b", BRANCH]);
    writeFileSync(path.join(repo, "c.txt"), "unpushed\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "unpushed work"]);
    const oldAheadSha = (await git(repo, ["rev-parse", BRANCH])).stdout.trim();
    await git(repo, ["checkout", "-q", "main"]);

    let threw = false;
    let aheadErr: BranchAheadError | undefined;
    try {
      await mechanizedBranchSetup(realExec, repo, 844, [844], [], TITLE);
    } catch (err) {
      threw = true;
      if (err instanceof BranchAheadError) aheadErr = err;
    }
    assert(threw, "a local branch ahead of origin/main throws BranchAheadError");
    assert(aheadErr?.branchName === BRANCH, `the error names the branch (${BRANCH})`);
    assert(aheadErr?.aheadCount === 1, "the error carries the ahead count (1)");
    {
      const { stdout } = await git(repo, ["rev-parse", BRANCH]);
      assert(stdout.trim() === oldAheadSha, "nothing was reset — the ahead branch's tip is unchanged");
    }
  }

  // ----------------------------------------------------------------
  // 4. Rebase-able branch (all commits in origin/main) → reset, not halt
  // ----------------------------------------------------------------
  {
    const { repo, advanceOrigin } = await fixture("rebaseable");
    const midSha = await advanceOrigin("merged work\n", "the merged work");
    await git(repo, ["branch", BRANCH, midSha]);
    const newSha = await advanceOrigin("more main\n", "main continues");
    assert(newSha !== midSha, "fixture built: branch at mid-tip, origin/main one past it");
    const isAncestor = await git(repo, ["merge-base", "--is-ancestor", BRANCH, "origin/main"])
      .then(() => true)
      .catch(() => false);
    assert(isAncestor, "sanity: the branch's tip IS an ancestor of origin/main");
    const setup = await mechanizedBranchSetup(realExec, repo, 844, [844], [], TITLE);
    {
      const { stdout } = await git(repo, ["rev-parse", BRANCH]);
      assert(stdout.trim() === newSha, "a branch whose commits are all in origin/main is RESET (rebase-able), not halted");
    }
    assert(setup.resetFromSha === midSha, "resetFromSha records the old tip for the rebase-able case");
  }

  // ----------------------------------------------------------------
  // 5. No existing local branch → no reset (normal path)
  // ----------------------------------------------------------------
  {
    const { repo, advanceOrigin } = await fixture("fresh");
    const newSha = await advanceOrigin("advanced\n", "advance main");
    const setup = await mechanizedBranchSetup(realExec, repo, 844, [844], [], TITLE);
    assert(setup.baseSha === newSha, "a fresh cycle resolves baseSha from origin/main");
    assert(setup.resetFromSha === undefined, "no resetFromSha when no existing local branch was touched");
  }

  // ----------------------------------------------------------------
  // 6. Local branch already AT the fresh base → no reset needed
  // ----------------------------------------------------------------
  {
    const { repo, firstSha } = await fixture("at-base");
    await git(repo, ["branch", BRANCH, firstSha]);
    const setup = await mechanizedBranchSetup(realExec, repo, 844, [844], [], TITLE);
    assert(setup.resetFromSha === undefined, "no resetFromSha when the local branch is already at the base");
  }

  // ----------------------------------------------------------------
  // 7. runBranch end-to-end: stale branch → branch-reset event in log
  // ----------------------------------------------------------------
  {
    const { repo, firstSha, advanceOrigin } = await fixture("runbranch");
    await git(repo, ["branch", BRANCH, firstSha]);
    const newSha = await advanceOrigin("advanced\n", "advance main");

    const execFn: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("gh ")) return { stdout: "[]" };
      if (cmd.startsWith("git fetch")) return { stdout: "" };
      return realExec(cmd, o);
    };
    const ctx = makeCtx(repo, execFn);

    const { runBranch } = await import("../src/work-driver-branch-develop.ts");
    const out = await runBranch(ctx, makeState(), 1000).catch((e) => {
      console.error(`runBranch threw: ${(e as Error).message}`);
      return undefined;
    });
    assert(out !== undefined, "runBranch does not throw for a stale-behind branch");
    const resetEvent = out?.eventLog.find((e) => e.kind === "branch-reset");
    assert(resetEvent !== undefined, "a branch-reset event is recorded in the event log");
    if (resetEvent?.kind === "branch-reset") {
      assert(resetEvent.oldSha === firstSha, "branch-reset event carries the OLD tip SHA (recovery handle)");
      assert(resetEvent.newSha === newSha, "branch-reset event carries the NEW tip SHA (= freshly-fetched base)");
      assert(resetEvent.branch === BRANCH, `branch-reset event names the branch (${BRANCH})`);
    }
    const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(cap === undefined, "no cap-hit for a stale-behind branch (the cycle proceeds after reset)");
  }

  // ----------------------------------------------------------------
  // 8. runBranch end-to-end: ahead branch → cap-hit, no reset, no fallback
  // ----------------------------------------------------------------
  {
    const { repo } = await fixture("runbranch-ahead");
    await git(repo, ["checkout", "-q", "-b", BRANCH]);
    writeFileSync(path.join(repo, "c.txt"), "unpushed\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "unpushed work"]);
    const aheadSha = (await git(repo, ["rev-parse", BRANCH])).stdout.trim();
    await git(repo, ["checkout", "-q", "main"]);

    const execFn: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("gh ")) return { stdout: "[]" };
      if (cmd.startsWith("git fetch")) return { stdout: "" };
      return realExec(cmd, o);
    };
    const ctx = makeCtx(repo, execFn);

    const { runBranch } = await import("../src/work-driver-branch-develop.ts");
    const out = await runBranch(ctx, makeState(), 1000).catch((e) => {
      console.error(`runBranch threw: ${(e as Error).message}`);
      return undefined;
    });
    assert(out !== undefined, "runBranch does not throw for an ahead branch (returns a cap)");
    const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(cap !== undefined && cap.kind === "cap-hit", "a cap-hit is recorded for an ahead branch");
    if (cap?.kind === "cap-hit") {
      assert(cap.cap.startsWith("branch-ahead:"), `the cap is a branch-ahead cap (got: ${cap.cap})`);
      assert(cap.nextStep === "handoff", "the ahead cap routes to handoff (not ops fallback)");
    }
    const resetEvent = out?.eventLog.find((e) => e.kind === "branch-reset");
    assert(resetEvent === undefined, "no branch-reset event for an ahead branch (nothing was reset)");
    {
      const { stdout } = await git(repo, ["rev-parse", BRANCH]);
      assert(stdout.trim() === aheadSha, "the ahead branch's tip is unchanged (nothing was reset)");
    }
  }

  // ----------------------------------------------------------------
  // 9. handoff-consolidate (PM decision 0/1): stale local branch +
  //    fresh-base workstream worktree → the existing local branch is
  //    reset to the freshly-fetched origin/main before the pick, so the
  //    consolidated merge-base equals origin/main, not the stale tip.
  // ----------------------------------------------------------------
  {
    const { repo, firstSha, advanceOrigin } = await fixture("handoff-stale");
    await git(repo, ["branch", BRANCH, firstSha]);
    const newSha = await advanceOrigin("handoff-advance\n", "main advances again");
    // A workstream worktree with one commit on the FRESH base — the parked
    // cycle's shape: work at newSha while the local branch is at firstSha.
    const wt = path.join(repo, ".worktrees", "task-a-wt");
    await git(repo, ["worktree", "add", "--detach", "-q", wt, newSha]);
    writeFileSync(path.join(wt, "note.txt"), "consolidated work\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", "workstream work"]);

    const { reconcileHandoffConsolidateBranch } = await import(
      "../src/work-driver-handoff-consolidate-branch.ts"
    );
    const resetFrom = await reconcileHandoffConsolidateBranch(realExec, repo, BRANCH);
    assert(resetFrom === firstSha, `the stale local branch was force-moved to the freshly-fetched origin/main (old tip ${firstSha.slice(0, 8)} recorded)`);
    {
      const { stdout } = await git(repo, ["rev-parse", BRANCH]);
      assert(stdout.trim() === newSha, "the stale local branch is now at the freshly-fetched origin/main");
    }
    {
      const { stdout } = await git(repo, ["merge-base", `refs/heads/${BRANCH}`, newSha]);
      assert(stdout.trim() === newSha, `the consolidated branch's merge-base equals origin/main (${newSha.slice(0, 8)}), not the stale tip`);
    }
    {
      const { stdout } = await git(repo, ["status", "--porcelain"]);
      const dirt = stdout.split("\n").filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l));
      assert(
        dirt.length === 0,
        `repoRoot is clean after reconciliation (dirt: ${dirt.join(", ")})`,
      );
    }
    await git(repo, ["worktree", "remove", "-f", wt]).catch(() => {});
  }
} finally {
  rmSync(rootBase, { recursive: true, force: true });
  try { rmSync(TITLE_ARTIFACT, { force: true }); } catch { /* ignore */ }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
