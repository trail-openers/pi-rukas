#!/usr/bin/env bun
/**
 * #1975 AC1/AC2 — a reviewer child cannot change the reviewed worktree's files,
 * index, HEAD or branch, because it was never given that tree: `spawnSpecialist`
 * points its `cwd` at a throwaway detached worktree at the reviewed head, and
 * the review still sees exactly that head.
 *
 * The isolation lives at ONE choke point (the spawn path), so every case here
 * drives a REAL reviewer dispatch through it — the lens child, the adversarial
 * loop's reviewer, and a plain role as the control. No wrapper modules to unit
 * test: what matters is that a child which never heard of the mechanism ran in
 * a directory it could destroy.
 *
 * Real temp repos, real git, stubbed `child_process.spawn` (so no Pi child and
 * no token spend — the convention every sibling test states). The mutation
 * bodies are real shell commands run in the child's cwd. Each of the five
 * escapes a different guard — the write fence never judges git for a reviewer,
 * `discardsUncommittedWork` names only `checkout .|--|-f`, and a branch name is
 * repo-global — so all five are attempted, not just the first.
 *
 * Sections:
 *   A — a lens child (AC1): the five mutations land in its own tree and the
 *       reviewed worktree is byte-identical after; AC2: that tree was detached
 *       at the reviewed head and lives under TMPDIR.
 *   B — the adversarial loop: same for its reviewer child, and the fix pass
 *       keeps the real worktree.
 *   C — the control: a non-reviewer role with the same cwd is NOT relocated.
 *   D — release is robust: the tree is gone when the dispatch throws, when the
 *       child's spawn throws, and after a whole batch.
 *   E — fail-open with a disclosed reason: a non-repo cwd or the operator's
 *       opt-out leaves the child in the reviewed tree rather than nowhere.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();
gitTestEnv();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- mocks

/** What the stubbed child spawn recorded: the cwd the caller asked for, and the
 * cwd the child ACTUALLY got (from the real spawn's options). */
type SpawnCall = { role: string; requested?: string; actual?: string };
const spawnCalls: SpawnCall[] = [];
/** The bodies the reviewer stub runs, one per dispatch: a retry re-spawns the
 * same lens, so each attempt gets its own observation. */
type Body = (cwd: string) => void;
let bodies: Body[] = [];
/** Set to make the child's `spawn()` itself throw (D). */
let throwOnSpawn = false;
/** The pending dispatch whose cwd the stubbed spawn reports back. */
let pendingCall: SpawnCall | undefined;

const gitEnv = gitTestEnv();

// The one child that ever exists is a stub: `node -e` prints an agent_end JSON
// line and exits, so no Pi binary, no model, no tokens — and `spawnSpecialist`
// still runs its real cwd plumbing, including the #1975 relocation.
const STUB_CHILD = "console.log(JSON.stringify({type:'agent_end'}))";
mock.module(new URL("node:child_process", import.meta.url).href, () => ({
  ...require("node:child_process"),
  spawn: (_cmd: string, args: string[], opts: { cwd?: string }) => {
    if (throwOnSpawn) throw new Error("spawn exploded");
    // The relocation is visible exactly here: `opts.cwd` is what the child gets.
    if (pendingCall) pendingCall.actual = opts?.cwd;
    const body = bodies[bodies.length - 1];
    if (body) {
      bodies.pop();
      body(opts?.cwd ?? process.cwd());
    }
    const { spawn: realSpawn } = require("node:child_process");
    return realSpawn(process.execPath, ["-e", STUB_CHILD], {
      ...opts,
      env: gitEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  },
}));

const realDeck = await import("../src/dispatch-deck.ts");
mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...realDeck,
  startEntry: () => {},
  updateEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
  clearBatchEntry: () => {},
}));
const realRegistry = await import("../src/async-jobs-registry.ts");
mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...realRegistry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));

const { spawnSpecialist } = await import("../src/spawn.ts");
const { runLensChild } = await import("../src/lens-review-child.ts");
const { runAdversarialLoop } = await import("../src/adversarial.ts");

// ---------------------------------------------------------------- fixtures

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: gitEnv });
const gitOut = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: gitEnv })
    .toString()
    .trim();

const LENS = { name: "SECURITY", skill: "code-review-security" };
const SKILLS = path.resolve(import.meta.dirname, "..", "..", "skill");

/** Record the dispatch and the cwd the caller asked for. The stubbed spawn
 * fills in `actual` and runs `reviewerBody` in it. */
