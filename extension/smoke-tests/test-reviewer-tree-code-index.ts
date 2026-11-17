#!/usr/bin/env bun
/**
 * #2329 — a reviewer child in a throwaway tree is told which codebase-memory
 * project to query. The tree under TMPDIR has no index, and no indexed root
 * contains it, so a project name derived from the child's own cwd answers
 * "project not found". The name it is given is the reviewed checkout's own,
 * or the main checkout's when the reviewed tree sits under its `.worktrees/`.
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

const capture = async (role: string, cwd = reviewed) => {
  let seen: DispatchSpec | undefined;
  await runWithReviewerTree({ role, prompt: "REVIEW THIS", cwd }, async (s) => {
    seen = s;
    return { role, ok: true, text: "", toolUses: [] } as unknown as DispatchResult;
  });
  return seen as DispatchSpec;
};

const lens = await capture("code-review-specialist");
const expected = codebaseMemoryProject(main);
assert(
  lens.cwd !== reviewed && lens.cwd?.includes("pi-rukas-review-") === true,
  "the lens child runs in a throwaway tree",
);
assert(
  lens.prompt.includes(`project "${expected}"`),
  `a .worktrees/ tree's reviewer is given the main checkout's project (${expected})`,
);
assert(
  lens.prompt.includes(`commit ${head}`) && !lens.prompt.includes(main),
  "the prompt names the pinned SHA and not the live checkout's path",
);
assert(lens.prompt.endsWith("REVIEW THIS"), "the caller's prompt follows the note unchanged");

const adv = await capture("adversarial-developer");
assert(adv.prompt.includes(`project "${expected}"`), "the adversarial child is given it too");

const sibling = `${main}-sibling`;
git.run("worktree", "add", "-q", "-b", "issue-8", sibling);
const sib = await capture("code-review-specialist", sibling);
assert(
  sib.prompt.includes(`project "${codebaseMemoryProject(sibling)}"`),
  "a sibling worktree's reviewer is given that worktree's own project",
);

process.exit(exit);
