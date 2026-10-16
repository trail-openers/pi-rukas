#!/usr/bin/env bun
/**
 * #1040 / follow-up — comment-retention fail-open paths (offline, scripted exec).
 *
 * Split out of test-comment-retention-hunks.ts to keep both files under the
 * 500-line cap. Covers: a CRLF diff still reports a lost comment; an erroring
 * empty-diff cross-check is ok:false; `git grep` exit 1 is an empty head only
 * when the ref resolves, otherwise the read is unreadable ("not run").
 *
 * Deliberately NOT named `*-live.ts` (it spawns nothing; runs in the offline gate).
 */

import { findLostComments as findLostCommentsRaw } from "../src/comment-retention.ts";
import { asShellForm } from "./lib/argv-shell.ts";

// #1134 — these stubs match the shell-form command string; asShellForm shows argv calls in that form.
const findLostComments = (...args: Parameters<typeof findLostCommentsRaw>) => {
  const [exec, ...rest] = args;
  return findLostCommentsRaw(asShellForm(exec), ...rest);
};
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A thrown exec error carrying a git exit code (as child_process does). */
function execError(code: number, msg: string): Error {
  return Object.assign(new Error(msg), { code });
}

// (21) CRLF diff: a lost comment is still reported LOST (every line is
// CR-stripped before matching, headers and content alike).
{
  const exec: ExecFn = async (cmd) =>
    cmd.startsWith("git diff")
      ? {
          stdout:
            "--- a/src/app.ts\r\n+++ b/src/app.ts\r\n@@ -1,2 +1,1 @@\r\n-// gone in crlf\r\n function f() {}\r\n",
        }
      : cmd.startsWith("git grep")
        ? { stdout: "HEAD:src/app.ts\0function f() {}\n" }
        : { stdout: "" };
  const res = await findLostComments(exec, "/tmp", "a".repeat(40), "HEAD", ["src"]);
  assert(
    res.ok === true && res.lost.length === 1 && res.lost[0]?.text === "// gone in crlf",
    `crlf (21): lost comment in a CRLF diff is reported LOST (got ${JSON.stringify(res)})`,
  );
}

// (22) Empty diff, erroring cross-check: `git rev-list --count` throws → ok:false,
// never a silent "nothing lost" pass.
{
  const exec: ExecFn = async (cmd) => {
    if (cmd.startsWith("git diff")) return { stdout: "" };
    if (cmd.startsWith("git rev-list")) throw execError(128, "fatal: bad revision");
    return { stdout: "" };
  };
  const res = await findLostComments(exec, "/tmp", "a".repeat(40), "HEAD", ["src"]);
  assert(
    res.ok === false && res.reason.includes("unreadable"),
    `empty-diff (22): erroring rev-list cross-check → ok:false (got ${JSON.stringify(res)})`,
  );
}

// (23) `git grep` exit 1 is an empty head only when the ref resolves. An
// unresolvable ref → the head read is unreadable → ok:false ("not run").
{
  const exec: ExecFn = async (cmd) => {
    if (cmd.startsWith("git diff"))
      return {
        stdout: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,1 @@\n-// gone\n function f() {}\n",
      };
    if (cmd.startsWith("git grep")) throw execError(1, "no match");
    if (cmd.startsWith("git rev-parse")) throw execError(128, "unknown revision");
    return { stdout: "" };
  };
  const res = await findLostComments(exec, "/tmp", "a".repeat(40), "HEAD", ["src"]);
  assert(
    res.ok === false && res.reason === "head tree unreadable",
    `grep-exit-1 (23): unresolved ref behind exit 1 → ok:false (got ${JSON.stringify(res)})`,
  );
}

// (24) `git grep` exit 1 with a resolving ref is an empty head tree under paths:
// the removed comment has nothing left to be retained by → LOST.
{
  const exec: ExecFn = async (cmd) => {
    if (cmd.startsWith("git diff"))
      return {
        stdout: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,1 @@\n-// gone\n function f() {}\n",
      };
    if (cmd.startsWith("git grep")) throw execError(1, "no match");
    // #1153 round 3 — `refResolves` requires the object id a real
    // `rev-parse --verify` prints, so the resolving stub prints a 40-hex id.
    if (cmd.startsWith("git rev-parse")) return { stdout: `${"a".repeat(40)}\n` };
    return { stdout: "" };
  };
  const res = await findLostComments(exec, "/tmp", "a".repeat(40), "HEAD", ["src"]);
  assert(
    res.ok === true && res.lost.length === 1 && res.lost[0]?.text === "// gone",
    `grep-exit-1 (24): resolving ref + exit 1 → empty head, comment LOST (got ${JSON.stringify(res)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