function recordDispatch(role: string, requested?: string): SpawnCall {
  const call: SpawnCall = { role, requested };
  spawnCalls.push(call);
  return call;
}

function makeRepo(tag: string): { dir: string; head: string; branch: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `rev-1975-${tag}-`));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "f.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  // An untracked-but-stageable file: staging unrelated paths is the field
  // incident (25 files in an index, swept by the next developer commit).
  writeFileSync(path.join(dir, "untracked.txt"), "do not stage me\n");
  return {
    dir,
    head: gitOut(dir, "rev-parse", "HEAD"),
    branch: gitOut(dir, "symbolic-ref", "--short", "HEAD"),
  };
}

/**
 * Everything a reviewer could have changed about THIS TREE: its working files,
 * its index, the commit its HEAD points at, and the branch it sits on.
 *
 * Repo-wide facts (a branch another worktree created, a commit reachable only
 * from a detached tree) are asserted separately, because git makes those
 * repo-global by design: `refs/heads/*` is one namespace shared by every
 * worktree. What the AC governs is that the reviewed tree itself — its files,
 * its index, the commit HEAD names, and which branch HEAD is on — is untouched,
 * and that none of the reviewer's commits became reachable from it.
 */
function snapshot(dir: string) {
  return {
    status: gitOut(dir, "status", "--porcelain", "--untracked-files=all"),
    head: gitOut(dir, "rev-parse", "HEAD"),
    branch: gitOut(dir, "symbolic-ref", "--short", "HEAD"),
    index: gitOut(dir, "ls-files", "--stage"),
    // Only what the reviewed tree's OWN refs reach — a reviewer's commit in a
    // detached sibling must not appear here.
    log: gitOut(dir, "log", "--oneline", "HEAD"),
  };
}

/**
 * The five field-observed mutations, run as the reviewer's own shell would run
 * them. Every attempt runs even after an earlier one fails, because a mutation
 * git refuses inside the throwaway tree must not hide the ones that would have
 * landed in the reviewed one.
 */
function attemptMutations(cwd: string): string[] {
  const attempts: Array<[string, () => void]> = [
    ["write a file", () => writeFileSync(path.join(cwd, "PWNED"), "")],
    ["git add", () => git(cwd, "add", "-A")],
    ["git checkout -b", () => git(cwd, "checkout", "-q", "-b", "feature/wip")],
    [
      "git commit",
      () => {
        writeFileSync(path.join(cwd, "rogue.ts"), "export const rogue = 1;\n");
        git(cwd, "add", "-A");
        git(cwd, "commit", "-q", "-m", "reviewer experiment");
      },
    ],
    ["git stash", () => git(cwd, "stash", "-u")],
  ];
  const done: string[] = [];
  for (const [name, run] of attempts) {
    try {
      run();
    } catch {
      /* git refusing in the throwaway tree is not a failure of this test */
    }
    done.push(name);
  }
  return done;
}

const strayTrees = (dir: string) =>
  gitOut(dir, "worktree", "list")
    .split("\n")
    .filter((l) => l.includes("pi-rukas-review-"));

/** Drive one lens child through the real spawn path. */
const driveLensChild = async (reviewedCwd: string) => {
  const call = recordDispatch("code-review-specialist", reviewedCwd);
  pendingCall = call;
  try {
    return await runLensChild({
      lens: LENS,
      runId: "run-1975",
      skillsDir: SKILLS,
      context: "ctx",
      roster: [
        { name: "SECURITY", skill: "code-review-security", dir: "code-review-security" } as never,
      ],
      opts: { diff: "+added", cwd: reviewedCwd },
      bumpBatch: () => {},
    });
  } finally {
    pendingCall = undefined;
  }
};

// ================================================================ A — AC1 + AC2, lens child

