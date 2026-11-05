#!/usr/bin/env bun
/**
 * AC1 (#2030) — the pick batch's "already on the branch" test must recognise a
 * commit whose PATCH is on the branch, not only a commit that IS the tip.
 *
 * `isCommitOnBranch` answers "history contains the SHA" or "its tree equals the
 * branch tip's tree". The second only ever recognises the commit AT the tip, so
 * a second commit-pr — round 1 landed on the branch under new SHAs, a lens-fix
 * then rewrote the tip — re-picks round 1's non-tip commits, whose context no
 * longer matches, and the batch reports a cherry-pick conflict.
 *
 * Real git: one worktree whose commits are reproduced on the branch with
 * different SHAs, then advanced by a tip rewrite. Fails today because the
 * patch-equivalent commits are picked and the batch conflicts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cherryPickWorkstreams } from "../src/work-driver-cherry-pick-batch.ts";
import { git, realExec } from "./lib/worktree-fake-fixture.ts";

const FILE = "test-AC1-cherry-pick-patch-id-skip.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL ${FILE}: ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-ac1-"));
const repo = path.join(root, "repo");
const wt = path.join(root, "wt");
const BRANCH = "feature/issue-2030-x";

async function commitIn(dir: string, file: string, body: string, msg: string) {
  writeFileSync(path.join(dir, file), body);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", msg]);
}
const headIn = async (dir: string) => (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

try {
  await git(root, ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "note.txt"), "alpha\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = await headIn(repo);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  await git(repo, ["checkout", "-q", "-b", BRANCH]);

  // The developer's worktree: c1 then c2, both touching note.txt.
  await commitIn(wt, "note.txt", "alpha\nround-1\n", "developer: round 1");
  const c1 = await headIn(wt);
  await commitIn(wt, "note.txt", "alpha\nround-1\nround-2\n", "developer: round 2");
  const c2 = await headIn(wt);

  // The branch already carries BOTH patches — written from scratch, so both
  // SHAs differ from the worktree's — and a lens-fix then rewrote the tip,
  // which is what makes c1 non-tip and breaks a context-based replay.
  await commitIn(repo, "note.txt", "alpha\nround-1\nround-2\n", "consolidated round 1");
  await commitIn(repo, "lens.txt", "lens fix\n", "fix(lens): round 1 review findings");
  const tipBefore = await headIn(repo);

  const entries = await cherryPickWorkstreams(realExec, {
    repoRoot: repo,
    branchName: BRANCH,
    worktrees: { default: wt },
    commitShas: {},
    baseSha,
  });
  const list = Array.isArray(entries) ? entries : [];

  assert(
    Array.isArray(entries) && list.every((e) => e.status === "skipped"),
    `both patch-equivalent commits are SKIPPED, not re-picked (${JSON.stringify(entries)?.slice(0, 200)})`,
  );
  assert(
    list.map((e) => e.sha).join(",") === [c1, c2].join(","),
    `…and the skipped set is exactly the worktree's own range ${[c1, c2].join(",")}`,
  );
  assert(
    (await headIn(repo)) === tipBefore,
    "the branch is unchanged by the batch — no re-pick, no conflict, the lens-fix survives",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
