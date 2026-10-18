/**
 * Test fixture (#1391): a repo with a bare origin, a pushed feature branch, and
 * a detached worktree under `.worktrees/`, for the retry save-then-clean tests.
 * Real git: `assertInsideWorktrees` and the status read cannot be faked.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFn } from "../../src/work-develop-git.ts";
import { realExec } from "./exec-fake.ts";
import { ensureGitIdentity, gitIn } from "./git-worktree-fixture.ts";

export interface RetryFixture {
  dir: string;
  repo: string;
  wt: string;
  baseSha: string;
  branch: string;
}

export function retryFixture(label: string): RetryFixture {
  ensureGitIdentity();
  const dir = mkdtempSync(path.join(tmpdir(), `retry-tree-${label}-`));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  gitIn(dir, ["init", "-q", "--bare", "-b", "main", origin]);
  gitIn(dir, ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  gitIn(repo, ["add", "a.txt"]);
  gitIn(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = gitIn(repo, ["rev-parse", "HEAD"]).trim();
  gitIn(repo, ["remote", "add", "origin", origin]);
  const branch = "feature/issue-1391-retry";
  gitIn(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(path.join(repo, "a.txt"), "two\n");
  gitIn(repo, ["commit", "-q", "-am", "round 1"]);
  gitIn(repo, ["push", "-q", "origin", "main", branch]);
  gitIn(repo, ["checkout", "-q", "main"]);
  const wt = path.join(repo, ".worktrees", "wt");
  gitIn(repo, ["worktree", "add", "-q", "--detach", wt, `origin/${branch}`]);
  return { dir, repo, wt, baseSha, branch };
}

/** The lost child's residue, plus the driver's own dirs the clean must spare. */
export function dirty(wt: string): void {
  writeFileSync(path.join(wt, "a.txt"), "half-written\n");
  writeFileSync(path.join(wt, "new.txt"), "new\n");
  mkdirSync(path.join(wt, ".pi"), { recursive: true });
  writeFileSync(path.join(wt, ".pi", "verify-cmd"), "true\n");
  mkdirSync(path.join(wt, "tmp", "issue-1391"), { recursive: true });
  writeFileSync(path.join(wt, "tmp", "issue-1391", "notes.txt"), "keep\n");
}

/** A recording executor over real git; `fail` names a git subcommand to refuse. */
export function recorder(fail?: string): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, opts) => {
    const argv = (opts as { argv?: string[] }).argv ?? [];
    if (cmd === "git") calls.push(argv);
    if (cmd === "git" && fail !== undefined && argv[0] === fail) {
      throw new Error(`injected ${fail} failure`);
    }
    return realExec(cmd, opts);
  };
  return { exec, calls };
}

/** Index of the first call whose argv starts with `prefix`, or -1. */
export function at(calls: string[][], ...prefix: string[]): number {
  return calls.findIndex((c) => prefix.every((p, i) => c[i] === p));
}
