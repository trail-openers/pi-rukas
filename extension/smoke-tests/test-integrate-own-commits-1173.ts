#!/usr/bin/env bun
/**
 * #1173 / #1100 — the commit-pr ops fallback's integrate tree and the cycle's
 * OWN unpushed consolidation commits (real git, temp repo with a bare origin,
 * ensureIntegrateWorktree).
 *
 * The chain this pins: the integrate tree was created DETACHED (a SHA was
 * passed to `git worktree add`), so the ops child's consolidation commit never
 * moved the branch and its `git push -u origin <branch>` pushed nothing. A
 * re-entry then found that tree holding "unpushed commits" — refused when the
 * state file recorded the tree, force-removed (the commit lost) when it did not.
 *
 *  (a) the tree is created ATTACHED to the cycle's branch, so a commit there
 *      advances the branch and the prompt's push recipe reaches origin;
 *  (b) a missing branch is created at baseSha and attached;
 *  (c) re-entry (recorded tree) holding the cycle's own unpushed commit: no
 *      refusal — the commit is kept on a backup ref and the tree is recreated;
 *  (d) re-entry (unrecorded tree — the shape production reaches): the commit
 *      is kept on a backup ref, never silently destroyed;
 *  (e) a stale tree attached to a DIFFERENT branch with unique commits still
 *      refuses, and a dirty one still refuses — nothing removed;
 *  (f) an attached tree whose commits are on the branch re-enters without a
 *      backup (nothing to keep);
 *  (g) when the tree cannot be created, the halt records why integrate()
 *      failed first, not only the downstream creation failure;
 *  (h) the fallback prompt forbids creating or switching to another branch;
 *  (i) a branch already checked out in another worktree fails creation loudly;
 *  (j) an UNRECORDED stale tree on a different branch with unique commits is
 *      refused too (one admission rule on both paths), and a kept backup ref
 *      is returned to the commit-pr caller;
 *  (k) a creation failure after the backup still names the kept ref;
 *  (l) the halt's plumb report names the kept ref even when the error truncates;
 *  (m) #1396 — repeated re-entries that each keep a DIFFERENT unpushed HEAD
 *      leave exactly ONE ref under `refs/pi-rukas/integrate-backup/issue-17`
 *      (the namespace holds at most one ref per issue, overwritten in place),
 *      and the docs naming that namespace agree with the ref the code writes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureIntegrateWorktreeOrHalt } from "../src/work-driver-commit-fallback.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { ensureIntegrateWorktree } from "../src/work-driver-integrate-worktree.ts";
import { inlineCommitPrPrompt } from "../src/work-driver-prompts-late.ts";
import { initialState } from "../src/workflow-state-update.ts";
import { DirtyWorktreeError, worktreePath } from "../src/worktree.ts";
import { git, realExecWithStderr as realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1173-own-commits-"));
const BRANCH = "feature/issue-17-x";

async function fixture(name: string, opts: { recordTree?: boolean; branch?: boolean } = {}) {
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
  if (opts.branch !== false) await git(repo, ["branch", BRANCH, baseSha]);
  const wt = worktreePath(repo, "issue-17-integrate");
  const stateFile = path.join(repo, ".pi", "work-state", "17.json");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const ps = { branchName: BRANCH, baseSha, worktrees: {} as Record<string, string> };
  writeFileSync(
    stateFile,
    JSON.stringify({
      pipelineState: opts.recordTree === false ? ps : { ...ps, integrateWorktree: wt },
    }),
  );
  return { repo, baseSha, wt, stateFile };
}

/** A stale integrate tree as the pre-fix driver left it: detached, holding one consolidation commit. */
async function staleDetachedWithCommit(repo: string, wt: string, baseSha: string) {
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "a.txt"), "base\nconsolidated\n");
  await git(wt, ["commit", "-q", "-am", "consolidation"]);
  return (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
}

const run = (repo: string, baseSha: string, stateFile: string) =>
  ensureIntegrateWorktree(
    realExec,
    { repoRoot: repo, issue: 17, branchName: BRANCH, baseSha },
    stateFile,
  ).then(
    (r) => ({ ok: true as const, r }),
    (err: unknown) => ({ ok: false as const, err }),
  );

const headRef = async (wt: string) =>
  (
    await git(wt, ["rev-parse", "--symbolic-full-name", "HEAD"]).catch(() => ({ stdout: "" }))
  ).stdout.trim();

const tipOf = async (repo: string) =>
  (
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]).catch(() => ({
      stdout: "",
    }))
  ).stdout.trim();

const reachable = async (repo: string, sha: string) =>
  (await git(repo, ["for-each-ref", "--contains", sha, "--format=%(refname)"])).stdout
    .split("\n")
    .filter(Boolean);

