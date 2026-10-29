#!/usr/bin/env bun
/**
 * lean/specify-reset — `existsInCommit`: does this path live in that commit?
 *
 * The `submit_tests` boundary refuses a test that already exists at the run's
 * base, and the single git read behind that rule has exactly two answers — "not
 * in that tree" (a fact the boundary acts on) and "I could not tell" (an
 * infrastructure throw). Every way of collapsing those two into one is a bug,
 * and the dangerous one is reading a failure as absence: a repository git cannot
 * read would then certify that EVERY submitted test is new, and pass the exact
 * fraud the rule exists to refuse while reporting total confidence.
 *
 * So both directions are pinned against a real repo, and the throw arm against
 * the four rejections an executor actually produces:
 *
 *   (a) a tracked file is present; a file the child wrote is absent; and
 *       absence is decided by git's OWN wording, not by any non-zero exit.
 *   (b) a name that is a glob to git is still one literal file
 *       (`--literal-pathspecs`) — a submitted `tests/[a]x.test.ts` must not
 *       match the tracked `tests/ax.test.ts`.
 *   (c) the three "git ran and said the object is not there" wordings are all
 *       absent; the store-fault wordings are all throws.
 *   (d) a killed or signalled probe, a `not a git repository` clone, and a
 *       buffer overflow are infrastructure, never "the file is new".
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsInCommit } from "../src/lean/specify-reset.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The identity a fixture's git children commit with (isolated HOME, no host config). */
function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** The production executor's shape: `execFile` with an argv array, no shell. */
const execFileP = promisify(execFile);
const realExec: ExecFn = async (cmd, o) =>
  execFileP(cmd, o?.argv, { cwd: o?.cwd, env: gitEnv(), maxBuffer: o?.maxBuffer });

