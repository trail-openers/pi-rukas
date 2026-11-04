#!/usr/bin/env bun
/**
 * #1975 AC1/AC2 — a reviewer child cannot change the reviewed worktree's files,
 * index, HEAD or branch, because it was never given that tree: `spawnSpecialist`
 * points its `cwd` at a throwaway detached worktree at the reviewed head, and
 * the review still sees exactly that head.
 *
 * The isolation sits at ONE choke point (the spawn path), so every case here
 * drives a REAL dispatch through it — the lens child, the adversarial loop's
 * reviewer, and a plain role as the control. There is no wrapper module to unit
 * test: what matters is that a child which never heard of the mechanism ran in a
 * directory it could destroy.
 *
 * Real temp repos, real git, a stubbed child process (lib/reviewer-child-stub.ts
 * — no Pi binary, no model, no tokens). The mutation bodies are real shell
 * commands run in the child's cwd. Each of the five escapes a different guard —
 * the write fence never judges git for a reviewer, `discardsUncommittedWork`
 * names only `checkout .|--|-f`, and a branch name is repo-global — so all five
 * are attempted, not just the first.
 *
 * Sections:
 *   A — a lens child (AC1): the five mutations land in its own tree and the
 *       reviewed worktree is byte-identical after; AC2: that tree was detached
 *       at the reviewed head and lives under TMPDIR.
 *   B — the adversarial loop: same for its reviewer child.
 *   C — the control: a non-reviewer role with the same cwd is NOT relocated.
 *   D — release is robust: no tree is left when the child's spawn throws or the
 *       child fails and the batch retries it.
 *   E — fail-open with a disclosed reason: a non-repo cwd or the operator's
 *       opt-out leaves the child in the reviewed tree rather than nowhere.
 *   F — the tree itself: 0700, released by path, provisioned by symlink only
 *       (never the project's `.pi/worktree-setup` hook), and every git call
 *       prefixed with the repo's NO_HOOKS pair.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { openReviewerTree } from "../src/reviewer-tree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { installStubChild, makeGit } from "./lib/reviewer-child-stub.ts";

isolateLedger();
// The child is a `node` stub, never a Pi process — but the dispatch reaches the
// real `child_process.spawn` seam, which the suite forbids by default
// (verify-loop.sh exports PI_ENSEMBLE_FORBID_LIVE_SPAWN). This file opts into
// the spawn path for its own process only, exactly as test-cancel.ts and
// test-child-process-group.ts do for theirs.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
const gitEnv = gitTestEnv();
const stub = installStubChild(gitEnv);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    // Written through the original method so the smoke pool's digest still
    // sees the failure line even though this file captures `process.stderr`.
    realErrWrite(`✗ ${msg}\n`);
    exit = 1;
  }
}

const { runLensChild } = await import("../src/lens-review-child.ts");
const { runAdversarialLoop } = await import("../src/adversarial.ts");
const { spawnSpecialist } = await import("../src/spawn.ts");

const LENS = { name: "SECURITY", skill: "code-review-security" };
const SKILLS = path.resolve(import.meta.dirname, "..", "..", "skill");

/**
 * The lines this process has written to stderr since the last call, and the
 * reason the WARN arms below can be asserted without patching `process.stderr`:
 * `traceWarn`'s own write is a `process.stderr.write`, so Bun's `console.error`
 * (which writes to fd 2 directly) captures it and nothing else does.
 */
const realErrWrite = process.stderr.write.bind(process.stderr);
// `traceWarn` writes with `process.stderr.write`, so a wrapper on that method
// sees every warning the module emits; `assert` above writes its `✗` lines
// through the original method, so the smoke pool's digest still sees failures.
let errWrites: string[] = [];
process.stderr.write = ((chunk: string | Uint8Array) => {
  errWrites.push(String(chunk));
  return true;
}) as typeof process.stderr.write;
/** The lines written to stderr since the previous call. */
function lastWarnLines(): string[] {
  const seen = errWrites;
  errWrites = [];
  return seen;
}

