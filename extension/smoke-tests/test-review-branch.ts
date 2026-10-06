#!/usr/bin/env bun
/**
 * #980 — the shared branch-resolution helper (review-branch.ts).
 *
 * `resolveReviewBranch` is the ONE branch-resolution path used by the lens
 * ledger write, the adversarial ledger write and the #973 residual-disclosure
 * poster (before #980 the `git rev-parse --abbrev-ref HEAD` recovery lived
 * inline in two ledger writers, and the tool path — which never supplies
 * `opts.branch` — posted the disclosure for NO branch and skipped the ledger
 * write silently).
 *
 * The contract (acceptance criteria + PM spec clarifications):
 *   - resolution order: explicit `branch` → a branch-named `head` ref
 *     (a leading `<remote>/` prefix is stripped, and the ref must EXIST
 *     locally or on that remote) → `git rev-parse --abbrev-ref HEAD`
 *     (detached head = no branch) → undefined;
 *   - `head: "origin/feature/x"` keys the ledger/disclosure as
 *     `feature/x` (the guard compares against the PR's headRefName);
 *   - an unresolvable shape (detached HEAD, no branch derivable) yields
 *     `undefined` — the visible not-recorded note is the CALLER's (only
 *     it knows whether a record would have happened), so the resolver
 *     itself stays note-free.
 *
 * Temp-repo tests (mkdtempSync + git init + local bare origin, the
 * test-review-ledger.ts setupRepo pattern) with the REAL git binary.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveReviewBranch } from "../src/review-branch.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
  exit = 1;
  return false;
}

const execp = async (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) => {
  const r = execSync(cmd, {
    cwd: opts?.cwd,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: r, stderr: "" };
};

/** Set up a temp repo: local bare origin, mainline `dev`, `feature/x`
 * branch pushed to origin (so `refs/remotes/origin/feature/x` exists after
 * the clone's fetch of the push). */
function setupRepo(): { repo: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-branch-"));
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin.git");
  execSync(`git init -q ${origin}`, { stdio: "ignore" });
  execSync(`git clone -q ${origin} ${repo}`, { stdio: "ignore" });
  const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "ignore" });
  git("git config user.email t@t.t");
  git("git config user.name t");
  git("echo base > base.txt");
  git("git add base.txt");
  git('git commit -qm "base"');
  git("git branch -M dev");
  git("git push -q origin dev");
  git("git remote set-head origin dev");
  git("git checkout -qb feature/x dev");
  git("echo change > change.txt");
  git("git add change.txt");
  git('git commit -qm "change"');
  git("git push -q origin feature/x");
  return { repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ----------------------------------------------- (1) explicit branch wins

{
  const { repo, cleanup } = setupRepo();
  try {
    execSync("git checkout -q --detach HEAD", { cwd: repo, stdio: "ignore" });
    const r = await resolveReviewBranch(
      { branch: "feature/x", head: "dev", cwd: repo },
      execp,
    );
    eq(r.branch, "feature/x", "(1) explicit branch wins over head and rev-parse");
    eq(r.source, "explicit", "(1) the source is `explicit`");
  } finally {
    cleanup();
  }
}

// --------------------------------------------- (2) head = local branch name

{
  const { repo, cleanup } = setupRepo();
  try {
    execSync("git checkout -q --detach HEAD", { cwd: repo, stdio: "ignore" });
    const r = await resolveReviewBranch({ head: "feature/x", cwd: repo }, execp);
    eq(r.branch, "feature/x", "(2) a local branch-named head is used");
    eq(r.source, "head", "(2) the source is `head`");
  } finally {
    cleanup();
  }
}

// --------------------------------------- (2b) head = `origin/feature/x`
// PM spec clarifications: `head: "origin/feature/x"` with a detached cwd
// keys the ledger entry and the disclosure marker as `feature/x` (the
// remote prefix is stripped so the key matches the guard's headRefName).

{
  const { repo, cleanup } = setupRepo();
  try {
    execSync("git checkout -q --detach HEAD", { cwd: repo, stdio: "ignore" });
    const r = await resolveReviewBranch({ head: "origin/feature/x", cwd: repo }, execp);
    eq(r.branch, "feature/x", "(2b) `origin/feature/x` normalises to `feature/x`");
    eq(r.source, "head", "(2b) the source is `head`");
  } finally {
    cleanup();
  }
}

// --------------------------- (2c) head = a ref that is NOT a branch (SHA)

{
  const { repo, cleanup } = setupRepo();
  try {
    // HEAD is on the named branch `feature/x`; a commit-SHA head must NOT
    // be used as the branch — the resolution degrades to rev-parse.
    const sha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const r = await resolveReviewBranch({ head: sha, cwd: repo }, execp);
    eq(r.branch, "feature/x", "(2c) a commit-SHA head is not a branch — rev-parse wins");
    eq(r.source, "rev-parse", "(2c) the source is `rev-parse`");
  } finally {
    cleanup();
  }
}

// ------------------------- (3) rev-parse recovery on a named-branch checkout

{
  const { repo, cleanup } = setupRepo();
  try {
    // No branch, no head — the checkout is ON feature/x (the tool path's
    // shape: `dispatch_lens_review` supplies neither).
    const r = await resolveReviewBranch({ cwd: repo }, execp);
    eq(r.branch, "feature/x", "(3) the checkout's own branch is recovered");
    eq(r.source, "rev-parse", "(3) the source is `rev-parse`");
  } finally {
    cleanup();
  }
}

// --------------------------------------- (4) detached HEAD → undefined
// The tool path on a detached worktree with nothing derivable: the resolver
// returns undefined; the CALLER renders the visible not-recorded note.

{
  const { repo, cleanup } = setupRepo();
  try {
    execSync("git checkout -q --detach HEAD", { cwd: repo, stdio: "ignore" });
    const head = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    eq(head, "HEAD", "(4) setup: HEAD is detached (the driver worktree shape)");
    const r = await resolveReviewBranch({ cwd: repo }, execp);
    eq(r.branch, undefined, "(4) detached HEAD with nothing derivable → undefined");
    eq(r.source, "none", "(4) the source is `none` (the caller renders the note)");
  } finally {
    cleanup();
  }
}

// ------------------------- (5) non-repo cwd → undefined (never throws)

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-branch-nongit-"));
  try {
    const r = await resolveReviewBranch({ cwd: dir }, execp);
    eq(r.branch, undefined, "(5) a non-repo cwd resolves to undefined");
    eq(r.source, "none", "(5) the source is `none`");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
