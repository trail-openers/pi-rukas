#!/usr/bin/env bun
/**
 * lean/specify-path — `existsInCommit`: is this name an object in that commit?
 *
 * The `submit_tests` boundary refuses a test that already exists at the run's
 * base, and the single git read behind that rule has exactly two answers — "no
 * such object" (a fact the boundary acts on) and "I could not tell" (an
 * infrastructure throw). Every way of collapsing those two is a bug, and the
 * dangerous one is reading a failure as absence: a repository git cannot read
 * would certify that EVERY submitted test is new and pass the exact fraud the
 * rule exists to refuse, at total confidence.
 *
 * So the read is `git ls-tree … <base> -- <rel>` and the verdict is its STDOUT,
 * never its stderr — git interpolates the child-chosen path into its messages,
 * so anything read off stderr is text the child wrote. Cases, all against a
 * real temp repo:
 *
 *   (a) a tracked file is present; a file the child wrote and a name nobody
 *       created are both absent;
 *   (b) a directory at the path counts as present — a directory is not a new
 *       file, and the boundary's `fileProblem` refuses it for that reason;
 *   (c) the pathspec is LITERAL: `tests/[b]x.test.ts` globs onto the tracked
 *       `tests/ax.test.ts` and must still read as its own missing file;
 *   (d) a file whose NAME is git's old absence wording reads as present — the
 *       wording is data on stdout now, and cannot make a fault look like
 *       absence or a name look like a verdict;
 *   (e) the ref is a full lowercase oid or the probe never reaches git;
 *   (f) a repo git cannot read is INFRA, never "the file is new", and the throw
 *       says what git said.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { existsInCommit } from "../src/lean/specify-path.ts";
import type { ExecFn } from "../src/worktree.ts";
import { git, gitEnvFor, put } from "./lib/lean-build-fixture.ts";
import { assert, testLocationExit } from "./lib/lean-test-location-fixture.ts";

/** The production executor's shape: `execFile` with an argv array, no shell. */
const execFileP = promisify(execFile);
const realExec: ExecFn = async (cmd, o) =>
  execFileP(cmd, o?.argv, { cwd: o?.cwd, env: gitEnvFor(), maxBuffer: o?.maxBuffer });

/**
 * The wording git used to print for an absent path — which is what a filename
 * can now contain without consequence. Under the old `cat-file -e` classifier a
 * line matching it was read as absence, so this name is the counterexample.
 */
const WORDING = "does not exist in 'deadbeef'";
/** A tracked bracket-literal twin of `tests/ax.test.ts`, and its absent twin. */
const BRACKET = "tests/[a]x.test.ts";
const BRACKET_ABSENT = "tests/[b]x.test.ts";

