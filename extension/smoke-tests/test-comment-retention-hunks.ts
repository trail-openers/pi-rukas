#!/usr/bin/env bun
/**
 * #1040 / follow-up — comment-retention hunk parsing and classification (real git).
 *
 * Split out of test-comment-retention.ts to keep both files under the 500-line
 * cap. Covers: a removed SQL-style `-- ` comment is content, never a file
 * header (`--- ` in the diff); and a comment reworded in the same hunk as an
 * added comment that contains its old wording is REPLACED, not retained via the
 * substring fallback and not double-counted.
 *
 * Also covers: the annotated-code binding (an unrelated remark in the same hunk
 * never replaces a comment whose documented code is unchanged); in-place
 * rewording (one change run) is a replacement regardless of word overlap; per-file
 * hunk keys (two deleted files); wording carry (≥3 words, ≥60% shared; `TODO: fix`
 * never counts); word-less markers (`/**`, `*\/`) are ignored; an unparseable `@@`
 * header (CRLF) is a named infra failure; and the fail-open paths (an erroring
 * empty-diff cross-check, an unresolved ref behind `git grep` exit 1).
 *
 * Deliberately NOT named `*-live.ts` (it spawns nothing; runs in the offline gate).
 */

import { rmSync } from "node:fs";
import {
  buildCommentsLine,
  findLostComments,
  formatLostComments,
} from "../src/comment-retention.ts";
import { runCommentRetentionGate } from "../src/work-driver-verify-develop-gates.ts";
import type { ExecFn } from "../src/worktree.ts";
import {
  git,
  realExec,
  repoWith,
  repoWithFiles,
  runRetention,
  runRetentionIn,
} from "./lib/comment-retention-fixtures.ts";

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
      res.lost.length === 1 && res.lost[0] === "-- old note",
      `sql (1): removed \`-- \` line is reported lost, not skipped as a header (got ${JSON.stringify(res.lost)})`,
    );
  }
}

// (2) #1040 same-hunk rewording: the comment is reworded to contain its old
// wording plus more, the code is unchanged. Must be replaced (one note), not
// lost, not retained by the substring fallback, not double-counted.
{
  const res = await runRetention(
    "src/app.ts",
    "// original wording here\nfunction f() {\n  return 1;\n}\n",
    "// original wording here, now with the rationale\nfunction f() {\n  return 1;\n}\n",
  );
  assert(res.ok === true, "same-hunk (2): result is ok");
  if (res.ok) {
    assert(res.lost.length === 0, "same-hunk (2): reworded-with-more comment is NOT lost");
    assert(
      res.replaced.length === 1 && res.replaced[0] === "// original wording here",
      `same-hunk (2): counted once as replaced (got ${JSON.stringify(res.replaced)})`,
    );
    assert(res.exempt === 0, "same-hunk (2): not also counted as exempt");
  }
}

// (3) Control: a comment dropped while an UNRELATED comment is added in the
// same hunk stays lost (the wording must be carried, not merely a comment added).
{
  const res = await runRetention(
    "src/app.ts",
    "// original wording here\nfunction f() {\n  return 1;\n}\n",
    "function f() {\n  return 1;\n}\n// unrelated remark\n",
  );
  assert(
    res.ok === true && res.lost.length === 1 && res.replaced.length === 0,
    "same-hunk (3): unrelated added comment → dropped comment stays lost",
  );
}

// (4) Row wording: "comment-retention: N lost, M replaced (exempt: K)".
{
  const row = formatLostComments({
    lost: ["// a"],
    replaced: ["// x", "// y", "// z"],
    exempt: 2,
  });
  assert(
    row.startsWith("comment-retention: 1 lost, 3 replaced (exempt: 2)"),
    `row wording: "N lost, M replaced (exempt: K)" (got ${row.split("\n")[0]})`,
  );
}