function makeRepo(tag: string): { dir: string; head: string; git: ReturnType<typeof makeGit> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `rev-1975-${tag}-`));
  const git = makeGit(dir, gitEnv);
  git.run("init", "-q", "-b", "main");
  git.run("config", "user.email", "t@example.com");
  git.run("config", "user.name", "test");
  writeFileSync(path.join(dir, "f.txt"), "one\n");
  git.run("add", "-A");
  git.run("commit", "-q", "-m", "base");
  // An untracked-but-stageable file: staging unrelated paths is the field
  // incident (25 files in an index, swept by the next developer commit).
  writeFileSync(path.join(dir, "untracked.txt"), "do not stage me\n");
  return { dir, head: git.out("rev-parse", "HEAD"), git };
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
function snapshot(git: ReturnType<typeof makeGit>) {
  return {
    status: git.out("status", "--porcelain", "--untracked-files=all"),
    head: git.out("rev-parse", "HEAD"),
    branch: git.out("symbolic-ref", "--short", "HEAD"),
    index: git.out("ls-files", "--stage"),
    // Only what the reviewed tree's OWN refs reach — a reviewer's commit in a
    // detached sibling must not appear here.
    log: git.out("log", "--oneline", "HEAD"),
  };
}

/**
 * The five field-observed mutations, run as the reviewer's own shell would run
 * them. Every attempt runs even after an earlier one fails, because a mutation
 * git refuses inside the throwaway tree must not hide the ones that would have
 * landed in the reviewed one.
 */
