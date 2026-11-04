#!/usr/bin/env bun
/**
 * #1975 AC1/AC2 — a reviewer child cannot change the reviewed worktree's files,
 * index, HEAD or branch, because it was never given that tree: its cwd is a
 * throwaway detached worktree at the reviewed head, and the review still sees
 * exactly that head.
 *
 * Real temp repos, real git, stubbed spawner — no Pi child, no token spend (the
 * convention every sibling test states). The mutation bodies are real shell
 * commands run in the child's cwd. Each of the five escapes a different guard
 * — the write fence never judges git for a reviewer, `discardsUncommittedWork`
 * names only `checkout .|--|-f`, and a branch name is repo-global — so all five
 * are attempted, not just the first.
 *
 * Sections:
 *   A — `runLensChild`: the child runs in the throwaway tree, all five
 *       mutations land there, and the reviewed tree is byte-identical after.
 *   B — `runAdversarialLoop`: same, plus the fix pass keeps the real worktree.
 *   C — AC2: the reviewer's cwd HEAD equals the reviewed head, and the tree is
 *       detached and under TMPDIR.
 *   D — removal is robust: a tree left by a batch whose spawn threw is gone
 *       after `release()`, with no registration left behind.
 *   E — fail-open with a disclosed reason: a non-SHA head or the operator's
 *       opt-out gives no tree at all rather than a wrong one.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
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

type SpawnCall = { role: string; cwd?: string };
const spawnCalls: SpawnCall[] = [];
/** A cwd that makes the spawner throw (D: a mid-batch spawn failure). */
let throwIn: string | undefined;
/** The body the reviewer stub runs in its own cwd. */
let reviewerBody: ((cwd: string) => void) | null = null;

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1975",
  spawnSpecialist: async (spec: { role: string; cwd?: string }) => {
    const cwd = spec.cwd;
    if (throwIn !== undefined && cwd === throwIn) throw new Error("spawn exploded");
    spawnCalls.push({ role: spec.role, cwd });
    if (spec.role !== "developer") reviewerBody?.(cwd ?? process.cwd());
    const text =
      spec.role === "adversarial-developer"
        ? "VERDICT: APPROVED\n\nlooks good"
        : spec.role === "developer"
          ? "Applied."
          : "clean";
    return { role: spec.role, ok: true, text, toolUses: [], ms: 1, exitCode: 0 };
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

const { runLensChild } = await import("../src/lens-review-child.ts");
const { runAdversarialLoop } = await import("../src/adversarial.ts");
const { openReviewerTree } = await import("../src/reviewer-tree.ts");
const { runLensFanOut } = await import("../src/lens-review-isolation.ts");

// ---------------------------------------------------------------- fixtures

const gitEnv = gitTestEnv();
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: gitEnv });
const gitOut = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: gitEnv })
    .toString()
    .trim();

const LENS = { name: "SECURITY", skill: "code-review-security" };
const SKILLS = path.resolve(import.meta.dirname, "..", "..", "skill");

/** The per-lens spawner call the fan-out makes, with the tree as child cwd. */
const driveLensChild = (reviewedCwd: string, childCwd: string) =>
  runLensChild({
    lens: LENS,
    runId: "run-1975",
    skillsDir: SKILLS,
    context: "ctx",
    roster: [
      { name: "SECURITY", skill: "code-review-security", dir: "code-review-security" } as never,
    ],
    opts: { diff: "+added", cwd: reviewedCwd, childCwd },
    bumpBatch: () => {},
  });

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
  writeFileSync(path.join(dir, "unrelated.txt"), "do not stage me\n");
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
 * Deliberately repo-wide facts (a branch another worktree created, a commit
 * reachable only from a detached tree) are asserted separately, because git
 * makes those repo-global by design: `refs/heads/*` is one namespace shared by
 * every worktree, so a name a reviewer mints is visible from the main checkout
 * the way `git branch --list` shows a sibling's. What the AC governs is that the
 * reviewed tree itself — its files, its index, the commit HEAD names, and which
 * branch HEAD is on — is untouched, and that none of the reviewer's commits
 * became reachable from it.
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

// ================================================================ A + C