{
  const { dir, head } = makeRepo("lens");
  const before = snapshot(dir);
  let childCwd = "";
  let headAtSpawn = "";
  const attempted: string[] = [];
  bodies = [
    (cwd) => {
      childCwd = cwd;
      // Read while the tree still exists — the spawn removes it in its `finally`.
      headAtSpawn = gitOut(cwd, "rev-parse", "HEAD");
      attempted.push(...attemptMutations(cwd));
    },
  ];
  spawnCalls.length = 0;

  const result = await driveLensChild(dir);
  assert(result.ok, `A: the lens child's review still completed (${result.parseError ?? "ok"})`);
  assert(
    spawnCalls.length === 1 && spawnCalls[0].role === "code-review-specialist",
    `A: exactly one lens child was spawned (${spawnCalls.map((c) => c.role).join(",")})`,
  );
  const requested = spawnCalls[0].requested;
  assert(requested === dir, "A: the CALLER asked for the reviewed worktree (isolation is the spawn's)");
  assert(childCwd !== dir, "A: the reviewer never ran in the reviewed worktree");
  assert(
    attempted.length === 5,
    `A: all five mutation classes attempted (${attempted.join(", ")})`,
  );

  const after = snapshot(dir);
  const unchangedA = JSON.stringify(after) === JSON.stringify(before);
  assert(
    unchangedA,
    "A: the reviewed worktree is byte-identical after all five mutations (status clean, same HEAD/branch/index)" +
      (unchangedA ? "" : `\n    before: ${JSON.stringify(before)}\n    after:  ${JSON.stringify(after)}`),
  );
  assert(!existsSync(path.join(dir, "PWNED")), "A: no PWNED file at the reviewed tree's root");
  assert(
    !gitOut(dir, "log", "--oneline", "HEAD").includes("reviewer experiment"),
    "A: the reviewer's commit is not reachable from the reviewed tree's HEAD",
  );
  assert(
    gitOut(dir, "rev-parse", "main") === head,
    "A: the reviewed branch still points at the reviewed head",
  );

  // AC2, read while the tree existed: the reviewer's own tree was detached at
  // the reviewed head, and everything the mutations produced stayed inside it.
  assert(headAtSpawn === head, "AC2: the reviewer's cwd HEAD is exactly the reviewed head");
  assert(
    existsSync(path.join(childCwd, "PWNED")) && existsSync(path.join(childCwd, "rogue.ts")),
    "AC2: the mutations really landed in the reviewer's own tree (not the reviewed one)",
  );
  assert(existsSync(path.join(childCwd, ".git")), "AC2: the reviewer's tree is its own linked worktree");
  assert(
    realpathSync(childCwd).startsWith(realpathSync(os.tmpdir())),
    "AC2: the throwaway tree lives under TMPDIR",
  );

  assert(!existsSync(childCwd), "A: the spawn removed the throwaway tree when the child returned");
  assert(strayTrees(dir).length === 0, "A: no worktree registration survived the dispatch");
}

// ================================================================ B — adversarial loop

{
  const { dir, head } = makeRepo("adv");
  const before = snapshot(dir);
  const attempted: string[] = [];
  const reviewerCwds: string[] = [];
  const headsAtSpawn: string[] = [];
  bodies = [
    (cwd) => {
      reviewerCwds.push(cwd);
      headsAtSpawn.push(gitOut(cwd, "rev-parse", "HEAD"));
      attempted.push(...attemptMutations(cwd));
    },
  ];
  spawnCalls.length = 0;
  const advCall = recordDispatch("adversarial-developer", dir);
  pendingCall = advCall;
  const result = await runAdversarialLoop(
    {
      diff: "+added line",
      context: "ctx",
      workCwd: dir,
      reportOnly: true,
      reportVerdict: "terminal",
    },
    new AbortController().signal,
    "job-1975",
  );
  pendingCall = undefined;
  assert(result.ok === true, `B: the loop still produced its verdict (${result.text.slice(0, 60)})`);
  const reviewers = spawnCalls.filter((c) => c.role === "adversarial-developer");
  assert(
    reviewerCwds.length >= 1,
    `B: the adversarial reviewer was dispatched (${spawnCalls.map((c) => c.role).join(",")})`,
  );
  assert(
    reviewers.length > 0 && reviewers.every((c) => c.requested === dir),
    "B: the loop asked for the reviewed worktree; the spawn relocated the child",
  );
  assert(
    reviewerCwds.length > 0 && reviewerCwds.every((c) => c !== dir),
    "B: the reviewer's actual cwd is a throwaway tree, not the reviewed worktree",
  );
  assert(
    attempted.length >= 5,
    `B: all five mutation classes attempted (${attempted.join(", ")})`,
  );
  const after = snapshot(dir);
  const unchangedB = JSON.stringify(after) === JSON.stringify(before);
  assert(
    unchangedB,
    "B: the reviewed worktree is unchanged by the reviewer's mutations" +
      (unchangedB ? "" : `\n    before: ${JSON.stringify(before)}\n    after:  ${JSON.stringify(after)}`),
  );
  assert(strayTrees(dir).length === 0, "B: the loop removed its throwaway tree on the clean exit");
  assert(
    headsAtSpawn.every((h) => h === head),
    `B: every reviewer round's cwd HEAD equals the reviewed head (${headsAtSpawn.join(",")})`,
  );
  assert(
    !gitOut(dir, "log", "--oneline", "HEAD").includes("reviewer experiment"),
    "B: the reviewer's commit is not reachable from the reviewed tree",
  );
  assert(
    gitOut(dir, "rev-parse", "main") === head,
    "B: the reviewed branch still points at the reviewed head",
  );
}

