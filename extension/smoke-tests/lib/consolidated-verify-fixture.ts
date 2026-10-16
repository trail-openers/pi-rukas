#!/usr/bin/env bun
/**
 * Shared fixture for the #1240 duplicate-verify tests. Both the develop-side
 * test (`test-work-driver-consolidated-verify-skip.ts`) and the commit-pr-side
 * test (`test-work-driver-integrate-verify-skip.ts`) need the same thing: a
 * repo with a bare origin and one detached worktree per id, on a real git so
 * the tree identities the rule reads are git's own.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

export async function fixture(
  root: string,
  name: string,
  ids: string[],
  seed: Record<string, string> = {},
) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  for (const [rel, body] of Object.entries(seed)) writeFileSync(path.join(repo, rel), body);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    await git(wt, ["config", "user.email", "t@example.com"]);
    await git(wt, ["config", "user.name", "T"]);
    worktrees[id] = wt;
  }
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  return { dir, repo, baseSha, worktrees };
}