// (5) Annotated-code binding regression: the comment documents `function a()`,
// which is UNCHANGED; the code removed further down (`const q`) is unrelated.
// An added unrelated remark in the same hunk must not turn the drop into a
// replacement → LOST.
{
  const res = await runRetention(
    "src/app.ts",
    "// important invariant: keep lock\nfunction a() {\n  return 1;\n}\nconst q = 1;\n",
    "function a() {\n  return 1;\n}\nconst q = 2;\n// unrelated remark\n",
  );
  assert(res.ok === true, "binding (5): result is ok");
  if (res.ok) {
    assert(
      res.lost.length === 1 &&
        res.lost[0] === "// important invariant: keep lock" &&
        res.replaced.length === 0,
      `binding (5): comment above unchanged code stays lost (got ${JSON.stringify(res)})`,
    );
  }
}

// (6) Two deleted files in one diff: each file's comment is keyed to its own
// path (`+++ /dev/null` used to collapse every deleted file onto one key).
{
  const dir = await repoWithFiles(
    {
      "src/a.ts": "// doc for alpha\nfunction alpha() {\n  return 1;\n}\n",
      "src/b.ts": "// doc for beta\nfunction beta() {\n  return 2;\n}\n",
    },
    { "src/a.ts": null, "src/b.ts": null },
  );
  try {
    const res = await runRetentionIn(dir);
    assert(
      res.ok === true && res.lost.length === 0 && res.exempt === 2,
      `deleted files (6): each file's doc comment is exempt with its deleted code, both counted (got ${JSON.stringify(res)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (7) `// TODO: fix` → `// TODO: fix the other thing`, code unchanged: the
// rewording is in place (one change run), so it is REPLACED whatever the word
// overlap; the old line is not retained by the new one.
{
  const res = await runRetention(
    "src/app.ts",
    "// TODO: fix\nfunction t() {\n  return 1;\n}\n",
    "// TODO: fix the other thing\nfunction t() {\n  return 1;\n}\n",
  );
  assert(
    res.ok === true &&
      res.lost.length === 0 &&
      res.replaced.length === 1 &&
      res.replaced[0] === "// TODO: fix",
    "wording (7): `// TODO: fix` reworded in place with unchanged code → REPLACED",
  );
}

// (8) A CRLF `@@` header parses (trailing CR tolerated) and the drop is LOST;
// a genuinely malformed header fails closed with a named reason ("not run").
{
  const mkExec =
    (header: string): ExecFn =>
    async (cmd) =>
      cmd.startsWith("git diff")
        ? {
            stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n${header}\n-// gone\n function f() {}\n`,
          }
        : { stdout: "" };
  const crlf = await findLostComments(mkExec("@@ -1,2 +1,1 @@\r"), "/tmp", "a".repeat(40), "HEAD", [
    "src",
  ]);
  assert(
    crlf.ok === true && crlf.lost.length === 1,
    `crlf (8): CRLF hunk header parses and the lost comment is reported (got ${JSON.stringify(crlf)})`,
  );
  const bad = await findLostComments(mkExec("@@ garbage @@"), "/tmp", "a".repeat(40), "HEAD", [
    "src",
  ]);
  assert(
    bad.ok === false && bad.reason.includes("unparseable hunk header"),
    `crlf (8): malformed hunk header → ok:false naming the unparseable header (got ${JSON.stringify(bad)})`,
  );
}

// (9) In-place rewording: the comment is reworded on its own change run (no
// unchanged context between the removed and added comment), above an unchanged
// signature whose body changed. The rewording is in place → REPLACED, not LOST.
{
  const res = await runRetention(
    "src/app.ts",
    "// original wording here\nfunction f() {\n  return 1;\n}\n",
    "// different wording now\nfunction f() {\n  return 2;\n}\n",
  );
  assert(
    res.ok === true &&
      res.lost.length === 0 &&
      res.replaced.length === 1 &&
      res.replaced[0] === "// original wording here",
    "in-place (9): one-line rewording with a changed body → replaced, not lost",
  );
}

// (10) #1017 shape: 2-line comment reworded + body changed, hunk-local wording
// carry → replaced (2 lines), zero lost.
{
  const res = await runRetention(
    "src/app.ts",
    "// the doc for f, line one\n// the doc for f, line two\nfunction f() {\n  return 1;\n}\n",
    "// the doc for f, now reworded one\n// the doc for f, now reworded two\nfunction f() {\n  return 2;\n}\n",
  );
  assert(
    res.ok === true && res.lost.length === 0 && res.replaced.length === 2 && res.exempt === 0,
    "#1017 (10): reworded 2-line comment + changed code → replaced, not lost",
  );
}

// (11) #1019 shape: block comment dropped above unchanged code, no new comment
// in the hunk → every line lost.
{
  const res = await runRetention(
    "src/app.ts",
    "/* the doc for g.\n   more detail here */\nfunction g() {\n  return 1;\n}\n",
    "function g() {\n  return 1;\n}\n",
  );
  assert(
    res.ok === true && res.lost.length === 2 && res.replaced.length === 0,
    "#1019 (11): dropped block comment on unchanged code → all lines lost",
  );
}

// (12) Mixed hunks: A is reworded with its code changed (replaced); B is dropped
// above unchanged code in a separate hunk (lost).
{
  const res = await runRetention(
    "src/app.ts",
    "// doc for aaa\nfunction aaa() {\n  return 1;\n}\n\n\n\n// note about bbb\nfunction bbb() {\n  return 2;\n}\n",
    "// doc for aaa, reworded\nfunction aaa(n: number) {\n  return n;\n}\n\n\n\nfunction bbb() {\n  return 2;\n}\n",
  );
  assert(
    res.ok === true &&
      res.lost.length === 1 &&
      res.lost[0] === "// note about bbb" &&
      res.replaced.length === 1 &&
      res.replaced[0] === "// doc for aaa",
    "mixed (12): one lost (B, unchanged code) and one replaced (A, code changed)",
  );
}

// (13) The annotated signature changes in the same hunk as a new comment →
// replaced; the removed comment above an unchanged function in another hunk
// stays lost; the failure row lists only the lost line; the gate note lists the
// replaced line.
{
  const base =
    "// comment to keep\nfunction x() {\n  return 1;\n}\n\n\n\n\n// comment replaced by the new rationale\nfunction y() {\n  return 1;\n}\n";
  const head =
    "function x() {\n  return 1;\n}\n\n\n\n\n// comment replaced by the new rationale, now with detail\nfunction y(n) {\n  return n;\n}\n";
  const dir = await repoWith("src/app.ts", base, head);
  try {
    const res = await runRetentionIn(dir);
    assert(
      res.ok === true && res.lost.length === 1 && res.replaced.length === 1,
      "signature (13): one lost + one replaced",
    );
    if (res.ok) {
      const row = formatLostComments(res);
      assert(
        row.includes("comment to keep") && !row.includes("comment replaced"),
        "signature (13): failure row lists only the lost line",
      );
      const failures: string[] = [];
      const notes: string[] = [];
      const b = (await git(dir, ["rev-parse", "HEAD~1"])).stdout.trim();
      await runCommentRetentionGate(
        realExec,
        () => b,
        new Map([["default", dir]]),
        ["src"],
        failures,
        notes,
      );
      assert(
        failures.length === 1 && failures[0].includes("comment to keep"),
        "signature (13): gate failure lists only the lost line",
      );
      assert(
        notes.length === 1 && notes[0].includes("comment replaced"),
        "signature (13): gate note lists the replaced line",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (14) Replaced-only diff through the develop gate (real git): no failure, a note.
{
  const dir = await repoWith(
    "src/app.ts",
    "// compute the total for f\nfunction f() {\n  return 1;\n}\n",
    "// compute the total for f, now with detail\nfunction g() {\n  return 1;\n}\n",
  );
  try {
    const b = (await git(dir, ["rev-parse", "HEAD~1"])).stdout.trim();
    const failures: string[] = [];
    const notes: string[] = [];
    await runCommentRetentionGate(
      realExec,
      () => b,
      new Map([["default", dir]]),
      ["src"],
      failures,
      notes,
    );
    assert(failures.length === 0, "replaced-only (14): gate records no failure");
    assert(
      notes.some((n) => n.includes("replaced in the same hunk")),
      "replaced-only (14): gate emits a replaced note",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (15) Report line: replaced-only range → lost=0 with the replaced count and text.
{
  const fakeExec: ExecFn = async (cmd) => {
    if (cmd.startsWith("git diff"))
      return {
        stdout:
          "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-// compute the total for f\n-function f(){return 1;}\n+// compute the total for f, now with detail\n+function f(){return 2;}\n",
      };
    if (cmd.startsWith("git grep"))
      return {
        stdout: "HEAD:src/app.ts:function f(){return 2;}\nHEAD:src/app.ts:// new comment\n",
      };
    return { stdout: "" };
  };
  const line = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", fakeExec, ["src"]);
  assert(
    line.startsWith("comments: lost=0"),
    "report (15): replaced-only range → 'comments: lost=0'",
  );
  assert(
    line.includes("replaced: 1") && line.includes("compute the total"),
    "report (15): replaced count and line are listed",
  );
}

// (16) A timeout-like exec error is an infra error: the gate degrades to a
// not-run note, never a failure — and the timeout option is actually
// passed on every git exec (a recording fake asserts that).
{
  const seenOpts: Array<{ timeout?: number } | undefined> = [];
  const failingExec: ExecFn = async (cmd, opts) => {
    seenOpts.push(opts);
    throw new Error(`etimedout: git ${cmd.split(" ")[1]} timed out after 1000ms (killed)`);
  };
  const line = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", failingExec, ["src"]);
  assert(
    line.startsWith("comments: not-run ("),
    "timeout (16): timeout-like exec error → not-run note",
  );
  assert(
    seenOpts.length > 0 && seenOpts.every((o) => typeof o?.timeout === "number" && o.timeout > 0),
    "timeout (16): every git exec in findLostComments carries a timeout option",
  );
  const res = await findLostComments(failingExec, "/tmp", "abc", "def", ["src"]);
  assert(
    !res.ok,
    "timeout (16): a timed-out git diff is ok:false (note), never a lost-comment verdict",
  );
}

// (17) Boilerplate overlap: stopwords alone never carry a lost comment's wording.
{
  const res = await runRetention(
    "src/app.ts",
    "// see the docs for details\nfunction f() {\n  return 1;\n}\n",
    "function f() {\n  return 1;\n}\n// see the docs for more info\n",
  );
  assert(
    res.ok === true && res.lost.length === 1 && res.replaced.length === 0,
    "boilerplate (17): stopword-only overlap does not carry a lost comment",
  );
}

// (18) A blank unchanged line between a comment and its deleted code still
// binds them: the comment is EXEMPT with its code, not LOST.
{
  const res = await runRetention(
    "src/app.ts",
    "// doc for gone\n\nfunction gone() {\n  return 1;\n}\nconst keep = 1;\n",
    "\nconst keep = 1;\n",
  );
  assert(
    res.ok === true && res.lost.length === 0 && res.exempt === 1,
    `blank-line (18): comment bound to deleted code across a blank line is exempt (got ${JSON.stringify(res)})`,
  );
}

// (19) Multi-line jsdoc dropped above unchanged code, with an unrelated remark
// added in the same hunk: the `/**` opener and ` */` closer carry no words and
// are ignored; only the word-bearing body line is LOST.
{
  const res = await runRetention(
    "src/app.ts",
    "/**\n * the doc for g\n */\nfunction g() {\n  return 1;\n}\n",
    "function g() {\n  return 1;\n}\n// unrelated remark\n",
  );
  assert(
    res.ok === true &&
      res.lost.length === 1 &&
      res.lost[0] === "* the doc for g" &&
      res.replaced.length === 0,
    `jsdoc closer (19): word-less /** and */ ignored, body line lost (got ${JSON.stringify(res)})`,
  );
}

// (20) Trivial trailing text: a removed `*/` carries no words, so it is ignored
// (neither lost nor replaced); the opener is reworded in place by the head line.
{
  const res = await runRetention(
    "src/app.ts",
    "/* a long doc block here\n*/\nfunction m() {\n  return 1;\n}\n",
    "/* other unrelated doc */\nfunction m() {\n  return 1;\n}\n",
  );
  assert(
    res.ok === true &&
      res.lost.length === 0 &&
      res.replaced.length === 1 &&
      res.replaced[0] === "/* a long doc block here" &&
      !res.replaced.includes("*/"),
    `trivial retention (20): word-less "*/" ignored, opener replaced in place (got ${JSON.stringify(res)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
