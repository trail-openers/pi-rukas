#!/usr/bin/env bun
/**
 * #1396 (six-lens round 3) — the halt report names the sha the per-issue backup
 * ref just superseded, and the recovery hint it carries is one the operator can
 * actually follow.
 *
 * `refs/pi-rukas/integrate-backup/issue-<N>` is ONE ref per issue, replaced in
 * place by `git update-ref`. A re-entry that overwrites a different sha leaves
 * the older commit named by nothing, and the tree that held it has already been
 * force-removed — so the halt body is the only place the operator can learn it
 * existed. Two things this pins, both from the adversarial round:
 *
 *   1. the superseded sha is IN the halt plumb body (not only the trace), and
 *   2. the recovery sentence routes to `git fsck --unreachable` / a rescue
 *      branch and warns about auto-gc. It must NOT say `git reflog`:
 *      `git worktree remove --force` deletes `.git/worktrees/<name>`, reflogs
 *      included, so by the time the halt is read that route is dead.
 *
 * Split from test-integrate-own-commits-1173.ts, which shares this fixture
 * shape and sits at the AGENTS.md §12 500-line cap.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureIntegrateWorktreeOrHalt } from "../src/work-driver-commit-fallback.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state-update.ts";
import { worktreePath } from "../src/worktree.ts";
import { ISSUE_17_BACKUP_REF, git, realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1396-superseded-"));
const BRANCH = "feature/issue-17-x";

async function fixture(name: string) {
  const origin = path.join(root, `${name}-origin.git`);
  const repo = path.join(root, name);
  await git(root, ["init", "-q", "--bare", "--initial-branch=main", origin]);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repo, ["checkout", "-q", "--detach"]);
  await git(repo, ["branch", BRANCH, baseSha]);
  const wt = worktreePath(repo, "issue-17-integrate");
  const stateFile = path.join(repo, ".pi", "work-state", "17.json");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      pipelineState: { branchName: BRANCH, baseSha, worktrees: {}, integrateWorktree: wt },
    }),
  );
  return { repo, baseSha, wt, stateFile };
}

/** A stale integrate tree: detached, holding one consolidation commit. */
async function staleDetachedWithCommit(repo: string, wt: string, baseSha: string) {
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "a.txt"), "base\nconsolidated\n");
  await git(wt, ["commit", "-q", "-am", "consolidation"]);
  return (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
}

try {
  // #1396 (round 3) — and when the re-entry OVERWROTE an older backup, the
  // halt body names the sha that just lost its only named reference. Without
  // it the operator reads "kept on refs/pi-rukas/…", finds the newest commit
  // there, and never learns a second one existed — while the tree that held it
  // has already been force-removed. Pre-seeded with a real second commit so the
  // supersession is git's, not the fixture's.
  {
    const { repo, baseSha, wt } = await fixture("halt-body-superseded");
    const kept1 = await staleDetachedWithCommit(repo, wt, baseSha);
    // Point the per-issue ref at a DIFFERENT commit than the one this round
    // keeps: the first round's backup, as a prior re-entry would have left it.
    await git(repo, ["update-ref", ISSUE_17_BACKUP_REF, kept1]);
    // Give the stale tree a NEW unique commit so this round writes a different
    // sha and genuinely supersedes kept1.
    writeFileSync(path.join(wt, "a.txt"), "base\nconsolidated\nround two\n");
    await git(wt, ["commit", "-q", "-am", "consolidation 2"]);
    const addFails: typeof realExec = async (cmd, o) => {
      if (cmd.startsWith("git worktree add"))
        throw new Error(`fatal: simulated add failure ${"x".repeat(500)}`);
      return realExec(cmd, o);
    };
    const base = initialState(17);
    const state = { ...base, pipelineState: { ...base.pipelineState, baseSha } };
    const ctx = { repoRoot: repo, issue: 17 } as unknown as CycleContext;
    const res = await ensureIntegrateWorktreeOrHalt(ctx, state, BRANCH, addFails, "conflict");
    const plumb =
      "halted" in res ? res.halted.eventLog.find((e) => e.kind === "plumb-report") : undefined;
    const body = (plumb as { body?: string } | undefined)?.body ?? "";
    assert(
      "halted" in res && body.includes(ISSUE_17_BACKUP_REF),
      `(a) the halt plumb report names the kept backup ref (${body.slice(0, 80)})`,
    );
    assert(
      body.includes(kept1),
      `#1396 (b) the halt plumb report names the SUPERSEDED sha the operator must rescue (${body.includes(kept1) ? kept1.slice(0, 12) : "MISSING"})`,
    );
    // PM adversarial: the recovery hint must not send the operator to a reflog
    // that `git worktree remove --force` has already deleted, and must say the
    // rescue races auto-gc.
    assert(
      body.includes("git fsck --unreachable") &&
        body.includes("git branch rescue-") &&
        /auto-gc/i.test(body),
      "(c) the recovery hint names fsck + a rescue branch + auto-gc, not `git reflog`",
    );
    assert(
      !body.includes("git reflog"),
      "(c) the recovery hint never routes the operator to a deleted integrate-worktree reflog",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
