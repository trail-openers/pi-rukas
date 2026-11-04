#!/usr/bin/env bun
/**
 * #1975 AC2 — the throwaway reviewer tree is a private, hooked-free, released
 * directory: mode 0700, provisioned by symlink only (the project's
 * `.pi/worktree-setup` must NEVER run in a directory a reviewer's bash can
 * reach), every git call this module makes prefixed with the repo's NO_HOOKS
 * pair, and a `git worktree remove` that is refused leaves the directory
 * standing WITH a WARN naming the path rather than a silent leak.
 *
 * Split from test-reviewer-tree-isolation.ts for the §12 size cap: sections A-E
 * there drive a real dispatch through the spawn choke point; this file drives
 * `openReviewerTree` directly, because the rules it pins are the tree's own and
 * need no child at all. A recording executor is what makes the git-call rules
 * observable rather than asserted: it keeps every argv it was handed and can be
 * told to refuse `worktree remove`.
 */
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { NO_HOOKS } from "../src/lean/specify-reset.ts";
import { openReviewerTree } from "../src/reviewer-tree.ts";
import { provisionWorktree } from "../src/worktree-provision.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { makeGit } from "./lib/reviewer-child-stub.ts";

isolateLedger();
const gitEnv = gitTestEnv();

let exit = 0;
const realErrWrite = process.stderr.write.bind(process.stderr);
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${msg}\n`);
    exit = 1;
  }
}

// `traceWarn` writes with `process.stderr.write`, so a wrapper on that method
// sees every warning the module emits; `assert` writes its failure lines through
// the original method, so the smoke pool's digest still sees them.
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

const NO_HOOKS_PREFIX = [...NO_HOOKS];
const hasNoHooksPrefix = (argv: string[]) => argv.join(" ").indexOf(NO_HOOKS_PREFIX.join(" ")) === 0;

function makeRepo(tag: string): { dir: string; head: string; git: ReturnType<typeof makeGit> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `rev-1975-${tag}-`));
  const git = makeGit(dir, gitEnv);
  git.run("init", "-q", "-b", "main");
  git.run("config", "user.email", "t@example.com");
  git.run("config", "user.name", "test");
  writeFileSync(path.join(dir, "f.txt"), "one\n");
  git.run("add", "-A");
  git.run("commit", "-q", "-m", "base");
  return { dir, head: git.out("rev-parse", "HEAD"), git };
}

const strayTrees = (git: ReturnType<typeof makeGit>) =>
  git
    .out("worktree", "list")
    .split("\n")
    .filter((l) => l.includes("pi-rukas-review-"));

{
  // A project with a `.pi/worktree-setup` hook that WOULD run arbitrary code,
  // and dependency dirs to link: the hook must never fire for a reviewer tree.
  const { dir: repo } = makeRepo("prov");
  const hookMark = path.join(repo, "HOOK-RAN");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nextension/node_modules/\nHOOK-RAN\n");
  // The dependency tree is gitignored and UNTRACKED (makeRepo has committed
  // everything else), which is the only shape the symlink path links.
  mkdirSync(path.join(repo, "extension", "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(repo, "extension", "node_modules", "dep", "index.js"), "x\n");
  // The hook is NOT ignored — it is a tracked file, which is what a real project
  // has — so it is part of the commit and materialises in every tree.
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
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
  const tree = await openReviewerTree(leakExec, repo, provHead);
  assert(tree.kind === "tree", `a tree was opened (${tree.kind === "tree" ? "" : tree.reason})`);
  if (tree.kind === "tree") {
    const mode = statSync(tree.cwd).mode & 0o777;
    assert(mode === 0o700, `the throwaway tree is private (mode ${mode.toString(8)})`);
    assert(
      !existsSync(hookMark),
      "the project's .pi/worktree-setup hook did NOT run for a reviewer tree",
    );
    assert(
      existsSync(path.join(tree.cwd, "extension", "node_modules", "dep", "index.js")),
      "the dependency dirs ARE linked, so targeted checks stay runnable",
    );
    // The same fixture handed to `provisionWorktree` DOES run the hook — that is
    // what the branch step does — so the mark's absence above is the symlink-only
    // path's doing, not a hook that could not have run. Without this arm the
    // assertion above passes on a fixture whose hook is inert.
    const hooked = mkdtempSync(path.join(os.tmpdir(), "pi-rukas-review-hooked-"));
    await execp("git", {
      cwd: repo,
      argv: ["--git-dir", path.join(repo, ".git"), "worktree", "add", "--detach", hooked, provHead],
    });
    await provisionWorktree(execp, repo, hooked).catch(() => undefined);
    assert(existsSync(hookMark), "the fixture's hook is one that really runs, when it is asked to");
    await execp("git", {
      cwd: repo,
      argv: ["--git-dir", path.join(repo, ".git"), "worktree", "remove", "--force", hooked],
    }).catch(() => undefined);
    await rm(hooked, { recursive: true, force: true }).catch(() => undefined);
    // #1975 item 7 continued — the create-side calls carry the pair; the
    // release-side calls are asserted by the leak arm below, which releases this
    // tree with `worktree remove` armed to fail.
    const gitCalls = calls.filter(
      (a) => a.includes("worktree") || a.includes("--git-common-dir"),
    );
    const unprefixed = gitCalls.filter((a) => !hasNoHooksPrefix(a));
    assert(
      unprefixed.length === 0,
      `every reviewer-tree git call carries the NO_HOOKS prefix (${gitCalls.length} create-side calls, ${unprefixed.length} without it: ${unprefixed.map((a) => a.join(" ")).join(" | ")})`,
    );
    assert(strayTrees(provGit).length === 1, "the tree is registered while it is in use");
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
  assert(released, "a release whose `worktree remove` was refused still never throws");
  assert(existsSync(leaked), "the refused tree survived — this is the leak the WARN names");
  assert(
    calls.some(
      (a) =>
        a.includes("remove") &&
        a[a.length - 1] === leaked &&
        hasNoHooksPrefix(a),
    ),
    `the refused call was this tree's own \`git worktree remove\` (${leaked})`,
  );
  const leakWarned = errWrites.some(
    (l) => l.includes("WARN") && l.includes("could not remove the throwaway tree") && l.includes(leaked),
  );
  assert(
    leakWarned,
    `a worktree remove that fails with the dir still present names the path on a WARN (${lastWarnLines().filter((l) => l.includes("reviewer-tree")).join(" / ") || "no reviewer-tree line at all"})`,
  );
  // The survivor is the fixture's to clean up, not the repository's.
  try {
    provGit.run("worktree", "remove", "--force", leaked);
  } catch {
    /* the leak arm above already proved the trace */
  }
  }

