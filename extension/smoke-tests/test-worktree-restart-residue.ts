#!/usr/bin/env bun
/**
 * #730 — `/work N --restart` against a repo carrying the previous cycle's
 * worktrees (and local feature branch) must PROCEED, not abort.
 *
 * The incident: #724's parked cycle left `.worktrees/issue-724-task-*`
 * (two of them) plus a committed multi-commit worktree; the `--restart`
 * wiped only the state file, so the restarted cycle's `worktree add`
 * collided with the residue and the branch step failed before creating
 * anything. Residue also survived a MERGED cycle (#723) because only
 * runMerged tore worktrees down.
 *
 * Now: the branch step runs a same-issue residue pass BEFORE the
 * mechanized setup (worktree-leftover.ts), which scans the worktree
 * list DIRECTLY (not the state-file-keyed sweep — the sweep's
 * `${name}.json` lookup can never match, state files are keyed by issue
 * number) and, per leftover:
 *
 *  - adopts a CLEAN leftover at the cycle's own target path (reused
 *    knowingly, re-provisioned);
 *  - PRESERVES a dirty leftover (salvage patch into the cycle's scratch
 *    dir + a durable `pi-rukas-salvage/<name>/<ts>` tag on its HEAD)
 *    BEFORE `git worktree remove --force`;
 *  - removes a clean non-adoptable leftover (nothing to preserve).
 *
 * The pass is scoped to the cycle's own issue — a concurrent cycle's
 * `.worktrees/issue-<M>-*` (M ≠ N) is never touched. Unremovable dirty
 * leftovers are left in place (the existing #475/#545 refusal still
 * fires with the full finding — the degradation direction is safe).
 *
 * Coverage:
 *  1. Real-git unit: the #724 incident shape — 3 worktrees for one issue
 *     (N>1 fan-out), one with uncommitted work, one with 2 commits ahead,
 *     one clean. The pass preserves + removes, adopts the target, keeps
 *     the durable tag, and never touches a foreign issue's worktree.
 *  2. runBranch end-to-end (injected exec, real mechanics): a pre-existing
 *     same-issue worktree + state wipe → the branch step PROCEEDS (the
 *     acceptance criterion the #545 test explicitly lacked).
 *  3. runBranch with a dirty same-issue leftover the pass cannot adopt
 *     (a DIFFERENT id than the cycle's target) → preserved + removed,
 *     the branch proceeds.
 *  4. Foreign-issue leftover untouched.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { findSameIssueLeftovers, handleSameIssueLeftovers } from "../src/worktree-leftover.ts";
import {
  type ExecFn,
  findDirtySameIssueLeftover,
  worktreeList,
  worktreePath,
} from "../src/worktree.ts";

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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-730-restart-"));

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

try {
  // =============== 1. real git — the #724 incident shape (3 worktrees)
  {
    const { repo, baseSha } = await fixture("incident");
    const scratch = path.join(repo, "tmp", "issue-724");
    mkdirSync(scratch, { recursive: true });
    const wtBacktest = path.join(repo, ".worktrees", "issue-724-task-backtest");
    const wtFormula = path.join(repo, ".worktrees", "issue-724-task-formula");
    const wtTests = path.join(repo, ".worktrees", "issue-724-task-tests");
    await git(repo, ["worktree", "add", "-q", "--detach", wtBacktest, baseSha]);
    await git(repo, ["worktree", "add", "-q", "--detach", wtFormula, baseSha]);
    await git(repo, ["worktree", "add", "-q", "--detach", wtTests, baseSha]);
    // dirty: uncommitted work
    writeFileSync(path.join(wtBacktest, "a.txt"), "base\nmid-develop work\n");
    writeFileSync(path.join(wtBacktest, "new.txt"), "untracked work\n");
    // dirty: 2 commits ahead (the #728 hazard shape)
    // Two commits via the worktree's own index.
    writeFileSync(path.join(wtTests, "a.txt"), "base\ntest work 1\n");
    await git(wtTests, ["add", "."]);
    await git(wtTests, ["commit", "-q", "-m", "w1"]);
    writeFileSync(path.join(wtTests, "b.txt"), "more work\n");
    await git(wtTests, ["add", "."]);
    await git(wtTests, ["commit", "-q", "-m", "w2"]);
    const headOf = async (wt: string) => (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const testsHeadBefore = await headOf(wtTests);

    // The #724 incident shape is genuinely 2 commits ahead of the base —
    // the durable-tag + preservation path must hold for a multi-commit
    // worktree, not just a single dirty one. Assert it explicitly.
    const { stdout: testsAheadCount } = await git(wtTests, [
      "rev-list",
      "--count",
      `${baseSha}..HEAD`,
    ]);
    assert(
      testsAheadCount.trim() === "2",
      `the committed sibling really IS 2 commits ahead of the base (got ${testsAheadCount.trim()})`,
    );

    // A concurrent cycle for a DIFFERENT issue owns its own worktrees.
    const wtForeign = path.join(repo, ".worktrees", "issue-725-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wtForeign, baseSha]);
    writeFileSync(path.join(wtForeign, "a.txt"), "foreign uncommitted work\n");

    // The cycle's own target (default) — the adopt path.
    const wtTarget = worktreePath(repo, "issue-724-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wtTarget, baseSha]);

    const res = await handleSameIssueLeftovers(
      realExec,
      repo,
      baseSha,
      [724],
      scratch,
      realpathSync(worktreePath(repo, "issue-724-default")),
    );
    const byName = (n: string) => res.actions.find((a) => a.leftover.name === n);

    // target: adopted (reused knowingly), not removed
    const adopt = byName("issue-724-default");
    assert(
      adopt?.action === "adopt",
      `the cycle's own clean target worktree is ADOPTED (reused) — got: ${JSON.stringify(adopt?.action)}`,
    );
    const { stdout: afterList } = await git(repo, ["worktree", "list"]);
    assert(
      afterList.includes("issue-724-default"),
      "the adopted worktree is still on disk (reused, not removed)",
    );

    // clean sibling: removed, nothing to preserve
    const formula = byName("issue-724-task-formula");
    assert(
      formula?.action === "removed" && formula.refs.length === 0,
      "a clean non-adoptable sibling is removed with no refs (nothing to preserve)",
    );
    assert(!afterList.includes("issue-724-task-formula"), "the clean sibling is gone");

    // dirty uncommitted sibling: preserved (patch) then removed
    const backtest = byName("issue-724-task-backtest");
    assert(
      backtest?.action === "removed" && backtest.preserved !== false,
      "a dirty uncommitted sibling is removed after preservation",
    );
    const salvageDir = path.join(scratch, "salvage", "issue-724-task-backtest");
    const patch = readFileSync(path.join(salvageDir, "salvage.patch"), "utf8");
    assert(
      patch.includes("mid-develop work"),
      "the salvage patch carries the uncommitted diff (work is preserved)",
    );
    const untracked = readFileSync(path.join(salvageDir, "untracked.txt"), "utf8");
    assert(untracked.includes("new.txt"), "the untracked manifest names the new file");
    assert(!afterList.includes("issue-724-task-backtest"), "the dirty sibling is removed");

    // dirty committed sibling: durable tag BEFORE removal
    const tests = byName("issue-724-task-tests");
    assert(
      tests?.action === "removed" && tests.refs.length === 1,
      `a committed (unpushed) sibling gets exactly one durable ref — got ${tests?.refs.length} refs`,
    );
    const tag = tests?.refs[0]?.split(" → ")[0] ?? "";
    assert(
      tag.startsWith("pi-rukas-salvage/issue-724-task-tests"),
      `the durable ref is a pi-rukas-salvage tag (${tag})`,
    );
    const tagSha = await gitOut(repo, ["rev-parse", `${tag}^{commit}`]).catch(() => "");
    assert(
      tagSha.trim() === testsHeadBefore,
      "the tag points at the worktree's pre-removal HEAD (the work is recoverable)",
    );
    assert(!afterList.includes("issue-724-task-tests"), "the committed sibling is removed");

    // foreign issue: untouched — still attached, still dirty
    const foreignList = afterList.includes("issue-725-default");
    assert(foreignList, "a DIFFERENT issue's worktree is NOT touched (still attached)");
    const { stdout: foreignStatus } = await git(wtForeign, ["status", "--porcelain"]);
    assert(foreignStatus.length > 0, "the foreign worktree's uncommitted work is intact");

    // the #475 refusal is now impossible for handled residue: the pass
    // consumed the dirty siblings, so the branch step's own scan finds none.
    const leftoverScan = await findDirtySameIssueLeftover(
      realExec,
      repo,
      baseSha,
      "issue-724",
      "x",
    );
    assert(
      leftoverScan === undefined,
      "after the pass, the branch step's own dirty-sibling scan is clean (no collision)",
    );
  }

  // =============== 2. runBranch end-to-end — the acceptance criterion
  // Pre-existing same-issue worktree + wiped state (restart) → the branch
  // step PROCEEDS (worktrees populated) instead of aborting.
  {
    const { repo, baseSha } = await fixture("restart");
    const scratch = path.join(repo, "tmp", "issue-730");
    mkdirSync(scratch, { recursive: true });
    // Pre-existing residue: a dirty same-issue task worktree from a parked
    // cycle, and the cycle's own target path is FREE (the incident's
    // N=1 default case — the target is created by the branch step itself).
    const wtLeftover = path.join(repo, ".worktrees", "issue-730-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wtLeftover, baseSha]);
    writeFileSync(path.join(wtLeftover, "a.txt"), "base\nparked work\n");

    // Injected exec that delegates to REAL git in the fixture repo (the
    // residue pass and mechanized setup both run against it), with the
    // branch pre-flight's `gh pr list` short-circuited to "none".
    const execFn: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("gh ")) return { stdout: "" };
      if (cmd.startsWith("git fetch")) return { stdout: "" };
      return realExec(cmd, o);
    };
    const noopDispatch = async (): Promise<DispatchResult> => ({
      role: "ops",
      ok: true,
      text: "noop",
      toolUses: [],
      ms: 0,
      exitCode: 0,
    });
    const ctx = {
      // biome-ignore lint/suspicious/noExplicitAny: driver fixture
      pi: {} as any,
      issue: 730,
      issues: [730],
      restart: true,
      repoRoot: repo,
      model: undefined,
      labelOverride: undefined,
      verifyExecFn: execFn,
      dispatchFn: noopDispatch,
    } as unknown as DriverContext;

    const out = await runBranch(ctx, initialState(730), 1000).catch((e) => {
      console.error(`runBranch threw: ${(e as Error).message}`);
      return undefined;
    });
    assert(out !== undefined, "the restarted cycle's branch step does NOT throw");
    const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      cap === undefined,
      "NO step-failed:branch cap — the restart PROCEEDS instead of aborting",
    );
    const wts = out?.pipelineState.worktrees ?? {};
    const target = worktreePath(repo, "issue-730-default");
    assert(
      wts.default === target && wts.default !== undefined,
      `the branch step created/adopted its target worktree (${target})`,
    );
    assert(
      Boolean(out?.pipelineState.branchName?.startsWith("feature/issue-730")),
      `the branch name is recorded (${out?.pipelineState.branchName})`,
    );
    const salvageNote = out?.eventLog
      .filter((e) => e.kind === "plumb-report")
      .map((e) => (e as { body?: string }).body ?? "")
      .join("\n");
    assert(
      salvageNote.includes("issue-730-task-a"),
      "the plumb report NAMES the removed leftover (which it did)",
    );
    const leftoverEvent = out?.eventLog.find((e) => e.kind === "worktree-leftover-handled");
    assert(
      leftoverEvent?.kind === "worktree-leftover-handled" &&
        leftoverEvent.path.endsWith("issue-730-task-a"),
      "a worktree-leftover-handled event records the per-leftover disposition",
    );
    // the dirty leftover was preserved before removal
    const salvagePatch = path.join(scratch, "salvage", "issue-730-task-a", "salvage.patch");
    assert(
      readFileSync(salvagePatch, "utf8").includes("parked work"),
      "the dirty leftover's uncommitted diff was salvaged before removal",
    );
    // the worktree is actually gone
    const finalList = await worktreeList(execFn, repo);
    assert(!finalList.includes("issue-730-task-a"), "the leftover worktree is removed");
  }

  // =============== 3. adoption: a clean leftover AT the target path
  {
    const { repo, baseSha } = await fixture("adopt");
    const scratch = path.join(repo, "tmp", "issue-730");
    mkdirSync(scratch, { recursive: true });
    const wtTarget = worktreePath(repo, "issue-730-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wtTarget, baseSha]);
    const adoptable = realpathSync(wtTarget);

    const res = await handleSameIssueLeftovers(realExec, repo, baseSha, [730], scratch, adoptable);
    assert(
      res.actions.length === 1 && res.actions[0]?.action === "adopt",
      "a CLEAN leftover at the cycle's own target path is adopted (not removed)",
    );
    assert(res.unresolved.length === 0, "nothing is left unresolved");
  }

  // =============== 4. scoping: the foreign issue is never even scanned
  {
    const { repo, baseSha } = await fixture("scope");
    const wtForeign = path.join(repo, ".worktrees", "issue-999-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wtForeign, baseSha]);
    const scratch = path.join(repo, "tmp", "issue-730");
    mkdirSync(scratch, { recursive: true });
    const leftovers = await findSameIssueLeftovers(realExec, repo, baseSha, [730]);
    assert(leftovers.length === 0, "scanning for issue 730 sees ZERO of issue 999's worktrees");
    const foreignLeftovers = await findSameIssueLeftovers(realExec, repo, baseSha, [999]);
    assert(
      foreignLeftovers.length === 1,
      "…but scanning for issue 999 sees exactly its own (scoping is per-issue)",
    );
    const res = await handleSameIssueLeftovers(realExec, repo, baseSha, [730], scratch);
    assert(res.actions.length === 0, "the pass for issue 730 takes no action on issue 999");
    const { stdout: list } = await git(repo, ["worktree", "list"]);
    assert(list.includes("issue-999-default"), "the foreign worktree is still attached");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
