#!/usr/bin/env bun
/**
 * #1016 — develop-path git writes are contained, and a reused dependent
 * worktree must contain its resolved base. Real git worktrees:
 *  1. backupInterruptedWorktrees refuses a state path that is the repo root
 *     (outside `.worktrees/`) and writes nothing there.
 *  2. reuseRefusal accepts a worktree whose HEAD contains the base, and refuses
 *     one whose HEAD does not (an unknown base, a non-SHA base).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupInterruptedWorktrees } from "../src/work-develop-resume-backup.ts";
import { reuseRefusal } from "../src/work-develop-reuse.ts";
import { execp as execFn } from "../src/work-driver-verify.ts";
import { gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const dir = await mkdtemp(path.join(tmpdir(), "contain-1016-"));
try {
  const shas = await makeBaseWorktrees(dir, ["task-a", "task-b"]);
  const wt = (id: string) => path.join(dir, ".worktrees", id);

  // 1. A state path pointing at the repo root: refused, no git write lands there.
  gitIn(dir, ["init", "-q"]);
  gitIn(dir, ["commit", "--allow-empty", "-qm", "root"]);
  await writeFile(path.join(dir, "root-dirt.txt"), "dirt");
  const headBefore = gitIn(dir, ["rev-parse", "HEAD"]);
  const statusBefore = gitIn(dir, ["status", "--porcelain"]);
  const backup = await backupInterruptedWorktrees({
    execFn,
    repoRoot: dir,
    scratchAbs: path.join(dir, "tmp", "issue-1"),
    ids: ["task-a"],
    worktrees: { "task-a": dir },
    baseFor: () => shas["task-a"],
  });
  assert(
    (backup.refused["task-a"] ?? "").includes("refused"),
    "#1016: a repo-root state path is refused by the resume backup",
  );
  assert(Object.keys(backup.saved).length === 0, "#1016: no patch is saved for a refused path");
  assert(
    gitIn(dir, ["rev-parse", "HEAD"]) === headBefore,
    "#1016: no commit lands on the repo root",
  );
  assert(
    gitIn(dir, ["status", "--porcelain"]) === statusBefore,
    "#1016: the repo root's index and worktree are untouched",
  );

  // 2. Reuse: the base must be an ancestor of HEAD.
  assert(
    (await reuseRefusal(execFn, wt("task-b"), shas["task-b"])) === undefined,
    "#1016: a reused worktree whose HEAD equals its base is accepted",
  );
  const unknown = "0123456789abcdef0123456789abcdef01234567";
  const refusal = await reuseRefusal(execFn, wt("task-b"), unknown);
  assert(
    refusal?.startsWith("reused dependent worktree refused") === true,
    "#1016: a reused worktree whose HEAD lacks the resolved base is refused with a named reason",
  );
  assert(
    (await reuseRefusal(execFn, wt("task-b"), "main")) !== undefined,
    "#1016: a non-SHA resolved base is refused, never passed to git",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