{
  // A `headSha` that is not a 40-char SHA is a fail-open the caller can read:
  // the reason names the tree it refused to make, the WARN makes it visible
  // without `PI_ENSEMBLE_DEBUG`, and no tree is created at all.
  const { dir, git } = makeRepo("bad-sha");
  const seen: string[][] = [];
  const recordingExec = async (
    cmd: string,
    opts: { cwd?: string; maxBuffer?: number; timeout?: number; argv?: string[] },
  ) => {
    seen.push([...(opts.argv ?? [])]);
    return execp(cmd, { ...opts, argv: opts.argv });
  };
  lastWarnLines();
  const refused = await openReviewerTree(recordingExec, dir, "not-a-sha");
  assert(refused.kind === "unisolated", `a non-SHA headSha is refused (${refused.kind})`);
  assert(
    refused.kind === "unisolated" && refused.reason.includes("not a 40-char commit SHA"),
    `the unisolated reason names the SHA requirement (${refused.kind === "unisolated" ? refused.reason : ""})`,
  );
  assert(
    errWrites.some(
      (l) => l.includes("WARN") && l.includes("reviewer-tree") && l.includes("unisolated"),
    ),
    "the non-SHA fail-open is disclosed on a WARN, not the DEBUG-gated trace",
  );
  assert(
    seen.length === 0,
    `a refused headSha asked git for nothing (${seen.length} calls: ${seen.map((a) => a.join(" ")).join(" | ")})`,
  );
  assert(strayTrees(git).length === 0, "the refused arm left no worktree registration behind");
}

{
  // An INCOMPLETE provision is a fail-open of the same kind as every other arm
  // here — a reviewer whose `node_modules` link does not resolve cannot run the
  // project's targeted checks, and a review that ran no checks is not a gate —
  // so the module's `problem` is WARN-visible, not DEBUG-gated. The executor
  // confirms the candidate to `git check-ignore` and then takes the source away
  // before the symlink is made: that is the #761 shape `linkFoundDeps` already
  // reports as a `problem`, reached here through the real provisioning path.
  const { dir, git } = makeRepo("prov-problem");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "x\n");
  writeFileSync(path.join(dir, "package.json"), '{"name":"root"}\n');
  const provGit2 = makeGit(dir, gitEnv);
  provGit2.run("add", "-A", "--", ".gitignore", "package.json");
  provGit2.run("commit", "-q", "-m", "fixture: an ignorable dependency tree");
  const provHead2 = provGit2.out("rev-parse", "HEAD");
  // The `problem` is produced deterministically, not by a race: an executor
  // that plants a non-empty FILE at the tree's `node_modules` AFTER `git
  // worktree add` and before the symlink runs makes the link itself fail
  // (`EEXIST`) — the shape `linkFoundDeps` already reports as a provisioning
  // `problem`, reached here through the real provisioning path.
  const problemExec = async (
    cmd: string,
    opts: { cwd?: string; maxBuffer?: number; timeout?: number; argv?: string[] },
  ) => {
    const r = await execp(cmd, { ...opts, argv: opts.argv });
    const a = opts.argv ?? [];
    if (a.includes("add") && a.includes("--detach")) {
      writeFileSync(path.join(a[a.indexOf("--detach") + 1], "node_modules"), "occupied\n");
    }
    return r;
  };
  lastWarnLines();
  const tree2 = await openReviewerTree(problemExec, dir, provHead2);
  assert(tree2.kind === "tree", `the tree was opened (${tree2.kind})`);
  assert(
    errWrites.some((l) => l.includes("WARN") && l.includes("provisioning incomplete")),
    `an incomplete provision is disclosed on a WARN, not the DEBUG-gated trace (${errWrites.filter((l) => l.includes("provision")).join(" / ") || "no provisioning line at all"})`,
  );
  if (tree2.kind === "tree") await tree2.release();
  assert(strayTrees(git).length === 0, "the arm left no worktree registration behind");
}

process.exit(exit);