// ================================================================ C — the control

{
  const { dir } = makeRepo("control");
  bodies = []; // a non-reviewer child is observed through the spawn's own options
  spawnCalls.length = 0;
  const control = recordDispatch("developer", dir);
  pendingCall = control;
  const res = await spawnSpecialist({ role: "developer", prompt: "hello", cwd: dir }, {});
  pendingCall = undefined;
  assert(res.ok === true, `C: the non-reviewer child ran (${res.text.slice(0, 40)})`);
  // The stub records the cwd it ACTUALLY ran in (from spawn's options).
  const ran = control.actual;
  assert(ran === dir, "C: a non-reviewer role keeps the caller's cwd — no tree is made for it");
  assert(strayTrees(dir).length === 0, "C: no throwaway tree exists for a non-reviewer dispatch");
}

// ================================================================ D — release is robust

{
  // A child whose spawn() itself throws must still leave no tree behind.
  const { dir } = makeRepo("spawn-throw");
  bodies = [];
  throwOnSpawn = true;
  let threw = false;
  try {
    await spawnSpecialist({ role: "code-review-specialist", prompt: "x", cwd: dir }, {});
  } catch {
    threw = true;
  }
  throwOnSpawn = false;
  assert(threw, "D: a dispatch whose spawn throws still rejects (nothing swallows it)");
  assert(strayTrees(dir).length === 0, "D: the tree is gone after a dispatch whose spawn threw");

  // A reviewer child that throws inside the batch still leaves no tree behind.
  const throwing = { dir: makeRepo("child-throw").dir };
  bodies = [
    () => {
      throw new Error("child exploded");
    },
  ];
  const res = await driveLensChild(throwing.dir);
  assert(!res.ok, "D: a lens child that throws produces no approved result");
  assert(strayTrees(throwing.dir).length === 0, "D: the tree is removed even when the child throws");
}

// ================================================================ E — fail-open, disclosed

{
  // A cwd that is not a git worktree: the child stays where the caller put it
  // rather than going nowhere.
  const plain = mkdtempSync(path.join(os.tmpdir(), "rev-1975-plain-"));
  bodies = [
    (cwd) => {
      writeFileSync(path.join(cwd, "kept.txt"), "still here\n");
    },
  ];
  spawnCalls.length = 0;
  const plainCall = recordDispatch("code-review-specialist", plain);
  pendingCall = plainCall;
  const res = await spawnSpecialist({ role: "code-review-specialist", prompt: "x", cwd: plain }, {});
  pendingCall = undefined;
  assert(res.ok === true, "E: a non-repo cwd still spawns the reviewer (fail-open, not a lost review)");
  const ran = plainCall.actual;
  assert(ran === plain, "E: with no tree available the child runs in the caller's cwd");
  assert(existsSync(path.join(plain, "kept.txt")), "E: the reviewer's writes went to the cwd it got");

  // The operator's opt-out: the child runs in the reviewed tree itself.
  const { dir, head } = makeRepo("optout");
  const before = snapshot(dir);
  let ranIn = "";
  bodies = [
    (cwd) => {
      ranIn = cwd;
      writeFileSync(path.join(cwd, "PWNED"), "");
    },
  ];
  process.env.PI_ENSEMBLE_REVIEWER_ISOLATION = "0";
  spawnCalls.length = 0;
  const opted = await driveLensChild(dir);
  delete process.env.PI_ENSEMBLE_REVIEWER_ISOLATION;
  assert(opted.ok, "E: with the opt-out the review still ran");
  assert(ranIn === dir, "E: PI_ENSEMBLE_REVIEWER_ISOLATION=0 runs the child in the reviewed tree");
  assert(existsSync(path.join(dir, "PWNED")), "E: the opt-out really is an opt-out (the write landed)");
  void before;
  void head;
  assert(strayTrees(dir).length === 0, "E: the opt-out created no tree");
}

process.exit(exit);