const repo = mkdtempSync(path.join(tmpdir(), "lean-catfile-"));
git(repo, "init", "-q", "-b", "main");
mkdirSync(path.join(repo, "tests"), { recursive: true });
writeFileSync(path.join(repo, "tests/tracked.test.ts"), "test\n");
writeFileSync(path.join(repo, "tests/ax.test.ts"), "test\n");
writeFileSync(path.join(repo, "tests/[a]x.test.ts"), "test\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
const base = git(repo, "rev-parse", "HEAD");
// The child's own file: present in the working tree, absent from the commit.
writeFileSync(path.join(repo, "tests/child-new.test.ts"), "test\n");

// ------------------------------------------------- (a) present, absent, new file

{
  assert(
    (await existsInCommit(realExec, repo, base, "tests/tracked.test.ts")) === true,
    "a file the base commit holds reads as PRESENT",
  );
  assert(
    (await existsInCommit(realExec, repo, base, "tests/child-new.test.ts")) === false,
    "a file in the working tree but not the commit reads as ABSENT — which is what 'the child wrote it' means",
  );
  assert(
    (await existsInCommit(realExec, repo, base, "tests/no-such-file.test.ts")) === false,
    "a path nobody created also reads as absent, not as an error",
  );
  // A directory is not a test file, but it IS an object in the tree: the rule
  // refuses a submitted directory for `fileProblem` reasons, not this probe's.
  assert(
    (await existsInCommit(realExec, repo, base, "tests")) === true,
    "a tree object answers present too — this probe asks 'is the name in the commit', and the boundary's file check asks the rest",
  );
}

// -------------------------------------- (b) the path is a literal, never a glob

{
  // `tests/[a]x.test.ts` is a tracked file AND, to a globbing git, the same name
  // as the tracked `tests/ax.test.ts`. Both are in this commit, so the discriminating
  // question is the ABSENT one: `tests/[b]x.test.ts` matches `tests/ax.test.ts`
  // as a glob and must still read as its own, missing file.
  assert(
    (await existsInCommit(realExec, repo, base, "tests/[a]x.test.ts")) === true,
    "a bracket-literal name that IS tracked reads as present",
  );
  assert(
    (await existsInCommit(realExec, repo, base, "tests/[b]x.test.ts")) === false,
    "a bracket name that only GLOBS onto a tracked file still reads as absent — the pathspec is literal, so a child cannot name someone else's test with a pattern",
  );
}

// --------------------------- (c) git's wordings: absence is a fact it must state

/** A rejection shaped like `execp`'s (code + stderr + killed/signal fields). */
function rejection(code: number, stderr: string, extra: object = {}): unknown {
  return Object.assign(new Error(`Command failed: git …\n${stderr}`), {
    code,
    stderr,
    killed: false,
    signal: null,
    stdout: "",
    ...extra,
  });
}

const PROBED = "tests/tracked.test.ts";
// Three wordings git really prints when the object it was asked for is simply
// not there. All three carry no `does not exist`, which is why this probe does
// not rely on the shared tree-probe rule alone — see the `exists on disk` arm
// below and the comment on `existsInCommitProblem` in the module under test.
const ABSENT_WORDINGS = [
  `fatal: path '${PROBED}' does not exist in '${"abc123"}'`,
  `fatal: path '${PROBED}' exists on disk, but not in '${"abc123"}'`,
];
const FAULT_WORDINGS = [
  "fatal: not a git repository (or any of the parent directories): .git",
  "error: unable to open mmap pack file",
  "fatal: bad object abc123",
  "error: unable to unpack abc123",
  "fatal: pack has 1 unreachable blob",
  // The rev did not resolve. This says NOTHING about the path, and reading it
  // as absence would report "the base does not have this file" about a commit
  // nobody resolved — the safe direction is the throw.
  `fatal: Not a valid object name abc123:${PROBED}`,
  // `could not get object info` is git's generic cat-file failure. It is NOT in
  // `gitCatFileSaysAbsent`'s wording set (that phrase belongs to the rev-probe
  // rule in `base-proof.ts`, where the question is the ref), so for a tree probe
  // it is an unanswered question — and an unanswered question must throw.
  "fatal: could not get object info",
];

/** The verdict under test, as a string, so one arm cannot throw the test down. */
async function verdictOf(stderr: string): Promise<string> {
  const failing: ExecFn = async () => {
    throw rejection(128, stderr);
  };
  try {
    return (await existsInCommit(failing, repo, base, PROBED)) ? "present" : "absent";
  } catch (err) {
    // The whole message, not a clip: the assertions below require the file name
    // to ride in it, and a clip that cut it off would fail for the wrong reason.
    return `throw:${(err as Error).message}`;
  }
}

for (const wording of ABSENT_WORDINGS)
  assert(
    (await verdictOf(wording)) === "absent",
    `git's own "not there" wording is ABSENT — "${wording.slice(0, 46)}" (got ${await verdictOf(wording)})`,
  );

for (const wording of FAULT_WORDINGS) {
  const got = await verdictOf(wording);
  assert(
    got.startsWith("throw:") && got.includes(PROBED),
    `a store fault is INFRA — "${wording.slice(0, 40)}" throws naming the file, never reports "new" (got ${got})`,
  );
}

// The wording the shared tree-probe rule does NOT cover, and why this caller
// must: `exists on disk, but not in <base>` is what git answers for a file the
// child wrote into its own tree — the exact fraud the newness rule exists to
// refuse. Reading it as a fault would throw on the one case the rule catches.
{
  const got = await verdictOf(
    `fatal: path 'tests/child-new.test.ts' exists on disk, but not in '${base}'`,
  );
  assert(
    got === "absent",
    `"exists on disk, but not in <base>" is ABSENT (a file the child wrote), not a fault (got ${got})`,
  );
}

// ------------------------- (d) a probe that never got an answer is never "new"

{
  const arms: Array<[string, unknown]> = [
    ["killed by the watchdog", rejection(128, "", { killed: true })],
    ["killed with no code", Object.assign(new Error("killed"), { code: null, killed: true })],
    [
      "terminated by a signal",
      rejection(0, "fatal: path 'x' does not exist in 'y'", { signal: "SIGTERM", code: null }),
    ],
    [
      "a timeout whose wording looks like absence",
      Object.assign(new Error("timed out"), {
        code: 124,
        killed: false,
        signal: null,
        stderr: "fatal: path 'tests/x' does not exist in 'abc'",
      }),
    ],
    [
      "a non-exec rejection with no result shape",
      Object.assign(new TypeError("boom"), { code: "ERR_INVALID_ARG" }),
    ],
    [
      "stdout blew its buffer",
      Object.assign(new Error("stdout maxBuffer exceeded"), {
        code: null,
        killed: true,
        stderr: "Command failed: git cat-file -e",
      }),
    ],
  ];
  for (const [name, err] of arms) {
    const failing: ExecFn = async () => {
      throw err;
    };
    let threw = false;
    let message = "";
    try {
      await existsInCommit(failing, repo, base, "tests/tracked.test.ts");
    } catch (err2) {
      threw = true;
      message = (err2 as Error).message;
    }
    assert(
      threw && message.includes("tests/tracked.test.ts"),
      `an unreadable probe is INFRA (${name}) — and the throw names the file the boundary was asking about`,
    );
  }
  // And the throw says WHY: a handback that reads "could not read the base
  // commit" with no cause is the shape that sent an operator hunting for a
  // missing file in a broken repository.
  const failing: ExecFn = async () => {
    throw rejection(128, "error: unable to open mmap pack file");
  };
  let why = "";
  await existsInCommit(failing, repo, base, "tests/tracked.test.ts").catch((e: unknown) => {
    why = (e as Error).message;
  });
  assert(
    why.includes("unable to open mmap pack file"),
    `the cause git printed rides in the error rather than being swallowed (got ${why})`,
  );
}

// ------------------------------------- (e) the ref itself is not a shell word

{
  // A ref is a string the run carries. It reaches git as ONE argv word after
  // `--end-of-options`, so a value that OPENS with a dash is still a rev, and a
  // path that begins with `-` inside the tree-ish is data, not a flag.
  const seen: string[][] = [];
  const spy: ExecFn = async (cmd, o) => {
    seen.push([...(o?.argv ?? [])]);
    if ((o?.argv ?? []).includes("--end-of-options")) return { stdout: "" };
    throw rejection(128, "fatal: path 'x' does not exist in 'y'");
  };
  assert(
    (await existsInCommit(spy, repo, base, "-Ptests/x.ts")) === true,
    "a path that opens with a dash is asked about, not swallowed as an option",
  );
  const argv = seen[0] ?? [];
  assert(
    argv.indexOf("cat-file") > -1 && argv.indexOf("-e") > -1,
    `the probe is git cat-file -e in argv form (got ${JSON.stringify(argv)})`,
  );
  assert(
    argv[argv.length - 1] === `${base}:-Ptests/x.ts`,
    `the ref and the path are ONE word, so no re-parse can split them (got ${JSON.stringify(argv[argv.length - 1])})`,
  );
  assert(
    argv.includes("--literal-pathspecs") && argv.includes("--end-of-options"),
    "both literal-pathspec guards ride on the call",
  );
}

console.log(exit === 0 ? "\nexistsInCommit answers two questions, not one." : "\nFAILED");
process.exit(exit);
