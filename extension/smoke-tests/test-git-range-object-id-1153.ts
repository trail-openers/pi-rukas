#!/usr/bin/env bun
/**
 * #1153 round 3 — a `rev-parse --verify` probe that EXITS 0 WITHOUT AN OBJECT
 * ID is `unknown`, not `resolves`.
 *
 * Split out of test-git-range-1153.ts to keep both files under the 500-line
 * cap; the header there still carries the overview of sections 1–4. The exit
 * code alone used to be the answer here, which meant a shim, a wrapper, or a
 * git that printed a warning instead of an id could report "the branch is
 * pushed" on the word of a process that said nothing.
 *
 * Deliberately NOT named `*-live.ts` (its one real-git probe is a throwaway
 * repo; it runs in the offline gate).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { errorText, execGit, refResolves } from "../src/git-range.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execP = promisify(execFile);
const exec: ExecFn = async (cmd, opts) => {
  const { stdout, stderr } = await execP(cmd, opts?.argv ?? [], {
    cwd: opts?.cwd,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    timeout: opts?.timeout,
    encoding: "utf8",
  });
  return { stdout, stderr };
};

/** An exec that throws a caller-supplied error (a failed / killed / signalled probe). */
const failingExec =
  (err: unknown): ExecFn =>
  async () => {
    throw err;
  };

/** An exec that resolves with a caller-supplied payload (exit 0). */
const okExec =
  (stdout: string): ExecFn =>
  async () => ({ stdout, stderr: "" });

// The shape node's child_process leaves behind when a wrapper swallowed the
// output, and the shape a git shim that only checks the exit code prints.
// Both exit 0 and say nothing about the ref; `resolves` here would tell the
// caller "the branch is pushed" on the word of a process that printed nothing.
for (const [label, stdout] of [
  ["empty stdout", ""],
  ["whitespace only", "  \n"],
  ["a name instead of an id", "origin/feat\n"],
  ["a short hex string", "deadbeef\n"],
  ["a warning line", "warning: something\n"],
  ["two ids, one per line", `${"0".repeat(40)}\n${"1".repeat(40)}`],
] as const) {
  const r = await refResolves(okExec(stdout), "/repo", "origin/feat");
  assert(
    r.state === "unknown" && r.error === "git exited 0 without an object id",
    `refResolves: exit 0 with ${label} is unknown, not resolves (got ${JSON.stringify(r)})`,
  );
}

// The control: the payload a real `rev-parse --verify` prints — 40 hex for
// SHA-1, 64 for a SHA-256 object — does resolve.
for (const hex of ["0".repeat(40), "a".repeat(64)]) {
  const r = await refResolves(okExec(`${hex}\n`), "/repo", "origin/feat");
  assert(
    r.state === "resolves",
    `control: exit 0 with a ${hex.length}-char object id resolves (got ${JSON.stringify(r)})`,
  );
}

// And the real-git control: a genuine probe of a real ref reaches resolves
// through this same shape check, so the check has not broken the honest path
// (the fresh-repo probe in the sibling file covers the absent side).
{
  const realRepo = mkdtempSync(path.join(tmpdir(), "git-range-1153-sha-"));
  try {
    const g = (args: string[]) =>
      execGit(exec, realRepo, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await g(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(realRepo, "a.txt"), "a\n");
    await g(["add", "a.txt"]);
    await g(["commit", "-q", "-m", "base"]);
    const r = await refResolves(exec, realRepo, "HEAD");
    assert(
      r.state === "resolves",
      `refResolves: real git still resolves a present ref (got ${JSON.stringify(r)})`,
    );
  } finally {
    rmSync(realRepo, { recursive: true, force: true });
  }
}

// errorText takes the LAST line, and prefers git's VERDICT line over it:
// `rev-parse --verify` ends with the bare advice line (`pass argument …`, a
// `fatal:` above it), so last-non-empty alone would report the advice. A
// stream with no verdict marker still falls back to the last line.
{
  const multiLine = await refResolves(
    failingExec({
      code: "ENOENT",
      killed: false,
      signal: null,
      message: "Command failed: git rev-parse",
      stderr:
        "fatal: Needed a single revision\nhint: See 'git help repo'\nhint: try something else\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    multiLine.state === "unknown" && multiLine.error === "fatal: Needed a single revision",
    `errorText: the verdict line wins over the advice below it (got ${JSON.stringify(multiLine)})`,
  );
  assert(
    !multiLine.error.includes("hint:"),
    "errorText: the informational lines below the verdict do not reach the note",
  );
}

// The other side: git's dubious-ownership error has no `fatal:` after the
// first line, and the whole tail is remediation advice. The verdict line is
// what survives it — reporting `git config --global …` as the REASON a probe
// failed would be a note about a command nobody ran.
{
  const adviceTail = await refResolves(
    failingExec({
      code: 128,
      killed: false,
      signal: null,
      message: "Command failed",
      stderr:
        "fatal: detected dubious ownership in repository at '/home/dev/project'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /home/dev/project\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    adviceTail.state === "unknown" &&
      adviceTail.error.startsWith("fatal: detected dubious ownership"),
    `errorText: a fatal line survives the advice block below it (got ${JSON.stringify(adviceTail)})`,
  );
}

// And the fallback: with no verdict marker anywhere, the last non-empty line
// is the most informative thing the process said.
assert(
  errorText({ stderr: "one\ntwo\n  three  \n" }) === "three",
  `errorText: no verdict marker → the last non-empty line (got ${JSON.stringify(errorText({ stderr: "one\ntwo\n  three  \n" }))})`,
);

// A non-string field that stringifies usefully is coerced rather than cast
// away, and one that does not still yields a string rather than throwing.
for (const [label, stderr] of [
  ["an object with toString", { toString: () => "fatal: coerced" }],
  ["a number", 42],
  ["a nested object", { a: 1 }],
] as const) {
  const r = await refResolves(
    failingExec({ code: "ENOENT", message: "m", stderr }),
    "/repo",
    "origin/feat",
  );
  assert(
    r.state === "unknown" && typeof r.error === "string" && r.error.length > 0,
    `errorText: ${label} is coerced to a non-empty string, not cast (got ${JSON.stringify(r)})`,
  );
}

process.exit(exit);
