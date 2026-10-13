#!/usr/bin/env bun
/**
 * #1040 — comment-retention hunk parsing and the three-bucket classification
 * (real git where the fixture is git-shaped).
 *
 * Every removed comment line is RETAINED (its text survives at head), EXEMPT
 * (its annotated code was removed and the hunk adds no comment) or LOST.
 * A lost comment is evidence for the reviewers, never a failure: each lost
 * entry carries its file and the added comment lines of its hunk.
 *
 * Fail-closed paths covered here: a removed SQL `-- ` comment is content, not a
 * file header; a CRLF `@@` header parses; an unparseable `@@` header is a named
 * error; deleted files are keyed by their real path; word-less markers are
 * ignored.
 *
 * Deliberately NOT named `*-live.ts` (it spawns nothing; runs in the offline gate).
 */

import { rmSync } from "node:fs";
import {
  formatLostComments,
  formatReportLine,
  renderCommentEvidence,
} from "../src/comment-evidence.ts";
import { classifyHunk, parseHunks } from "../src/comment-retention-hunks.ts";
import { findLostComments as findLostCommentsRaw } from "../src/comment-retention.ts";
import { asShellForm } from "./lib/argv-shell.ts";

// #1134 — these stubs match the shell-form command string; asShellForm shows argv calls in that form.
const findLostComments = (...args: Parameters<typeof findLostCommentsRaw>) => {
  const [exec, ...rest] = args;
  return findLostCommentsRaw(asShellForm(exec), ...rest);
};
import type { ExecFn } from "../src/worktree.ts";
import { repoWithFiles, runRetention, runRetentionIn } from "./lib/comment-retention-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// (1) A removed SQL comment `-- old note` directly followed by an added `++ `
// line is diff-encoded as `--- old note` / `+++ new`. It must be content (lost),
// not mistaken for a file header and silently skipped.
{
  const res = await runRetention("src/q.sql", "-- old note\nSELECT 1;\n", "++ new\nSELECT 1;\n");
  assert(res.ok === true, "sql (1): result is ok");
  if (res.ok) {
    assert(
      res.lost.length === 1 && res.lost[0]?.text === "-- old note",
      `sql (1): removed \`-- \` line is lost, not skipped as a header (got ${JSON.stringify(res.lost)})`,
    );
  }
}

// (2) Reworded in place above UNCHANGED code: the old wording is gone and the
// new comment is recorded as added context. Under the three-bucket contract it
// is LOST (a reviewer judges it), not "replaced".
{
  const res = await runRetention(
    "src/app.ts",
    "// original wording here\nfunction f() {\n  return 1;\n}\n",
    "// different wording now\nfunction f() {\n  return 1;\n}\n",
  );
  assert(res.ok === true, "reword (2): result is ok");
  if (res.ok) {
    assert(
      res.lost.length === 1 &&
        res.lost[0]?.text === "// original wording here" &&
        res.lost[0]?.addedNearby.includes("// different wording now"),
      `reword (2): lost, with the added comment as context (got ${JSON.stringify(res.lost)})`,
    );
  }
}

// (3) Control: a comment dropped while an UNRELATED comment is added in the
// same hunk stays lost (the wording must be carried, not merely a comment added).
{
  const res = await runRetention(
    "src/app.ts",
    "// keep the retry budget at 3\nfunction f() {\n  return 1;\n}\n",
    "// an unrelated remark\nfunction f() {\n  return 1;\n}\n",
  );
  assert(
    res.ok === true && res.ok && res.lost.length === 1 && res.exempt === 0,
    "unrelated (3): dropped comment above unchanged code is lost",
  );
}

// (4) Exempt: a comment removed together with its annotated code, and the hunk
// adds no comment. Nothing is lost.
{
  const res = await runRetention(
    "src/app.ts",
    "function keep() {}\n// doc for gone()\nfunction gone() {\n  return 1;\n}\n",
    "function keep() {}\n",
  );
  assert(
    res.ok === true && res.ok && res.lost.length === 0 && res.exempt >= 1,
    `exempt (4): comment deleted with its code is exempt, not lost (got ${JSON.stringify(res)})`,
  );
}

// (5) The annotated code is removed but the hunk ADDS a comment: no longer
// exempt. The removed comment is lost, with the added comment as context.
{
  const res = await runRetention(
    "src/app.ts",
    "// doc for gone()\nfunction gone() {\n  return 1;\n}\n",
    "// new rationale\nfunction other() {\n  return 2;\n}\n",
  );
  assert(
    res.ok === true &&
      res.ok &&
      res.lost.length === 1 &&
      res.lost[0]?.addedNearby[0] === "// new rationale" &&
      res.exempt === 0,
    `annotated-removed (5): with an added comment in the hunk it is lost, not exempt`,
  );
}

