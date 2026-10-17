#!/usr/bin/env bun
/**
 * #1396 — the integrate step's registration check reads `git worktree list`
 * STRICTLY, and the two outcomes of that read are the two ways a re-entry can
 * go wrong.
 *
 * The check decides whether a stale `issue-<N>-integrate` tree is driver-owned
 * re-entry residue (record its HEAD, force-replace) or an unregistered
 * directory (leave it for the #475 target guard). "Could not read" is NOT a
 * neutral answer here: read as "not registered" it skips the commit-keeping
 * path entirely and lets the driver force-remove a tree it never proved was
 * residue. So it uses `listWorktreeStrict` — one retry at 250 ms, then a
 * `WorktreeScanError`, nothing removed.
 *
 *  (j)  an unreadable listing refuses the creation, removes nothing, and — the
 *       six-lens addition — writes NO backup ref and leaves the tree's HEAD at
 *       the original sha: the refusal happens before anything is kept, so
 *       nothing is secretly stashed behind it;
 *  (j2) a single transient failure is retried and the re-entry proceeds, so a
 *       flaky read cannot park a cycle whose tree is perfectly replaceable.
 *
 * Split out of test-integrate-stale-tree-1170.ts, which shares this fixture
 * shape and sits at the AGENTS.md §12 500-line cap.
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
import { ISSUE_17_BACKUP_REF, git, realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1396-listing-"));

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
    // #1396 six-lens — the refusal happens BEFORE the backup is written, so
    // (j) also pins that nothing was secretly kept behind the refusal: no
    // backup ref exists for the issue, and the tree's own HEAD is untouched
    // (the commit the driver could not prove anything about is still exactly
    // where it was — reachable from the tree, named by no ref).
    const jTreeHead = (await git(wt, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    assert(
      jTreeHead === sha,
      `(j) the stale tree's HEAD is unchanged by the refusal (${jTreeHead.slice(0, 8)} = ${sha.slice(0, 8)})`,
    );
    const jBackup = (
      await git(repo, ["rev-parse", "--verify", "--quiet", ISSUE_17_BACKUP_REF]).catch(() => ({
        stdout: "",
      }))
    ).stdout.trim();
    assert(
      jBackup === "",
      `(j) NO backup ref was written by the refused attempt (${jBackup || "none"})`,
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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
