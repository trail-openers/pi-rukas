#!/usr/bin/env bun
/**
 * #2329 — a reviewer child in a throwaway tree is told which codebase-memory
 * project to query. The tree under TMPDIR has no index, and no indexed root
 * contains it, so a project name derived from the child's own cwd answers
 * "project not found". The name it is given is the main checkout's, which is
 * the root a reviewed `.worktrees/` tree sits under.
 *
 * Drives `runWithReviewerTree` with a capturing dispatch against a real temp
 * repo: what the dispatch receives is what the child's prompt carries.
 */
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codebaseMemoryProject } from "../src/reviewer-tree.ts";
import { runWithReviewerTree } from "../src/spawn-reviewer-isolation.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { makeGit } from "./lib/reviewer-child-stub.ts";

isolateLedger();
const gitEnv = gitTestEnv();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The server's own derivation, pinned on the field name and the edge rules.
assert(
  codebaseMemoryProject("/home/boss/tehas/work/tehas") === "home-boss-tehas-work-tehas",
  "an absolute root maps to its path with '/' as '-' and no leading dash",
);
assert(
  codebaseMemoryProject("/srv/my project//a..b/") === "srv-my-project-a.b",
  "unsafe bytes become '-', runs of '-' and '.' collapse, a trailing '-' goes",
);
assert(codebaseMemoryProject("/srv/ä") === "srv-c3a4", "a non-ASCII byte becomes two hex digits");

const main = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rev-2329-")));
const git = makeGit(main, gitEnv);
git.run("init", "-q", "-b", "main");
writeFileSync(path.join(main, "f.txt"), "one\n");
git.run("add", "-A");
git.run("-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-q", "-m", "base");
const reviewed = path.join(main, ".worktrees", "issue-7");
git.run("worktree", "add", "-q", "-b", "issue-7", reviewed);
const head = git.out("rev-parse", "HEAD");

const capture = async (role: string) => {
  let seen: DispatchSpec | undefined;
  await runWithReviewerTree({ role, prompt: "REVIEW THIS", cwd: reviewed }, async (s) => {
    seen = s;
    return { role, ok: true, text: "", toolUses: [] } as unknown as DispatchResult;
  });
  return seen as DispatchSpec;
};

const lens = await capture("code-review-specialist");
const expected = main.slice(1).replaceAll("/", "-");
assert(
  lens.cwd !== reviewed && lens.cwd?.includes("pi-rukas-review-") === true,
  "the lens child runs in a throwaway tree",
);
assert(
  lens.prompt.includes(`project "${expected}"`),
  `the lens child is given the main checkout's project (${expected})`,
);
assert(
  lens.prompt.includes(`copy of ${main} at commit ${head}`),
  "the prompt names the copied root and the pinned SHA",
);
assert(lens.prompt.endsWith("REVIEW THIS"), "the caller's prompt follows the note unchanged");

const dev = await capture("developer");
assert(
  dev.prompt === "REVIEW THIS" && dev.cwd === reviewed,
  "a non-reviewer role is neither relocated nor told a project",
);

process.exit(exit);
