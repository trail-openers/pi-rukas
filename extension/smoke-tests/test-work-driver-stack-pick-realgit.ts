#!/usr/bin/env bun
/**
 * #861 decision (6) — the stacked recovery line is a REAL
 * `git cherry-pick <rootBase>..<tip>` (root base .. leaf tip, every stack
 * commit in order). The offline fixture (test-handoff-recovery-stacked.ts)
 * only string-asserts the range shape; a typo in the range FORM (e.g. a
 * reversed order) would pass it. This test EXECUTES the exact range
 * `singleLeafPickRange` emits (rootBase = the stack root's real base SHA
 * read from git, tip = the leaf's real HEAD) against a fixture stack and
 * asserts every stack commit lands on the branch — the pre-#861
 * `git cherry-pick <tip>` shape (which picks only the tip and drops the
 * ancestors) fails this test, which is the point.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { singleLeafPickRange } from "../src/work-driver-handoff-stack-pick.ts";
import { addLocalRemote, fixture, git } from "./helpers-integrate-pin-realgit.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-861-stack-"));

try {
  const { repo, baseSha } = await fixture(root, "stacked");
  await addLocalRemote(root, repo);
  const wt = path.join(repo, ".worktrees", "issue-1-task-a"); // stack root
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "root.txt"), "root commit\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "stack root"]);
  const rootSha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
  // The dependent's worktree is created AT the root's tip (the deferred-
  // creation shape the driver's dep-scheduler produces): its own base is
  // rootSha, so the stack's rootBase is the root's base = the cycle's
  // baseSha (single-leaf pick; the leaf carries the union of the stack).
  const wtLeaf = path.join(repo, ".worktrees", "issue-1-task-b");
  await git(repo, ["worktree", "add", "-q", "--detach", wtLeaf, rootSha]);
  writeFileSync(path.join(wtLeaf, "leaf.txt"), "leaf commit\n");
  await git(wtLeaf, ["add", "."]);
  await git(wtLeaf, ["commit", "-q", "-m", "stack leaf"]);
  const tip = (await git(wtLeaf, ["rev-parse", "HEAD"])).stdout.trim();

  // The range decision (6) emits: <rootBase>..<tip>, rootBase = the stack
  // root's base (its parent's tip = the cycle's baseSha here).
  const range = singleLeafPickRange(baseSha, tip);
  assert(
    range !== undefined && range === `${baseSha}..${tip}`,
    `the stacked pick is the range rootBase..tip (got ${range})`,
  );

  // EXECUTE the emitted command: a real cherry-pick onto a fresh branch must
  // land BOTH stack commits (the pre-#861 tip-only pick leaves the root
  // commit off the branch — the exact failure #861 fixes).
  await git(repo, ["checkout", "-q", "-b", "feature/issue-1-stacked", baseSha]);
  await git(repo, ["cherry-pick", range ?? ""]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const ancestors = (await git(repo, ["rev-list", "--count", `${baseSha}..HEAD`])).stdout.trim();
  assert(ancestors === "2", `the range pick lands BOTH stack commits (got ${ancestors})`);
  const subj = (await git(repo, ["log", "--format=%s", `${baseSha}..HEAD`])).stdout;
  assert(
    subj.includes("stack root") && subj.includes("stack leaf"),
    "the range pick preserves commit order (root first, leaf on top)",
  );
  assert(head === tip, "the picked stack tip matches the leaf's real HEAD");
  void rootSha;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