{
  const { dir, head } = makeRepo("lens");
  const before = snapshot(dir);
  let childCwd = "";
  let headAtSpawn = "";
  const attempted: string[] = [];
  reviewerBody = (cwd) => {
    childCwd = cwd;
    // Read while the tree still exists — it is removed in the batch's `finally`.
    headAtSpawn = gitOut(cwd, "rev-parse", "HEAD");
    attempted.push(...attemptMutations(cwd));
  };
  spawnCalls.length = 0;

  const tree = await openReviewerTree(execp, dir, head);
  assert(!!tree.cwd, `A: the fan-out got a throwaway tree (${tree.fallback ?? "ok"})`);
  if (tree.cwd) {
    const result = await driveLensChild(dir, tree.cwd);
    assert(result.ok, "A: the lens child's review still completed");
    assert(
      spawnCalls.length === 1 && spawnCalls[0].role === "code-review-specialist",
      `A: exactly one lens child was spawned (${spawnCalls.map((c) => c.role).join(",")})`,
    );
    assert(
      spawnCalls[0].cwd === tree.cwd,
      "A: the lens child's cwd is the throwaway tree, not the reviewed one",
    );
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
        (unchangedA
          ? ""
          : `\n    before: ${JSON.stringify(before)}\n    after:  ${JSON.stringify(after)}`),
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

    // C — AC2, read BEFORE the tree is released: the reviewer's own tree was
    // detached at the reviewed head (its ref, its index and its HEAD all say
    // `head`), while everything the mutations produced stayed inside it.
    assert(headAtSpawn === head, "C: the reviewer's cwd HEAD is exactly the reviewed head");
    assert(
      gitOut(childCwd, "rev-parse", `${head}^{commit}`) === head,
      "C: the commit the reviewer's tree was created at IS the reviewed head",
    );
    assert(
      existsSync(path.join(childCwd, "PWNED")) && existsSync(path.join(childCwd, "rogue.ts")),
      "C: the mutations really landed in the reviewer's own tree (not the reviewed one)",
    );
    assert(
      existsSync(path.join(childCwd, ".git")),
      "C: the reviewer's tree is its own linked worktree",
    );
    assert(
      realpathSync(childCwd).startsWith(realpathSync(os.tmpdir())),
      "C: the throwaway tree lives under TMPDIR",
    );

    await tree.release();
    assert(!existsSync(childCwd), "A: release() removed the throwaway tree");
    assert(strayTrees(dir).length === 0, "A: no worktree registration survived the release");
  }
}

// ================================================================ B

