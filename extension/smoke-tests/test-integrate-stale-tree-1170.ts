#!/usr/bin/env bun
/**
 * #1170 — the driver-owned stale `issue-<N>-integrate` tree is inspected
 * before it is force-removed, and `branchName` is validated before it reaches
 * a shell string (real git, ensureIntegrateWorktree):
 *  (a) a stale integrate tree with an uncommitted change is NOT removed and the
 *      step throws DirtyWorktreeError naming its path;
 *  (b) a clean, tree-equal stale integrate tree is removed and recreated as before;
 *  (c) an unsafe branchName is refused before any git command runs.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureIntegrateWorktree } from "../src/work-driver-integrate-worktree.ts";
import { DirtyWorktreeError, type ExecFn, worktreePath } from "../src/worktree.ts";
import { git, realExecWithStderr as realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-stale-integrate-"));

/** A real repo on main @ base, plus a stale driver-owned integrate tree at base. */
async function fixture(name: string) {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = "feature/issue-17-x";
  await git(repo, ["branch", branch, baseSha]);

  const wt = worktreePath(repo, "issue-17-integrate");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);

  const stateFile = path.join(repo, ".pi", "work-state", "17.json");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ pipelineState: { integrateWorktree: wt, branchName: branch, baseSha } }),
  );
  return { repo, baseSha, branch, wt, stateFile };
}

try {
  // (a) stale integrate tree with uncommitted work → refused, nothing removed
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("dirty");
    writeFileSync(path.join(wt, "scratch.txt"), "precious\n");
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
      err instanceof DirtyWorktreeError && err.message.includes(wt),
      `(a) a dirty stale integrate tree throws DirtyWorktreeError naming its path (${err instanceof Error ? err.message.split("\n")[0] : "no error"})`,
    );
    assert(
      existsSync(path.join(wt, "scratch.txt")),
      "(a) the uncommitted file in the stale integrate tree survives",
    );
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(list.includes(wt), "(a) the stale integrate tree is still registered");
  }

  // (b) clean, tree-equal stale integrate tree → removed and recreated
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("clean");
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
      `(b) a clean tree-equal stale integrate tree is replaced without error (${err ? (err as Error).message.split("\n")[0] : "ok"})`,
    );
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(list.includes(wt), "(b) the integrate worktree was recreated at its path");
  }

  // (b2) clean stale integrate tree + ignored build output (target/) → refused:
  // ignored entries are judged as loss, and nothing in the driver builds here.
  // The tree is kept, not force-removed.
  for (const [tag, rel, body] of [
    ["(b2)", "target/out.bin", "built\n"],
    ["(b3)", ".env", "SECRET=1\n"],
  ] as const) {
    const { repo, baseSha, branch, wt, stateFile } = await fixture(
      `ignored-${rel.replace(/\W/g, "_")}`,
    );
    writeFileSync(path.join(repo, ".git", "info", "exclude"), `${rel.split("/")[0]}\n`, {
      flag: "a",
    });
    mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    writeFileSync(path.join(wt, rel), body);
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
      err instanceof DirtyWorktreeError && err.message.includes(wt),
      `${tag} a stale integrate tree holding ignored ${rel} throws DirtyWorktreeError (${err ? (err as Error).message.split("\n")[0] : "no error"})`,
    );
    assert(existsSync(path.join(wt, rel)), `${tag} the ignored ${rel} survives`);
  }

  // (b4) a regenerable node_modules/ in the stale tree is still no loss.
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("ignored-nm");
    writeFileSync(path.join(repo, ".git", "info", "exclude"), "node_modules/\n", { flag: "a" });
    mkdirSync(path.join(wt, "node_modules"), { recursive: true });
    writeFileSync(path.join(wt, "node_modules", "pkg.js"), "x\n");
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
      `(b4) a stale integrate tree whose only ignored entry is node_modules/ is replaced (${err ? (err as Error).message.split("\n")[0] : "ok"})`,
    );
  }

  // (c) unsafe branchName → refused before any git command runs
  {
    const { repo, baseSha, stateFile } = await fixture("unsafe-branch");
    const pwned = path.join(root, "pwned-1170");
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        realExec,
        {
          repoRoot: repo,
          issue: 17,
          branchName: `feature/x;touch ${pwned}`,
          baseSha,
        },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof Error && /not a valid ref name/.test(err.message),
      "(c) an unsafe branchName is refused as an invalid ref name",
    );
    assert(!existsSync(pwned), "(c) the shell-metacharacter branchName never reaches a shell");
  }
  // (d)/(f)/(e) a stale tree whose one commit is already on the branch ref or
  // on origin/<branch> is no loss (a re-entry must not wedge); a commit on
  // neither is unpushed work and refuses.
  for (const where of ["local", "remote", "unpushed"] as const) {
    const { repo, baseSha, branch, wt, stateFile } = await fixture(`stale-${where}`);
    writeFileSync(path.join(wt, "a.txt"), "base\nintegrated\n");
    await git(wt, ["commit", "-q", "-am", "integration"]);
    const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    if (where === "local") await git(repo, ["update-ref", `refs/heads/${branch}`, sha]);
    if (where === "remote") {
      await git(repo, ["update-ref", `refs/remotes/origin/${branch}`, sha]);
    }
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
    if (where === "unpushed") {
      assert(
        err instanceof DirtyWorktreeError && err.message.includes(wt),
        "(e) a stale tree with a commit on neither the branch nor origin is refused",
      );
      assert(existsSync(wt), "(e) the unpushed stale tree is not removed");
    } else {
      const tag = where === "local" ? "(d)" : "(f)";
      assert(
        err === undefined,
        `${tag} a stale tree whose commit is on the ${where === "local" ? "branch ref" : "origin/<branch>"} does not wedge the re-run`,
      );
    }
  }
  // (g) every loss channel is judged before the origin exemption: HEAD is already
  // on origin/<branch>, but a non-regenerable ignored .env is still refused.
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("remote-env");
    writeFileSync(path.join(repo, ".git", "info", "exclude"), ".env\n", { flag: "a" });
    writeFileSync(path.join(wt, ".env"), "SECRET=1\n");
    writeFileSync(path.join(wt, "a.txt"), "base\nintegrated\n");
    await git(wt, ["commit", "-q", "-am", "integration"]);
    const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    await git(repo, ["update-ref", `refs/remotes/origin/${branch}`, sha]);
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
      err instanceof DirtyWorktreeError && err.message.includes(wt),
      `(g) HEAD on origin/<branch> does not exempt a stale tree holding ignored .env (${err ? (err as Error).message.split("\n")[0] : "no error"})`,
    );
    assert(existsSync(path.join(wt, ".env")), "(g) the ignored .env survives");
  }

  // (h) git cannot read the stale tree's status: refused (fail closed), nothing removed.
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("status-fails");
    const statusFails: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git status")) throw new Error("fatal: index file corrupt");
      return realExec(cmd, o);
    };
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        statusFails,
        { repoRoot: repo, issue: 17, branchName: branch, baseSha },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof DirtyWorktreeError &&
        err.message.includes(wt) &&
        /index file corrupt/.test(err.message),
      `(h) an unreadable stale tree throws DirtyWorktreeError carrying the git error (${err ? (err as Error).message.split("\n")[0] : "no error"})`,
    );
    assert(existsSync(wt), "(h) the unreadable stale tree is not removed");
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(list.includes(wt), "(h) the stale tree is still registered");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