try {
  // (a) attached creation: a commit advances the branch; the push recipe reaches origin.
  {
    const { repo, baseSha, wt, stateFile } = await fixture("attached");
    const res = await run(repo, baseSha, stateFile);
    assert(res.ok, `(a) the integrate tree is created (${res.ok ? "ok" : String(res.err)})`);
    assert(
      (await headRef(wt)) === `refs/heads/${BRANCH}`,
      `(a) the integrate tree is ATTACHED to ${BRANCH} (HEAD: ${await headRef(wt)})`,
    );
    writeFileSync(path.join(wt, "a.txt"), "base\nconsolidated\n");
    await git(wt, ["commit", "-q", "-am", "consolidation"]);
    const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    await git(wt, ["push", "-q", "-u", "origin", BRANCH]);
    const remote = (await git(repo, ["ls-remote", "origin", `refs/heads/${BRANCH}`])).stdout;
    assert(remote.startsWith(sha), "(a) `git push -u origin <branch>` lands the commit on origin");
  }

  // (b) branch absent → created at baseSha and attached.
  {
    const { repo, baseSha, wt, stateFile } = await fixture("no-branch", { branch: false });
    const res = await run(repo, baseSha, stateFile);
    assert(res.ok, `(b) the integrate tree is created (${res.ok ? "ok" : String(res.err)})`);
    assert((await tipOf(repo)) === baseSha, "(b) the missing branch is created at baseSha");
    assert((await headRef(wt)) === `refs/heads/${BRANCH}`, "(b) and the tree is attached to it");
  }

  // (c)/(d) re-entry with the cycle's own unpushed commit: kept on a backup ref, tree recreated.
  for (const [tag, recordTree] of [
    ["(c)", true],
    ["(d)", false],
  ] as const) {
    const { repo, baseSha, wt, stateFile } = await fixture(`reentry-${tag[1]}`, { recordTree });
    const sha = await staleDetachedWithCommit(repo, wt, baseSha);
    const res = await run(repo, baseSha, stateFile);
    assert(
      res.ok,
      `${tag} re-entry over the cycle's own unpushed commit does not refuse (${res.ok ? "ok" : (res.err as Error).message.split(" Inspect")[0]})`,
    );
    const refs = await reachable(repo, sha);
    const backup = "refs/pi-rukas/integrate-backup/issue-17";
    assert(refs.includes(backup), `${tag} the unpushed commit is kept on ${backup}`);
    assert(
      res.ok && res.r.backupRef === backup,
      `${tag} the result names the backup ref (${res.ok ? res.r.backupRef : "-"})`,
    );
    assert((await headRef(wt)) === `refs/heads/${BRANCH}`, `${tag} the recreated tree is attached`);
  }

  // (e) a different branch with unique commits, or uncommitted work, still refuses.
  {
    const { repo, baseSha, wt, stateFile } = await fixture("other-branch");
    await git(repo, ["worktree", "add", "-q", "-b", "someone-else", wt, baseSha]);
    writeFileSync(path.join(wt, "a.txt"), "base\nforeign\n");
    await git(wt, ["commit", "-q", "-am", "foreign"]);
    const res = await run(repo, baseSha, stateFile);
    assert(
      !res.ok && res.err instanceof DirtyWorktreeError,
      "(e) a stale tree on a different branch holding unique commits is refused",
    );
    assert((await headRef(wt)) === "refs/heads/someone-else", "(e) and it is not removed");
  }
  {
    const { repo, baseSha, wt, stateFile } = await fixture("dirty");
    await staleDetachedWithCommit(repo, wt, baseSha);
    writeFileSync(path.join(wt, "scratch.txt"), "precious\n");
    const res = await run(repo, baseSha, stateFile);
    assert(
      !res.ok && res.err instanceof DirtyWorktreeError,
      "(e) a stale tree with an uncommitted file (plus commits) is refused",
    );
    assert(existsSync(path.join(wt, "scratch.txt")), "(e) the uncommitted file survives");
  }

  // (f) attached tree whose commit is on the branch: re-entry needs no backup.
  {
    const { repo, baseSha, wt, stateFile } = await fixture("attached-reentry");
    const first = await run(repo, baseSha, stateFile);
    assert(first.ok, "(f) first creation succeeds");
    writeFileSync(path.join(wt, "a.txt"), "base\nconsolidated\n");
    await git(wt, ["commit", "-q", "-am", "consolidation"]);
    const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const second = await run(repo, baseSha, stateFile);
    assert(second.ok, `(f) re-entry succeeds (${second.ok ? "ok" : String(second.err)})`);
    assert(second.ok && second.r.backupRef === undefined, "(f) no backup ref is needed");
    assert((await tipOf(repo)) === sha, "(f) the branch still carries the consolidation commit");
  }

  // (g) a refused creation halts with the integrate() failure reason in the plumb.
  {
    const { repo, baseSha, wt } = await fixture("halt-reason");
    await staleDetachedWithCommit(repo, wt, baseSha);
    writeFileSync(path.join(wt, "scratch.txt"), "precious\n");
    const base = initialState(17);
    const state = { ...base, pipelineState: { ...base.pipelineState, baseSha } };
    const ctx = { repoRoot: repo, issue: 17 } as unknown as CycleContext;
    const res = await ensureIntegrateWorktreeOrHalt(
      ctx,
      state,
      BRANCH,
      realExec,
      "cherry-pick failed: error: could not apply abc123",
    );
    const plumb =
      "halted" in res ? res.halted.eventLog.find((e) => e.kind === "plumb-report") : undefined;
    const body = (plumb as { body?: string } | undefined)?.body ?? "";
    assert(
      "halted" in res && body.includes("could not apply abc123"),
      "(g) the halt's plumb report carries the integrate() failure reason",
    );
  }

  // (h) #1100 — the fallback prompt pins the branch and forbids every other one.
  {
    const integratePath = "/repo/.worktrees/issue-17-integrate";
    const wts = { default: "/repo/.worktrees/issue-17-default" };
    const prompt = inlineCommitPrPrompt([17], [], wts, {}, BRANCH, undefined, [], "/s", "t", {
      integratePath,
      scratchDir: "/s",
      baseSha: "abc1234",
      worktrees: wts,
      commitShas: {},
      workstreams: {},
    });
    for (const needle of [
      integratePath,
      "git checkout -b",
      "git switch -c",
      "git branch <new>",
      `the PR must head \`${BRANCH}\``,
    ]) {
      assert(prompt.includes(needle), `(h) the fallback prompt names ${needle}`);
    }
  }

  // (i) the branch is checked out elsewhere: creation fails naming it, no silent detach.
  {
    const { repo, baseSha, stateFile } = await fixture("held-elsewhere");
    const other = path.join(root, "held-elsewhere-other");
    await git(repo, ["worktree", "add", "-q", other, BRANCH]);
    const res = await run(repo, baseSha, stateFile);
    assert(
      !res.ok && /already (checked out|used by worktree)/.test(String(res.err)),
      `(i) creation refuses a branch held by another worktree (${res.ok ? "ok" : String(res.err).slice(0, 120)})`,
    );
  }

  // (j) unrecorded tree on another branch with unique commits: refused, not removed.
  {
    const { repo, baseSha, wt, stateFile } = await fixture("residue-other", { recordTree: false });
    await git(repo, ["worktree", "add", "-q", "-b", "someone-else", wt, baseSha]);
    writeFileSync(path.join(wt, "a.txt"), "base\nforeign\n");
    await git(wt, ["commit", "-q", "-am", "foreign"]);
    const res = await run(repo, baseSha, stateFile);
    assert(
      !res.ok,
      "(j) an unrecorded stale tree on another branch with unique commits is refused",
    );
    assert((await headRef(wt)) === "refs/heads/someone-else", "(j) and it is not removed");
  }
  {
    const { repo, baseSha, wt } = await fixture("halt-backup");
    const sha = await staleDetachedWithCommit(repo, wt, baseSha);
    const base = initialState(17);
    const state = { ...base, pipelineState: { ...base.pipelineState, baseSha } };
    const ctx = { repoRoot: repo, issue: 17 } as unknown as CycleContext;
    const res = await ensureIntegrateWorktreeOrHalt(ctx, state, BRANCH, realExec, "conflict");
    assert(
      "backupRef" in res && res.backupRef === "refs/pi-rukas/integrate-backup/issue-17",
      "(j) ensureIntegrateWorktreeOrHalt hands the backup ref to commit-pr (for the plumb report)",
    );
  }

  // (k) the backup was written, then `git worktree add` failed: the error names the ref.
  {
    const { repo, baseSha, wt, stateFile } = await fixture("fail-after-backup");
    const sha = await staleDetachedWithCommit(repo, wt, baseSha);
    const addFails: typeof realExec = async (cmd, o) => {
      if (cmd.startsWith("git worktree add")) throw new Error("fatal: simulated add failure");
      return realExec(cmd, o);
    };
    const res = await ensureIntegrateWorktree(
      addFails,
      { repoRoot: repo, issue: 17, branchName: BRANCH, baseSha },
      stateFile,
    ).then(
      () => "ok",
      (err: unknown) => String((err as Error).message),
    );
    assert(
      res.includes("simulated add failure") &&
        res.includes("refs/pi-rukas/integrate-backup/issue-17"),
      `(k) the creation error names the kept backup ref (${res.slice(0, 160)})`,
    );
  }

  // (l) the halt's plumb report (what the handoff renders) names the kept ref,
  // even when the creation error is long enough to truncate.
  {
    const { repo, baseSha, wt } = await fixture("halt-body-ref");
    const sha = await staleDetachedWithCommit(repo, wt, baseSha);
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
    const ref = "refs/pi-rukas/integrate-backup/issue-17";
    assert(
      "halted" in res && body.includes(ref) && body.includes("simulated add failure"),
      `(l) the halt plumb report names the kept backup ref (${body.slice(0, 80)})`,
    );
    assert(
      body.length < 1200,
      `(l) the creation error in the halt body is bounded (${body.length} chars)`,
    );
  }

  // (m) #1396 — the ref namespace holds AT MOST ONE ref per issue. Before the
  // fix the ref was keyed by HEAD SHA (`…/issue-17/<sha>`), so every re-entry
  // whose stale tree held a NEW unpushed commit added a ref and nothing ever
  // deleted one: five re-entries left six refs. Each round below makes a real
  // detached stale tree with its own commit, runs the re-entry, and repeats.
  {
    const { repo, baseSha, wt, stateFile } = await fixture("ref-growth", { recordTree: true });
    const shas: string[] = [];
    for (let round = 1; round <= 3; round++) {
      // The driver recreates its tree ATTACHED, so a re-entry whose commit is
      // on the branch has nothing to keep (case (f)). The accumulation this
      // case pins is the pre-fix driver leaving a DETACHED tree whose commit
      // reaches neither the branch nor origin — so each round first removes
      // the tree the previous round left, then rebuilds that residue shape
      // with unique content (a distinct HEAD sha each round: the pre-fix code
      // wrote one new `…/issue-17/<sha>` ref per round and deleted none).
      await git(repo, ["worktree", "remove", "--force", wt]).catch(() => undefined);
      await git(repo, ["update-ref", `refs/heads/${BRANCH}`, baseSha]).catch(() => undefined);
      await staleDetachedWithCommit(repo, wt, baseSha);
      writeFileSync(path.join(wt, "a.txt"), `base\nconsolidated round ${round}\n`);
      await git(wt, ["commit", "-q", "-am", `consolidation ${round}`]);
      const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
      shas.push(head);
      const res = await run(repo, baseSha, stateFile);
      assert(
        res.ok && res.r.backupRef === "refs/pi-rukas/integrate-backup/issue-17",
        `(m) round ${round} keeps HEAD on the single per-issue ref (${res.ok ? res.r.backupRef : (res.err as Error).message.split("\n")[0]})`,
      );
    }
    const refs = (
      await git(repo, ["for-each-ref", "--format=%(refname)", "refs/pi-rukas/integrate-backup"])
    ).stdout
      .split("\n")
      .filter(Boolean);
    assert(
      refs.length === 1 && refs[0] === "refs/pi-rukas/integrate-backup/issue-17",
      `(m) three re-entries with three different unpushed HEADs leave exactly ONE ref (${refs.join(", ") || "none"})`,
    );
    const surviving = (
      await git(repo, ["rev-parse", "refs/pi-rukas/integrate-backup/issue-17"])
    ).stdout.trim();
    assert(
      surviving === shas[shas.length - 1],
      `(m) the surviving ref names the NEWEST kept HEAD (${surviving.slice(0, 8)} = ${shas[shas.length - 1]?.slice(0, 8)})`,
    );
    // The discarded backup's commit is still in the object database reachable
    // from the surviving ref's history only when it truly was an ancestor; the
    // point of the assertion is that the replaced ref is GONE, not that the
    // commit is — the driver force-removed the tree that held it.
    assert(
      shas.length === 3 && shas[0] !== shas[2],
      "(m) the three rounds really were distinct HEADs",
    );
  }

  // (m2) #1396 — the docs state the one-ref-per-issue rule and name the
  // ref shape the code actually writes (they used to document the SHA-keyed
  // namespace and "never pruned automatically" as intended behaviour).
  {
    const docs = readFileSync(new URL("../../docs/troubleshooting.md", import.meta.url), "utf8");
    assert(
      docs.includes("refs/pi-rukas/integrate-backup/issue-<N>"),
      "(m2) docs/troubleshooting.md names the per-issue ref shape the code writes",
    );
    assert(
      !docs.includes("refs/pi-rukas/integrate-backup/issue-<N>/<sha>"),
      "(m2) the docs no longer document the SHA-keyed (unbounded) namespace",
    );
    assert(
      !docs.includes("never pruned automatically"),
      "(m2) the docs no longer present unbounded ref growth as intended behaviour",
    );
    assert(
      docs.includes("git update-ref -d refs/pi-rukas/integrate-backup/issue-<N>"),
      "(m2) the docs name the cleanup command for the single ref",
    );
    assert(
      docs.includes("WorktreeScanError") && docs.includes("git worktree list"),
      "(m2) the docs state the failed-listing refusal",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