// (6) Two deleted files in one diff: each lost comment is keyed to its own file.
{
  const dir = await repoWithFiles(
    {
      "src/a.ts": "// doc for aaa\nconst a = 1;\n",
      "src/b.ts": "// doc for bbb\nconst b = 2;\n",
    },
    { "src/a.ts": "const a = 1;\n", "src/b.ts": "const b = 2;\n" },
  );
  try {
    const res = await runRetentionIn(dir);
    const files = res.ok ? res.lost.map((l) => l.file).sort() : [];
    assert(
      res.ok === true && files.join(",") === "src/a.ts,src/b.ts",
      `two files (6): each lost comment keyed to its own path (got ${JSON.stringify(res)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (7) A CRLF `@@` header parses (trailing CR tolerated); the drop is lost.
{
  const diff =
    "--- a/src/app.ts\r\n+++ b/src/app.ts\r\n@@ -1,3 +1,2 @@\r\n-// crlf doc here\r\n function f() {}\r\n+function g() {}\r\n";
  const parsed = parseHunks(diff);
  assert(parsed.ok === true, "crlf (7): CRLF diff parses");
  const hunk = parsed.ok ? parsed.hunks[0] : undefined;
  if (!hunk) {
    assert(false, "crlf (7): CRLF diff yields a hunk");
  } else {
    const v = classifyHunk(hunk, () => false);
    assert(v.lost.length === 1 && v.lost[0]?.text === "// crlf doc here", "crlf (7): drop is lost");
  }
}

// (8) Fail-closed: an unparseable `@@` header is a named error, never skipped.
{
  const parsed = parseHunks("--- a/x.ts\n+++ b/x.ts\n@@ garbage @@\n-// x\n");
  assert(
    parsed.ok === false && parsed.reason.includes("unparseable hunk header"),
    "header (8): unparseable @@ header → ok:false with a named reason",
  );
}

// (9) Word-less markers (`/**`, ` *`, `*\/`) carry no wording and are ignored.
{
  const res = await runRetention(
    "src/app.ts",
    "/**\n * \n */\nfunction f() {\n  return 1;\n}\n",
    "function f() {\n  return 1;\n}\n",
  );
  assert(
    res.ok === true && res.ok && res.lost.length === 0,
    "markers (9): word-less marker lines are neither lost nor counted",
  );
}

// (10) Retained: a comment moved to the end of a head code line is not lost.
{
  const res = await runRetention(
    "src/app.ts",
    "// the retry budget\nconst n = 3;\n",
    "const n = 3; // the retry budget\n",
  );
  assert(
    res.ok === true && res.ok && res.lost.length === 0,
    "retained (10): trailing-part retention keeps a moved comment",
  );
}

// (10b) A comment moved onto a code line WITH trailing text is retained; a
// comment whose text is only a fragment of a longer word at head is lost.
{
  const moved = await runRetention(
    "src/app.ts",
    "// the retry budget\nconst n = 3;\n",
    "const n = 3; // the retry budget (see config)\n",
  );
  assert(
    moved.ok === true && moved.ok && moved.lost.length === 0,
    "retained (10b): comment moved with trailing text on a code line is retained",
  );
  const fragment = await runRetention(
    "src/app.ts",
    "// Fast\nconst n = 3;\n",
    "const n = 3;\n// Fasting\n",
  );
  assert(
    fragment.ok === true && fragment.ok && fragment.lost.length === 0,
    "retained (10b): a longer word containing the comment text retains it (substring, #1040)",
  );
}

// (11) Evidence rendering: the note names each lost line with its file and the
// added comment as context, and says it is not a failure.
{
  const row = formatLostComments({
    lost: [{ file: "src/a.ts", text: "// old doc", addedNearby: ["// new doc"] }],
    exempt: 2,
  });
  assert(
    row.startsWith("comment-retention: 1 comment line(s) removed and not retained (exempt: 2)") &&
      row.includes("not a failure") &&
      row.includes("src/a.ts: // old doc") &&
      row.includes("added nearby: // new doc"),
    `note (11): lists file, text and added context, marked not a failure`,
  );
  const line = formatReportLine({
    ok: true,
    lost: [{ file: "src/a.ts", text: "// old doc", addedNearby: [] }],
    exempt: 0,
  });
  assert(
    line.startsWith("comments: lost=1 (exempt: 0)") && !line.includes("replaced"),
    `report (11): keeps the comments: lost=N (exempt: K) line, no replaced bucket`,
  );
}

// (12) The "Comments removed by this change" section reaches the reviewers
// with each lost line; an empty result yields no section.
{
  const diff =
    "--- a/extension/src/app.ts\n+++ b/extension/src/app.ts\n@@ -1,2 +1,2 @@\n-// old doc here\n function f() {}\n";
  const fake: ExecFn = async (cmd) => {
    if (cmd.startsWith("git diff")) return { stdout: diff };
    if (cmd.startsWith("git grep"))
      return { stdout: "HEAD:extension/src/app.ts\0function f() {}\n" };
    return { stdout: "" };
  };
  const section = renderCommentEvidence(
    await findLostComments(fake, "/tmp", "abc", "def", ["extension/src"], 1000),
  );
  assert(
    section.includes("Comments removed by this change") &&
      section.includes("extension/src/app.ts: // old doc here") &&
      section.includes("<<<comment-evidence"),
    "section (12): the reviewer data block lists the lost line, fenced as data",
  );
  // A genuinely empty range: the diff is empty AND the scoped commit count is 0.
  const none = renderCommentEvidence(
    await findLostComments(
      async (cmd) => ({ stdout: cmd.startsWith("git rev-list") ? "0\n" : "" }),
      "/tmp",
      "abc",
      "def",
      ["extension/src"],
      1000,
    ),
  );
  assert(none === "", "section (12): empty diff → no section");
  // An unreadable commit count is NOT silence: the reviewer is told it was not run.
  const unreadable = renderCommentEvidence(
    await findLostComments(
      async () => ({ stdout: "" }),
      "/tmp",
      "abc",
      "def",
      ["extension/src"],
      1000,
    ),
  );
  assert(
    unreadable.includes("NOT CHECKED ("),
    "section (12): unreadable check → visible NOT CHECKED line",
  );
}

// (13) Fail-closed: the report line degrades to not-run when the range is unreadable.
{
  const line = formatReportLine(
    await findLostComments(
      async () => {
        throw new Error("boom");
      },
      "/tmp",
      "abc",
      "def",
      ["extension/src"],
      1000,
    ),
  );
  assert(
    line.startsWith("comments: NOT CHECKED"),
    "report (13): unreadable range → NOT CHECKED, never a pass",
  );
}

// (14) Fail-closed: a diff whose head tree cannot be read is ok:false, not "nothing lost".
{
  const diff =
    "--- a/extension/src/x.ts\n+++ b/extension/src/x.ts\n@@ -1,2 +1,1 @@\n-// doc\n f();\n";
  const res = await findLostComments(
    async (cmd) => {
      if (cmd.startsWith("git diff")) return { stdout: diff };
      throw new Error("unreadable");
    },
    "/tmp",
    "abc",
    "def",
    ["extension/src"],
  );
  assert(res.ok === false, "fail-closed (14): unreadable head tree → ok:false");
}

// A timeout-like exec error is an infra error: the gate degrades to a
// not-run note, never a failure — and the timeout option is actually
// passed on every git exec (a recording fake asserts that).
{
  const seenOpts: Array<{ timeout?: number } | undefined> = [];
  const failingExec: ExecFn = async (cmd, opts) => {
    seenOpts.push(opts);
    throw new Error(`etimedout: git ${cmd.split(" ")[1]} timed out after 1000ms (killed)`);
  };
  const res = await findLostComments(failingExec, "/tmp", "abc", "def", ["src"], 1234);
  assert(
    !res.ok && res.reason.startsWith("git diff failed"),
    "timeout (16): timeout-like exec error → ok:false (not-run), never a lost-comment verdict",
  );
  assert(
    seenOpts.length > 0 && seenOpts.every((o) => o?.timeout === 1234),
    "timeout (16): every git exec in findLostComments carries the caller's timeout",
  );
}

// (17) A one-word comment moved onto the end of a code line is retained: its
// trailing part is a word, so the head line that ends with it matches.
{
  const res = await runRetention(
    "src/app.ts",
    "const timeout = 30;\n// seconds\n",
    "const timeout = 30; // seconds\n",
  );
  assert(
    res.ok === true && res.ok && res.lost.length === 0,
    "one-word tail (17): a one-word comment moved onto a code line is retained",
  );
}

// (18) A comment re-wrapped onto a longer head line is retained by its prefix;
// only the genuinely reworded line is lost.
{
  const res = await runRetention(
    "src/app.ts",
    "// the retry budget is\n// three attempts\nconst n = 3;\n",
    "// the retry budget is three\n// attempts.\nconst n = 3;\n",
  );
  assert(
    res.ok === true && res.ok && res.lost.length === 1 && res.lost[0]?.text === "// three attempts",
    "re-wrap (18): prefix-extended comment is retained; the reworded line is lost",
  );
}

if (exit !== 0) process.exit(exit);
console.log("comment-retention hunks: all assertions passed");