{
  const { dir, head } = makeRepo("adv");
  const before = snapshot(dir);
  const attempted: string[] = [];
  const reviewerCwds: string[] = [];
  const headsAtSpawn: string[] = [];
  reviewerBody = (cwd) => {
    reviewerCwds.push(cwd);
    // Read while the tree still exists — the loop removes it in its `finally`.
    headsAtSpawn.push(gitOut(cwd, "rev-parse", "HEAD"));
    attempted.push(...attemptMutations(cwd));
  };
  spawnCalls.length = 0;
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
  assert(
    result.ok === true,
    `B: the loop still produced its verdict (${result.text.slice(0, 60)})`,
  );
  const reviewers = spawnCalls.filter((c) => c.role === "adversarial-developer");
  assert(reviewers.length >= 1, "B: the adversarial reviewer was dispatched");
  assert(
    reviewers.length > 0 && reviewers.every((c) => c.cwd !== undefined && c.cwd !== dir),
    "B: the reviewer's cwd is a throwaway tree, not the reviewed worktree",
  );
  assert(attempted.length >= 5, `B: all five mutation classes attempted (${attempted.join(", ")})`);
  const after = snapshot(dir);
  const unchangedB = JSON.stringify(after) === JSON.stringify(before);
  assert(
    unchangedB,
    "B: the reviewed worktree is unchanged by the reviewer's mutations" +
      (unchangedB
        ? ""
        : `\n    before: ${JSON.stringify(before)}\n    after:  ${JSON.stringify(after)}`),
  );
  assert(
    spawnCalls.every((c) => c.role !== "developer" || c.cwd === dir),
    "B: the fix pass still runs in the real worktree (its work has to land)",
  );
  assert(strayTrees(dir).length === 0, "B: the loop removed its throwaway tree on the clean exit");
  assert(headsAtSpawn.length > 0, "B: the reviewer ran at least once");
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

// ================================================================ D

{
  const { dir, head } = makeRepo("throw");
  const tree = await openReviewerTree(execp, dir, head);
  assert(!!tree.cwd, `D: tree created for the abort case (${tree.fallback ?? "ok"})`);
  if (tree.cwd) {
    const made = tree.cwd;
    throwIn = made;
    reviewerBody = () => {};
    spawnCalls.length = 0;
    const result = await driveLensChild(dir, made);
    assert(!result.ok, "D: a batch whose spawn threw produced no approved lens result");
    throwIn = undefined;
    assert(existsSync(made), "D: the tree survives while the batch holds it");
    await tree.release();
    assert(!existsSync(made), "D: release() removed the tree a failed batch left behind");
    assert(strayTrees(dir).length === 0, "D: no registration survives a batch whose spawn threw");
  }
}

// ================================================================ F — the fan-out owns the tree

{
  // The fan-out — not the individual child — owns the tree's lifetime: it is
  // created before the first spawn and removed after the LAST child returns,
  // including when a child throws. This is the seam `runLensReview` calls.
  const { dir, head } = makeRepo("fanout");
  const seen: string[] = [];
  reviewerBody = (cwd) => {
    seen.push(cwd);
    attemptMutations(cwd);
  };
  const input = {
    lensChildFn: (async (a: { lens: unknown; opts: { childCwd?: string } }) => {
      spawnCalls.length = 0;
      reviewerBody?.(a.opts.childCwd ?? dir);
      return {
        lens: "SECURITY",
        ok: true,
        ms: 1,
        startMs: 0,
        findings: [],
        attempts: 1,
        blocked: false,
      };
    }) as never,
    runId: "run-1975",
    skillsDir: SKILLS,
    context: "ctx",
    roster: [
      { name: "SECURITY", skill: "code-review-security", dir: "code-review-security" },
      { name: "SIMPLICITY", skill: "code-review-simplicity", dir: "code-review-simplicity" },
    ] as never,
    opts: { cwd: dir } as never,
    diff: "+x",
    priorFindings: undefined,
    bumpBatch: () => {},
  };
  const before = snapshot(dir);
  const batch = await runLensFanOut(input, head);
  assert(batch.value.length === 2, "F: both healthy lenses were dispatched");
  assert(seen.length === 2 && seen[0] === seen[1], "F: the batch shared ONE tree");
  assert(seen[0] !== dir, "F: the shared tree is not the reviewed worktree");
  assert(
    JSON.stringify(snapshot(dir)) === JSON.stringify(before),
    "F: the reviewed worktree is unchanged after a whole batch of mutations",
  );
  assert(strayTrees(dir).length === 0, "F: the fan-out removed the tree when the batch returned");
  // A throwing child still releases the tree.
  const throwing = {
    ...input,
    lensChildFn: (async () => {
      throw new Error("child threw");
    }) as never,
  };
  let threw = false;
  try {
    await runLensFanOut(throwing, head);
  } catch {
    threw = true;
  }
  assert(threw, "F: a throwing child propagates (the fan-out does not swallow it)");
  assert(strayTrees(dir).length === 0, "F: the tree is removed even when a child throws");
  // No SHA resolved (a blocked/carried review) → no tree, children run at cwd.
  const noHead = await runLensFanOut(input, undefined);
  assert(noHead.value.length === 2, "F: with no head SHA the review still ran");
  assert(strayTrees(dir).length === 0, "F: no tree is created without a resolved head");
}

// ================================================================ E

{
  const { dir } = makeRepo("fallback");
  const head = gitOut(dir, "rev-parse", "HEAD");

  const refName = await openReviewerTree(execp, dir, "HEAD");
  assert(!refName.cwd, "E: a ref name is refused — no tree is made from anything but a SHA");
  assert(!!refName.fallback, `E: the refusal carries a disclosed reason (${refName.fallback})`);

  const ok = await openReviewerTree(execp, dir, head);
  assert(!!ok.cwd, "E: a real 40-char SHA does get a tree");
  await ok.release?.();

  process.env.PI_ENSEMBLE_REVIEWER_ISOLATION = "0";
  const opted = await openReviewerTree(execp, dir, head);
  assert(
    !opted.cwd && !!opted.fallback,
    "E: the operator's opt-out falls back to the reviewed tree, with the reason",
  );
  delete process.env.PI_ENSEMBLE_REVIEWER_ISOLATION;
}

process.exit(exit);
