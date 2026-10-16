#!/usr/bin/env bun
/**
 * #1170 — the driver-owned stale `issue-<N>-integrate` tree is inspected
 * before it is force-removed, and `branchName` is validated before it reaches
 * a shell string (real git, ensureIntegrateWorktree):
 *  (a) a stale integrate tree with an uncommitted change is NOT removed and the
 *      step throws DirtyWorktreeError naming its path;
 *  (b) a clean, tree-equal stale integrate tree is removed and recreated as before;
 *  (c) an unsafe branchName is refused before any git command runs;
 *  (e) a commit on neither the branch nor origin is kept on a backup ref (#1173);
 *  (i) a plain non-worktree directory at the integrate path is refused as
 *      DirtyWorktreeError (notOwnWorktree) and never removed;
 *  (j) #1396 — an unreadable `git worktree list` refuses the creation with
 *      WorktreeScanError and removes NOTHING (one retry, then refuse); a single
 *      transient failure is retried and proceeds;
 *  (k) #1396 — an unreadable `git merge-base --is-ancestor` keeps the commit
 *      instead of assuming it is already on origin/<branch>.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureIntegrateWorktree } from "../src/work-driver-integrate-worktree.ts";
import {
  DirtyWorktreeError,
  type ExecFn,
  WorktreeScanError,
  worktreePath,
} from "../src/worktree.ts";
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
      // #1173 — the detached tree's own commit is no longer refused (that wedged
      // every re-entry); it is kept on a backup ref, so nothing is lost.
      const kept = (
        await git(repo, ["rev-parse", "--verify", "refs/pi-rukas/integrate-backup/issue-17"])
      ).stdout.trim();
      assert(
        err === undefined && kept === sha,
        "(e) a stale tree with a commit on neither the branch nor origin is kept on a backup ref, not refused",
      );
    } else {
      const tag = where === "local" ? "(d)" : "(f)";
      assert(
        err === undefined,
        `${tag} a stale tree whose commit is on the ${where === "local" ? "branch ref" : "origin/<branch>"} does not wedge the re-run`,
      );
    }
  }
  // (g) every loss channel is judged before the origin exemption: HEAD is already
  // on origin/<branch>, but a non-regenerable ignored .env at the root is still
  // refused. (vendor/ is exempt only as a whole, so this case uses a root .env.)
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

  // (i) a plain directory (not a worktree) at the integrate path: git walks up to
  // the parent repo, so it is refused as notOwnWorktree — and never removed.
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("plain-dir");
    await git(repo, ["worktree", "remove", "--force", wt]);
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, "keep.txt"), "precious\n");
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
      err instanceof DirtyWorktreeError &&
        (err as { finding?: { notOwnWorktree?: boolean } }).finding?.notOwnWorktree === true,
      `(i) a plain directory at the integrate path is refused as notOwnWorktree (${err ? (err as Error).message.split("\n")[0] : "no error"})`,
    );
    assert(
      existsSync(path.join(wt, "keep.txt")),
      "(i) the plain directory's file survives the refusal",
    );
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

  // (j) #1396 — `git worktree list` itself is unreadable: the registration check
  // cannot prove the tree is NOT driver residue, so the whole creation refuses
  // (WorktreeScanError, not a DirtyWorktreeError — there is no finding to name)
  // and the registered stale tree stays on disk and stays registered.
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("listing-unreadable");
    // The tree holds a commit on neither the branch nor origin — the shape the
    // keep-or-refuse branch exists to save. Under the old fail-open listing it
    // read as "unregistered", skipped the backup, and fell through to
    // `git worktree add` failing on an existing path.
    writeFileSync(path.join(wt, "a.txt"), "base\nintegrated\n");
    await git(wt, ["commit", "-q", "-am", "integration"]);
    const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    let listCalls = 0;
    const listingFails: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git worktree list")) {
        listCalls++;
        throw new Error("fatal: simulated listing failure");
      }
      return realExec(cmd, o);
    };
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        listingFails,
        { repoRoot: repo, issue: 17, branchName: branch, baseSha },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof WorktreeScanError &&
        !(err instanceof DirtyWorktreeError) &&
        /simulated listing failure/.test(err.message),
      `(j) an unreadable \`git worktree list\` refuses the integrate creation with WorktreeScanError (${err ? (err as Error).message.split("\n")[0] : "no error"})`,
    );
    assert(
      listCalls === 2,
      `(j) the strict listing retries once before refusing — both attempts ran (${listCalls})`,
    );
    assert(existsSync(wt), "(j) the registered stale tree is NOT removed");
    assert(existsSync(path.join(wt, "a.txt")), "(j) and its working file survives");
    const still = (
      await git(repo, ["rev-parse", "--verify", "HEAD"]).catch(() => ({ stdout: "" }))
    ).stdout.trim();
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(list.includes(wt), "(j) the stale tree is still registered after the refusal");
    assert(
      still.length > 0 && existsSync(wt),
      `(j) its commits are still resolvable (${sha.slice(0, 8)})`,
    );
  }

  // (j2) #1396 — one transient listing failure is retried, not refused: a flaky
  // read must not park a cycle whose tree is perfectly replaceable.
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("listing-flaky");
    let listCalls = 0;
    const flakyOnce: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git worktree list") && ++listCalls === 1) {
        throw new Error("fatal: transient lock");
      }
      return realExec(cmd, o);
    };
    let err: unknown;
    try {
      await ensureIntegrateWorktree(
        flakyOnce,
        { repoRoot: repo, issue: 17, branchName: branch, baseSha },
        stateFile,
      );
    } catch (e) {
      err = e;
    }
    assert(
      err === undefined && listCalls >= 2,
      `(j2) a single transient listing failure is retried and the re-entry proceeds (calls: ${listCalls}, ${err ? (err as Error).message.split("\n")[0] : "ok"})`,
    );
    const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    assert(list.includes(wt), "(j2) and the integrate worktree was recreated at its path");
  }

  // (k) #1396 — an unreadable "is HEAD already on origin/<branch>?" keeps the
  // commit. The old code read any git failure as "not reachable" AND the
  // reachable-check as an exemption, so a failure here could silently take the
  // "already on origin, nothing to keep" exit and let the commit die with the
  // tree. An unreadable answer must fall through to the keep.
  {
    const { repo, baseSha, branch, wt, stateFile } = await fixture("merge-base-unreadable");
    writeFileSync(path.join(wt, "a.txt"), "base\nintegrated\n");
    await git(wt, ["commit", "-q", "-am", "integration"]);
    const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    // exit 1 ("not an ancestor") is the ORDINARY answer and is not a failure;
    // anything else (128, a kill) is "could not answer". Injected as raw
    // rejections with the `code` promisify(exec) carries, so the two cases are
    // distinguishable — which is exactly what the old `catch → false` collapsed.
    const reject = (code: number, msg: string) => {
      const e = new Error(msg) as Error & { code?: number };
      e.code = code;
      return e;
    };
    let mergeBaseCalls = 0;
    let injectFailure = true;
    const mergeBaseUnreadable: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git merge-base --is-ancestor")) {
        mergeBaseCalls++;
        if (injectFailure) {
          injectFailure = false;
          throw reject(128, "fatal: bad object");
        }
        // The ordinary answer from here on: HEAD is NOT on origin/<branch>.
        throw reject(1, "");
      }
      return realExec(cmd, o);
    };
    const res = await ensureIntegrateWorktree(
      mergeBaseUnreadable,
      { repoRoot: repo, issue: 17, branchName: branch, baseSha },
      stateFile,
    ).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, err: e }),
    );
    const kept = (
      await git(repo, ["rev-parse", "--verify", "refs/pi-rukas/integrate-backup/issue-17"]).catch(
        () => ({ stdout: "" }),
      )
    ).stdout.trim();
    assert(
      mergeBaseCalls > 0 && res.ok && kept === sha,
      `(k) an unreadable \`merge-base --is-ancestor\` keeps the commit on the backup ref rather than assuming it is on origin (${mergeBaseCalls} probe call(s), kept: ${kept ? kept.slice(0, 8) : "nothing"})`,
    );
    // Canary (the honest counterfactual): same fixture, the probe ANSWERS
    // "reachable" (exit 0) instead of failing. The backup then correctly
    // declines — proving the keep in (k) is produced by the unreadable answer
    // being treated as NOT reachable, not by the stub happening to write a ref
    // anyway. (A single `ensureIntegrateWorktree` consults the probe exactly
    // once, so a second round is a different fixture, not a second answer.)
    const decliner: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git merge-base --is-ancestor")) return { stdout: "" };
      return realExec(cmd, o);
    };
    const {
      repo: repo2,
      baseSha: base2,
      wt: wt2,
      stateFile: state2,
    } = await fixture("merge-base-reachable");
    writeFileSync(path.join(wt2, "a.txt"), "base\nintegrated\n");
    await git(wt2, ["commit", "-q", "-am", "integration"]);
    const canary = await ensureIntegrateWorktree(
      decliner,
      { repoRoot: repo2, issue: 17, branchName: branch, baseSha: base2 },
      state2,
    ).then(
      (r) => r.backupRef,
      (e: unknown) => String((e as Error).message),
    );
    const canaryRef = (
      await git(repo2, ["rev-parse", "--verify", "refs/pi-rukas/integrate-backup/issue-17"]).catch(
        () => ({ stdout: "" }),
      )
    ).stdout.trim();
    assert(
      canary === undefined && canaryRef === "",
      `(k) canary: with the probe ANSWERING "reachable" the same tree writes NO backup ref — so (k) is the unreadable answer doing the work (${canary === undefined ? "no ref" : String(canary).slice(0, 60)})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