// A repo whose base commit holds a tracked test, a bracket-literal twin, a
// directory, and a file NAMED like git's old absence wording. `tests/child-new`
// is written after the commit: present in the tree, absent from the commit.
const repo = mkdtempSync(path.join(tmpdir(), "lean-lstree-"));
git(repo, "init", "-q", "-b", "main");
put(repo, "tests/tracked.test.ts", "test\n");
put(repo, "tests/ax.test.ts", "test\n");
put(repo, BRACKET, "test\n");
put(repo, `tests/${WORDING}.ts`, "test\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
const base = git(repo, "rev-parse", "HEAD");
put(repo, "tests/child-new.test.ts", "test\n");

/** The verdict as a string, so the throw arm cannot take the whole file down. */
async function verdictOf(rel: string, exec: ExecFn = realExec, ref = base): Promise<string> {
  try {
    return (await existsInCommit(exec, repo, ref, rel)) ? "present" : "absent";
  } catch (err) {
    // The whole message, not a clip: the assertions need the file name and
    // git's own cause to ride in it.
    return `throw:${(err as Error).message}`;
  }
}

// ─────────────────────────────────── (a) present, absent, and a child's own file

{
  const tracked = await existsInCommit(realExec, repo, base, "tests/tracked.test.ts");
  assert(tracked === true, "a file the base commit holds reads as PRESENT");
  const childNew = await existsInCommit(realExec, repo, base, "tests/child-new.test.ts");
  assert(
    childNew === false,
    "a file in the working tree but not the commit reads as ABSENT — which is what 'the child wrote it' means",
  );
  const nobody = await existsInCommit(realExec, repo, base, "tests/no-such-file.test.ts");
  assert(nobody === false, "a path nobody created also reads as absent, not as an error");
}

// ───────────────────────────── (b) a directory is an object, so it is not new

{
  // `tests/` is a TREE, and the boundary must not treat it as a file the child
  // authored. Counting trees is what makes that refusal the FILE rule's job
  // (`fileProblem`: not a regular file) rather than this probe's "new file".
  const dir = await existsInCommit(realExec, repo, base, "tests");
  assert(
    dir === true,
    "a tree object at the path answers present — a directory is not a new test, and the boundary's file check says so",
  );
}

// ───────────────────────────── (c) the pathspec is literal, never a glob

{
  const trackedBracket = await existsInCommit(realExec, repo, base, BRACKET);
  assert(trackedBracket === true, "a bracket-literal name that IS tracked reads as present");
  // `tests/[b]x.test.ts` matches nothing literally, yet as a GLOB it matches the
  // tracked `tests/ax.test.ts`. Reading it as present would let a child name
  // someone else's test with a pattern and have it accepted as its own.
  const globbed = await existsInCommit(realExec, repo, base, BRACKET_ABSENT);
  assert(
    globbed === false,
    "a bracket name that only GLOBS onto a tracked file still reads as absent — --literal-pathspecs is on the call",
  );
}

// ───────────────── (d) git's old absence wording is a filename, not a verdict

{
  // The file exists, so the answer is "present" — the wording on stdout is
  // bytes git prints about the object, and nothing reads it. The counterfactual
  // that makes this a regression test: under the deleted `cat-file -e` +
  // stderr-wording classifier, the SAME name asked of a repository git cannot
  // read produced a stderr line containing "does not exist in '…'" — which that
  // classifier classified as absence, i.e. "the child wrote this".
  const wording = await existsInCommit(realExec, repo, base, `tests/${WORDING}.ts`);
  assert(
    wording === true,
    "a file whose NAME is git's old absence wording reads as PRESENT — the wording is data now, not the verdict",
  );
  const wordingTwin = await existsInCommit(realExec, repo, base, `tests/nope-${WORDING}.ts`);
  assert(
    wordingTwin === false,
    `and its untracked twin ${WORDING.slice(0, 20)}… reads as ABSENT on an empty stdout, not on any wording match`,
  );
}

// ─────────────────────── (e) the ref is a full lowercase oid or git is not asked

// The run's base is a full lowercase oid because `lean/base-proof.ts` says
// so — but THIS read decides whether a submitted test is new, and a ref that
// is a branch, a short prefix or a revision chain asks the question of
// whatever that name happens to point at. The shape check stops it without
// paying for a git call.
for (const ref of ["main", "HEAD", "abc123", `${base.slice(0, 39)}z`, "HEAD~1", ""])
  for (const strict of [ref, ref === "" ? ref : ` ${ref} `]) {
    let called = false;
    const spy: ExecFn = async () => {
      called = true;
      return { stdout: "" };
    };
    let threw = "";
    await existsInCommit(spy, repo, strict, "tests/tracked.test.ts").catch((e: unknown) => {
      threw = (e as Error).message;
    });
    assert(
      threw !== "" && !called && threw.includes("tests/tracked.test.ts"),
      `a ref \`${strict}\` that is not a full lowercase oid is INFRA and never reaches git (got ${threw || `no throw; git called=${called}`})`,
    );
  }

// ─────────── (f) a repo git cannot read is INFRA, and the probe's argv is fixed

{
  // The argv is the contract: `--end-of-options` closes the ref, `--` separates
  // rev from pathspec, and the ref and the path are SEPARATE words so no
  // re-parse can fold a path containing `:` into the rev.
  const seen: string[][] = [];
  const spy: ExecFn = async (_cmd, o) => {
    seen.push([...(o?.argv ?? [])]);
    return { stdout: "" };
  };
  assert(
    (await existsInCommit(spy, repo, base, "-Ptests/x.ts")) === false,
    "a path that opens with a dash is asked about as a path, not swallowed as an option",
  );
  const argv = seen[0] ?? [];
  const flags = ["ls-tree", "-z", "--full-tree", "--end-of-options", "--literal-pathspecs"];
  assert(
    flags.every((f) => argv.includes(f)),
    `the probe is ls-tree in argv form with every guard on the call (got ${JSON.stringify(argv)})`,
  );
  assert(
    argv.indexOf("--end-of-options") < argv.indexOf(base),
    `--end-of-options precedes the ref, so a ref-shaped value cannot be an option (got ${JSON.stringify(argv)})`,
  );
  assert(
    argv[argv.length - 2] === "--" && argv[argv.length - 1] === "-Ptests/x.ts",
    `the path is its own word after \`--\`, never glued to the ref with a colon (got ${JSON.stringify(argv.slice(-2))})`,
  );
  // A colon INSIDE the path is data: with the rev and the pathspec separate, a
  // name like `a:b` cannot be re-read as `<rev>:<path>`.
  await existsInCommit(spy, repo, base, "tests/a:b.ts");
  const argv2 = seen[1] ?? [];
  assert(
    argv2[argv2.length - 1] === "tests/a:b.ts",
    `a colon in the path stays in the path (got ${JSON.stringify(argv2.slice(-2))})`,
  );
}

{
  // A real broken repository: the base tree object is gone from the store, so
  // git cannot answer the question at all. The rule must throw rather than
  // report every submitted test as new, and the handback must carry git's own
  // reason — "could not read the base commit" with no cause sends an operator
  // hunting for a missing file in a repository whose store is simply broken.
  const broken = mkdtempSync(path.join(tmpdir(), "lean-lstree-broken-"));
  git(broken, "init", "-q", "-b", "main");
  put(broken, "tests/tracked.test.ts", "test\n");
  git(broken, "add", "-A");
  git(broken, "commit", "-q", "-m", "base");
  const brokenBase = git(broken, "rev-parse", "HEAD");
  const treeOidLine = git(broken, "cat-file", "-p", brokenBase).split("\n")[0] ?? "";
  const treeOid = treeOidLine.split(" ")[1] ?? "";
  assert(/^([0-9a-f]{40})$/.test(treeOid), `the base's tree oid was parsed (got ${treeOid})`);
  rmSync(path.join(broken, ".git", "objects", treeOid.slice(0, 2), treeOid.slice(2)), {
    force: true,
  });
  let why = "";
  const got = await verdictOf("tests/tracked.test.ts", realExec, brokenBase).then((v) => {
    why = v;
    return v;
  });
  assert(
    got.startsWith("throw:") &&
      why.includes("tests/tracked.test.ts") &&
      /not a tree object/i.test(why),
    `an unreadable object store is INFRA, not "the file is new" — and git's reason rides along (got ${why})`,
  );
  // Not a git repository at all: same treatment, nothing read as absence.
  const notARepo = mkdtempSync(path.join(tmpdir(), "lean-lstree-plain-"));
  let plain = "";
  await existsInCommit(realExec, notARepo, base, "tests/tracked.test.ts").catch((e: unknown) => {
    plain = (e as Error).message;
  });
  assert(
    plain.includes("tests/tracked.test.ts") && plain !== "",
    `a directory that is not a repository throws rather than certifying the file as new (got ${plain || "no throw"})`,
  );
  rmSync(notARepo, { recursive: true, force: true });
  rmSync(broken, { recursive: true, force: true });
}

{
  // A killed probe is INFRA too, whichever way the kill arrives. The path never
  // reaches stdout on a kill, so the old stderr-wording trick was never needed
  // to cover this; the structured read simply never sees a stdout to trust.
  const arms: Array<[string, unknown]> = [
    ["killed by the watchdog", Object.assign(new Error("killed"), { code: null, killed: true })],
    [
      "terminated by a signal",
      Object.assign(new Error("sigterm"), { code: null, signal: "SIGTERM", stdout: "" }),
    ],
    [
      "a non-exec rejection with no result shape",
      Object.assign(new TypeError("boom"), { code: "ERR_INVALID_ARG" }),
    ],
  ];
  for (const [name, err] of arms) {
    const failing: ExecFn = async () => {
      throw err;
    };
    let message = "";
    await existsInCommit(failing, repo, base, "tests/tracked.test.ts").catch((e: unknown) => {
      message = (e as Error).message;
    });
    assert(
      message.includes("tests/tracked.test.ts"),
      `a probe that never completed is INFRA (${name}) — and the throw names the file the boundary asked about`,
    );
  }
  // An empty stdout from a git that answered with nothing is absence, and that
  // is the whole rule — no wording is consulted anywhere in the module.
  const empty: ExecFn = async () => ({ stdout: "" });
  assert(
    (await existsInCommit(empty, repo, base, "tests/whatever.test.ts")) === false,
    "empty stdout is absence, whatever git wrote to stderr alongside it",
  );
}

console.log(
  testLocationExit() === 0 ? "\nexistsInCommit reads stdout, not git's prose." : "\nFAILED",
);
chmodSync(repo, 0o755);
rmSync(repo, { recursive: true, force: true });
process.exit(testLocationExit());
