#!/usr/bin/env bun
/**
 * #1040 (final round) — comment-retention shape guarantees:
 *  - retention is a substring match of a head line (compacted code, suffixes);
 *  - the head read is NUL-delimited (`git grep -z`), so a `:` in a path is safe;
 *  - a NOT CHECKED reason is a fixed category, the raw error only in trace();
 *  - plumbReports are built from the structured result and deduplicated;
 *  - the ExecFn seam is injectable on the adversarial round and the lens block.
 *
 * Fake execFns, no git: each assertion pins one of the rules above.
 */

import { recordCommentEvidence } from "../src/comment-evidence.ts";
import { lensCommentBlock, roundComments } from "../src/comment-evidence.ts";
import { findLostComments as findLostCommentsRaw } from "../src/comment-retention.ts";
import { asShellForm } from "./lib/argv-shell.ts";

// #1134 — these stubs match the shell-form command string; asShellForm shows argv calls in that form.
const findLostComments = (...args: Parameters<typeof findLostCommentsRaw>) => {
  const [exec, ...rest] = args;
  return findLostCommentsRaw(asShellForm(exec), ...rest);
};
import { initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A range-mode fake: `git diff` returns `diff`, `git grep` returns `head`. */
function rangeExec(diff: string, head: string): ExecFn {
  return async (cmd) => {
    if (cmd.startsWith("git diff")) return { stdout: diff };
    if (cmd.startsWith("git grep")) return { stdout: head };
    return { stdout: "" };
  };
}

const SRC = "src/app.ts";

// (1) Compacted code: the comment and the annotated line are removed, and the
// annotated code survives at head only inside a longer compacted line. The
// comment's own text is gone, so it is LOST — and the code's presence means it
// is not EXEMPT.
{
  const diff = `--- a/${SRC}\n+++ b/${SRC}\n@@ -1,2 +0,0 @@\n-// doc for f\n-function f() {\n`;
  const head = `${SRC}\0function f() { return 1; }\n`;
  const res = await findLostComments(
    rangeExec(diff, head),
    "/tmp",
    "a".repeat(40),
    "HEAD",
    ["src"],
    1000,
  );
  assert(
    res.ok && res.lost.length === 1 && res.exempt === 0,
    "compacted code: comment is LOST, not EXEMPT",
  );
}

// (2) A comment that gained a suffix at head is RETAINED (substring, not whole-token).
{
  const diff = `--- a/${SRC}\n+++ b/${SRC}\n@@ -1,1 +0,0 @@\n-// retry on error\n`;
  const head = `${SRC}\0// retry on errors and backoff\n`;
  const res = await findLostComments(
    rangeExec(diff, head),
    "/tmp",
    "a".repeat(40),
    "HEAD",
    ["src"],
    1000,
  );
  assert(res.ok && res.lost.length === 0, "suffix-gaining comment: RETAINED");
}

// (3) `//nolint:gosec` glued to code at head is RETAINED.
{
  const diff = `--- a/${SRC}\n+++ b/${SRC}\n@@ -1,2 +0,0 @@\n-//nolint:gosec\n-func g() {}\n`;
  const head = `${SRC}\0func g() {} //nolint:gosec\n`;
  const res = await findLostComments(
    rangeExec(diff, head),
    "/tmp",
    "a".repeat(40),
    "HEAD",
    ["src"],
    1000,
  );
  assert(res.ok && res.lost.length === 0, "//nolint:gosec glued to code: RETAINED");
}

// (4) A `:` in the file name cannot mis-slice the head line: the content after
// the NUL is what is compared.
{
  const file = "extension/src/a:b.ts";
  const diff = `--- a/${file}\n+++ b/${file}\n@@ -1,2 +0,0 @@\n-// doc here\n-function f() {}\n`;
  const head = `HEAD:${file}\0// doc here\n`;
  const res = await findLostComments(
    rangeExec(diff, head),
    "/tmp",
    "a".repeat(40),
    "HEAD",
    ["extension/src"],
    1000,
  );
  assert(res.ok && res.lost.length === 0, "colon in filename: head content parsed after the NUL");
}

// (5) Diff-string mode (the worktree head) reads the NUL-delimited tree too.
{
  const diff = `--- a/${SRC}\n+++ b/${SRC}\n@@ -1,1 +0,0 @@\n-// kept doc\n`;
  const head = `${SRC}\0// kept doc\n`;
  const res = await findLostComments(
    rangeExec("", head),
    "/tmp",
    undefined,
    undefined,
    ["src"],
    1000,
    diff,
  );
  assert(res.ok && res.lost.length === 0, "diff-string mode: worktree head retains the comment");
}

// (6) A git failure reads a fixed category; the raw error does not reach the reason.
{
  const boom: ExecFn = async () => {
    throw new Error("fatal: secret detail /private/path");
  };
  const res = await findLostComments(boom, "/tmp", "a".repeat(40), "HEAD", ["src"], 1000);
  assert(
    !res.ok && res.reason === "git diff failed",
    "git failure: reason is the fixed category 'git diff failed'",
  );
}

// (7) plumbReports are built from the structured result and not duplicated.
{
  const lossy = {
    ok: true as const,
    lost: [{ file: SRC, text: "// gone", addedNearby: [] }],
    exempt: 0,
  };
  const entries = [{ note: "comment-retention: 1 comment line(s) removed …", result: lossy }];
  let state = initialState(1, 0);
  state = recordCommentEvidence(state, entries);
  state = recordCommentEvidence(state, entries);
  const reports = state.pipelineState.plumbReports ?? [];
  assert(reports.length === 1, "re-verify does not duplicate the plumbReport");
  const clean = [
    { note: "comment-retention: clean", result: { ok: true as const, lost: [], exempt: 0 } },
  ];
  state = recordCommentEvidence(state, clean);
  assert((state.pipelineState.plumbReports ?? []).length === 1, "a clean check plumbs nothing");
}

// (8) The ExecFn seam is injectable: a fake sees the round check's git calls.
{
  const seen: string[] = [];
  const fake: ExecFn = async (cmd) => {
    seen.push(cmd);
    if (cmd.startsWith("git grep")) return { stdout: `${SRC}\0// kept doc\n` };
    return { stdout: "" };
  };
  const diff = `--- a/${SRC}\n+++ b/${SRC}\n@@ -1,1 +0,0 @@\n-// kept doc\n`;
  const res = await roundComments(diff, undefined, "/tmp", 1000, asShellForm(fake));
  assert(
    res.ok && seen.some((c) => c.startsWith("git grep -z")),
    "roundComments: injected exec used for the head read",
  );
  const block = await lensCommentBlock("/tmp", undefined, "feature/x", 1000, fake);
  assert(
    block.includes("NOT CHECKED"),
    "lensCommentBlock: injected exec accepted (missing base reads NOT CHECKED)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