function attemptMutations(cwd: string, gitEnvDir: ReturnType<typeof makeGit>): string[] {
  const attempts: Array<[string, () => void]> = [
    ["write a file", () => writeFileSync(path.join(cwd, "PWNED"), "")],
    ["git add", () => gitEnvDir.run("add", "-A")],
    ["git checkout -b", () => gitEnvDir.run("checkout", "-q", "-b", "feature/wip")],
    [
      "git commit",
      () => {
        writeFileSync(path.join(cwd, "rogue.ts"), "export const rogue = 1;\n");
        gitEnvDir.run("add", "-A");
        gitEnvDir.run("commit", "-q", "-m", "reviewer experiment");
      },
    ],
    ["git stash", () => gitEnvDir.run("stash", "-u")],
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

/**
 * Run the mutations IN THE CHILD'S OWN cwd: the fixture hands each attempt a
 * git handle bound to the directory the child actually received, which is what
 * makes "the reviewer's tree, not the reviewed one" an executed fact.
 *
 * Refuses anything outside TMPDIR. These are the field-observed mutations, so
 * running them is the point — but a reviewer child that was NOT isolated must
 * not have its experiments written into the repository under review, which is
 * the very damage this mechanism exists to prevent. A refused cwd fails the
 * section that asked for it rather than escaping into the working tree.
 */
function mutateIn(cwd: string): { attempted: string[]; wrote: boolean } {
  if (!realpathSync(cwd).startsWith(realpathSync(os.tmpdir()))) {
    return { attempted: [], wrote: false };
  }
  const git = makeGit(cwd, gitEnv);
  const attempted = attemptMutations(cwd, git);
  return {
    attempted,
    wrote: existsSync(path.join(cwd, "PWNED")) && existsSync(path.join(cwd, "rogue.ts")),
  };
}

const strayTrees = (git: ReturnType<typeof makeGit>) =>
  git
    .out("worktree", "list")
    .split("\n")
    .filter((l) => l.includes("pi-rukas-review-"));

/** Drive one lens child through the real spawn path. */
const driveLensChild = (reviewedCwd: string, reply = "clean") => {
  stub.reply = reply;
  return runLensChild({
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
};

// ================================================================ A — AC1 + AC2, lens child

{
  const { dir, head, git } = makeRepo("lens");
  const before = snapshot(git);
  // Captured during the dispatch: the tree is gone once the spawn returns, so
  // every fact about it is recorded while the child is still running in it.
  const observed: { cwd: string; head: string; underTmp: boolean; wrote: boolean; n: number } = {
    cwd: "",
    head: "",
    underTmp: false,
    wrote: false,
    n: 0,
  };
  stub.body = (cwd) => {
    observed.cwd = cwd;
    // Read while the tree still exists — the spawn removes it in its `finally`.
    observed.head = makeGit(cwd, gitEnv).out("rev-parse", "HEAD");
    observed.underTmp = realpathSync(cwd).startsWith(realpathSync(os.tmpdir()));
    const m = mutateIn(cwd);
    observed.n = m.attempted.length;
    observed.wrote = m.wrote;
  };

  const result = await driveLensChild(dir);
  assert(result.ok, `A: the lens child's review still completed (${result.parseError ?? "ok"})`);
  const requested = stub.lastChildCwd();
  assert(requested !== undefined, "A: the lens child was spawned");
  assert(
    observed.cwd === requested,
    "A: the caller asked for the reviewed worktree (isolation is the spawn's)",
  );
  assert(observed.cwd !== dir, "A: the reviewer never ran in the reviewed worktree");
  assert(observed.n === 5, `A: all five mutation classes attempted (${observed.n})`);

  const after = snapshot(git);
  const unchangedA = JSON.stringify(after) === JSON.stringify(before);
  assert(
    unchangedA,
    `A: the reviewed worktree is byte-identical after all five mutations (status clean, same HEAD/branch/index)${
      unchangedA
        ? ""
        : `\n    before: ${JSON.stringify(before)}\n    after:  ${JSON.stringify(after)}`
    }`,
  );
  assert(!existsSync(path.join(dir, "PWNED")), "A: no PWNED file at the reviewed tree's root");
  assert(
    !git.out("log", "--oneline", "HEAD").includes("reviewer experiment"),
    "A: the reviewer's commit is not reachable from the reviewed tree's HEAD",
  );
  assert(
    git.out("rev-parse", "main") === head,
    "A: the reviewed branch still points at the reviewed head",
  );

  // AC2: the reviewer's own tree was detached at the reviewed head, and
  // everything the mutations produced stayed inside it.
  assert(observed.head === head, "AC2: the reviewer's cwd HEAD is exactly the reviewed head");
  assert(
    observed.wrote,
    "AC2: the mutations really landed in the reviewer's own tree (not the reviewed one)",
  );
  assert(observed.underTmp, "AC2: the throwaway tree lives under TMPDIR");
  assert(
    !existsSync(observed.cwd),
    "A: the spawn removed the throwaway tree when the child returned",
  );
  assert(strayTrees(git).length === 0, "A: no worktree registration survived the dispatch");
}

// ================================================================ B — adversarial loop

{
  const { dir, head, git } = makeRepo("adv");
  const before = snapshot(git);
  const reviewerCwds: string[] = [];
  const heads: string[] = [];
  let attempted = 0;
  // The loop's reviewer round is the only dispatch whose reply must carry a
  // verdict marker; every other child answers `clean`.
  stub.reply = "VERDICT: APPROVED\n\nno findings";
  stub.body = (cwd) => {
    reviewerCwds.push(cwd);
    heads.push(makeGit(cwd, gitEnv).out("rev-parse", "HEAD"));
    attempted += mutateIn(cwd).attempted.length;
  };
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
  stub.reply = "clean";
  assert(
    result.ok === true,
    `B: the loop still produced its verdict (${result.text.slice(0, 40)})`,
  );
  assert(reviewerCwds.length >= 1, "B: the adversarial reviewer was dispatched");
  assert(
    reviewerCwds.every((c) => c !== dir),
    "B: the reviewer's actual cwd is a throwaway tree, not the reviewed worktree",
  );
  assert(attempted >= 5, `B: all five mutation classes attempted (${attempted})`);
  const after = snapshot(git);
  const unchangedB = JSON.stringify(after) === JSON.stringify(before);
  assert(
    unchangedB,
    `B: the reviewed worktree is unchanged by the reviewer's mutations${
      unchangedB
        ? ""
        : `\n    before: ${JSON.stringify(before)}\n    after:  ${JSON.stringify(after)}`
    }`,
  );
  assert(strayTrees(git).length === 0, "B: the loop removed its throwaway tree on the clean exit");
  assert(
    heads.length > 0 && heads.every((h) => h === head),
    `B: every reviewer round's cwd HEAD equals the reviewed head (${heads.join(",")})`,
  );
  assert(
    !git.out("log", "--oneline", "HEAD").includes("reviewer experiment"),
    "B: the reviewer's commit is not reachable from the reviewed tree",
  );
  assert(
    git.out("rev-parse", "main") === head,
    "B: the reviewed branch still points at the reviewed head",
  );
}

// ================================================================ C — the control

{
  const { dir, git } = makeRepo("control");
  stub.body = undefined;
  const res = await spawnSpecialist({ role: "developer", prompt: "hello", cwd: dir }, {});
  assert(res.ok === true, `C: the non-reviewer child ran (${res.text.slice(0, 30)})`);
  assert(
    stub.lastChildCwd() === dir,
    "C: a non-reviewer role keeps the caller's cwd — no tree is made for it",
  );
  assert(strayTrees(git).length === 0, "C: no throwaway tree exists for a non-reviewer dispatch");
}

// ================================================================ D — release is robust

{
  const { dir, git } = makeRepo("spawn-throw");
  stub.body = undefined;
  stub.throwSpawn = true;
  let threw = false;
  try {
    await spawnSpecialist({ role: "code-review-specialist", prompt: "x", cwd: dir }, {});
  } catch {
    threw = true;
  }
  stub.throwSpawn = false;
  assert(threw, "D: a dispatch whose spawn throws still rejects (nothing swallows it)");
  assert(strayTrees(git).length === 0, "D: the tree is gone after a dispatch whose spawn threw");

  // A failing reviewer child still leaves no tree behind: the batch retries it,
  // so the tree outlives four attempts and is released by the dispatch's own
  // `finally`, not by any single attempt.
  const failing = makeRepo("child-fail");
  stub.body = undefined;
  stub.childFail = true;
  const res = await driveLensChild(failing.dir);
  stub.childFail = false;
  assert(!res.ok, "D: a failing lens child produces no approved result");
  assert(res.attempts > 1, `D: the failing child was retried in the SAME tree (${res.attempts})`);
  assert(strayTrees(failing.git).length === 0, "D: the tree is removed even when the child fails");
}

// ================================================================ E — fail-open, disclosed

{
  // A cwd that is not a git worktree: the child stays where the caller put it
  // rather than going nowhere.
  const plain = mkdtempSync(path.join(os.tmpdir(), "rev-1975-plain-"));
  stub.body = (cwd) => {
    writeFileSync(path.join(cwd, "kept.txt"), "still here\n");
  };
  const res = await spawnSpecialist(
    { role: "code-review-specialist", prompt: "x", cwd: plain },
    {},
  );
  assert(
    res.ok === true,
    "E: a non-repo cwd still spawns the reviewer (fail-open, not a lost review)",
  );
  assert(
    stub.lastChildCwd() === plain,
    "E: with no tree available the child runs in the caller's cwd",
  );
  stub.body = undefined;
  assert(
    existsSync(path.join(plain, "kept.txt")),
    "E: the reviewer's writes went to the cwd it got",
  );

  // The operator's opt-out: the child runs in the reviewed tree itself.
  const { dir, git } = makeRepo("optout");
  let ranIn = "";
  stub.body = (cwd) => {
    ranIn = cwd;
    writeFileSync(path.join(cwd, "PWNED"), "");
  };
  process.env.PI_ENSEMBLE_REVIEWER_ISOLATION = "0";
  const opted = await driveLensChild(dir);
  delete process.env.PI_ENSEMBLE_REVIEWER_ISOLATION;
  assert(opted.ok, "E: with the opt-out the review still ran");
  assert(ranIn === dir, "E: PI_ENSEMBLE_REVIEWER_ISOLATION=0 runs the child in the reviewed tree");
  assert(
    existsSync(path.join(dir, "PWNED")),
    "E: the opt-out really is an opt-out (the write landed)",
  );
  assert(strayTrees(git).length === 0, "E: the opt-out created no tree");
}

// ================================================================ F — the tree itself

{
  // A project with a `.pi/worktree-setup` hook that WOULD run arbitrary code,
  // and dependency dirs to link: the hook must never fire for a reviewer tree.
  const { dir: repo, head } = makeRepo("prov");
  const hookMark = path.join(repo, "HOOK-RAN");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nextension/node_modules/\nHOOK-RAN\n");
  // The dependency tree is gitignored and UNTRACKED (makeRepo has committed
  // everything else), which is the only shape the symlink path links.
  mkdirAll(path.join(repo, "extension", "node_modules", "dep"));
  writeFileSync(path.join(repo, "extension", "node_modules", "dep", "index.js"), "x\n");
  // The hook is NOT ignored — it is a tracked file, which is what a real project
  // has — so it is part of the commit and materialises in every tree.
  mkdirAll(path.join(repo, ".pi"));
  writeFileSync(path.join(repo, ".pi", "worktree-setup"), `#!/bin/sh\ntouch "${hookMark}"\n`);
  chmodSync(path.join(repo, ".pi", "worktree-setup"), 0o755);
  // The symlink path only considers a dependency dir inside a discovered
  // PACKAGE DIRECTORY — one carrying a manifest/lockfile — so the fixture has
  // to have one, as pi-rukas does.
  writeFileSync(path.join(repo, "extension/package.json"), '{"name":"ext"}\n');
  const provGit = makeGit(repo, gitEnv);
  provGit.run("add", "-A", "--", ".gitignore", ".pi/worktree-setup", "extension/package.json");
  provGit.run("commit", "-q", "-m", "fixture: hook, ignore rules, a package dir");
  const provHead = provGit.out("rev-parse", "HEAD");
  void head;

  // #1975 item 7 — the module's OWN git calls (common dir, prune, add, remove,
  // prune) carry the repo's NO_HOOKS pair. The provisioning probes this module
  // reaches through `linkShareableDeps` are `git check-ignore` reads and are
  // not this assertion's subject. Every argv the executor is handed is recorded
  // here, and the same recorder drives the leak arm below with `failRemove`.
  const calls: string[][] = [];
  let failRemove = false;
  const leakExec = async (
    cmd: string,
    opts: { cwd?: string; maxBuffer?: number; timeout?: number; argv?: string[] },
  ) => {
    const argv = [...(opts.argv ?? [])];
    calls.push(argv);
    if (failRemove && argv.includes("remove")) {
      throw Object.assign(new Error("git worktree remove refused"), { stderr: "cannot delete" });
    }
    return execp(cmd, { ...opts, argv });
  };
  // #1975 item 7 — the module's OWN git calls (common dir, prune, add, remove,
  // prune) carry the repo's NO_HOOKS pair. The provisioning probes this module
  // reaches through `linkShareableDeps` are `git check-ignore` reads and are
  // not this assertion's subject.
  const NO_HOOKS_PREFIX = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
  const tree = await openReviewerTree(leakExec, repo, provHead);
  assert(tree.kind === "tree", `F: a tree was opened (${tree.kind === "tree" ? "" : tree.reason})`);
  if (tree.kind === "tree") {
    const mode = statSync(tree.cwd).mode & 0o777;
    assert(mode === 0o700, `F: the throwaway tree is private (mode ${mode.toString(8)})`);
    assert(
      !existsSync(hookMark),
      "F: the project's .pi/worktree-setup hook did NOT run for a reviewer tree",
    );
    assert(
      existsSync(path.join(tree.cwd, "extension", "node_modules", "dep", "index.js")),
      "F: the dependency dirs ARE linked, so targeted checks stay runnable",
    );
    // #1975 item 7 continued — the create-side calls carry the pair; the
    // release-side calls are asserted by the leak arm below, which releases this
    // tree with `worktree remove` armed to fail.
    const gitCalls = calls.filter(
      (a) => a.includes("worktree") || a.includes("--git-common-dir"),
    );
    const unprefixed = gitCalls.filter((a) => a.join(" ").indexOf(NO_HOOKS_PREFIX.join(" ")) !== 0);
    assert(
      unprefixed.length === 0,
      `F: every reviewer-tree git call carries the NO_HOOKS prefix (${gitCalls.length} create-side calls, ${unprefixed.length} without it: ${unprefixed.map((a) => a.join(" ")).join(" | ")})`,
    );
    assert(strayTrees(provGit).length === 1, "F: the tree is registered while it is in use");
  }

  // A `worktree remove` that fails and leaves the directory behind must not be
  // swallowed: release this tree with the refusal armed, and read the
  // consequences — the tree survives, `release` still never throws, and the WARN
  // names the surviving path.
  lastWarnLines();
  failRemove = true;
  const leaked = tree.kind === "tree" ? tree.cwd : "";
  let released = true;
  if (tree.kind === "tree") {
    try {
      await tree.release();
    } catch {
      released = false;
    }
  }
  failRemove = false;
  assert(released, "F: a release whose `worktree remove` was refused still never throws");
  assert(existsSync(leaked), "F: the refused tree survived — this is the leak the WARN names");
  assert(
    calls.some(
      (a) =>
        a.includes("remove") &&
        a[a.length - 1] === leaked &&
        a.join(" ").indexOf(NO_HOOKS_PREFIX.join(" ")) === 0,
    ),
    `F: the refused call was this tree's own \`git worktree remove\` (${leaked})`,
  );
  const leakWarned = errWrites.some(
    (l) => l.includes("WARN") && l.includes("could not remove the throwaway tree") && l.includes(leaked),
  );
  assert(
    leakWarned,
    `F: a worktree remove that fails with the dir still present names the path on a WARN (${lastWarnLines().filter((l) => l.includes("reviewer-tree")).join(" / ") || "no reviewer-tree line at all"})`,
  );
  // The survivor is the fixture's to clean up, not the repository's.
  try {
    provGit.run("worktree", "remove", "--force", leaked);
  } catch {
    /* the leak arm above already proved the trace */
  }
}

function mkdirAll(abs: string): void {
  mkdirSync(abs, { recursive: true });
}

process.exit(exit);
