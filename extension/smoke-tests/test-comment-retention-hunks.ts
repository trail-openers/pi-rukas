#!/usr/bin/env bun
/**
 * #1040 — comment-retention hunk parsing and same-hunk rewording (real git).
 *
 * Split out of test-comment-retention.ts to keep both files under the 500-line
 * cap. Covers: a removed SQL-style `-- ` comment is content, never a file
 * header (`--- ` in the diff); and a comment reworded in the same hunk as an
 * added comment that contains its old wording is REPLACED, not retained via the
 * substring fallback and not double-counted.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findLostComments, formatLostComments } from "../src/comment-retention.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/** Scratch repo: `file` at base, then rewritten to `headContent` in a second commit. */
async function repoWith(file: string, baseContent: string, headContent: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-hunks-"));
  await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), baseContent);
  await git(dir, ["add", "-A", "src"]);
  await git(dir, ["commit", "-q", "-m", "base"]);
  writeFileSync(path.join(dir, file), headContent);
  await git(dir, ["add", "-A", "src"]);
  await git(dir, ["commit", "-q", "-m", "head"]);
  return dir;
}

async function run(file: string, base: string, head: string) {
  const dir = await repoWith(file, base, head);
  try {
    const b = (await git(dir, ["rev-parse", "HEAD~1"])).stdout.trim();
    const h = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    return await findLostComments(realExec, dir, b, h, ["src"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (1) A removed SQL comment `-- old note` directly followed by an added `++ `
// line is diff-encoded as `--- old note` / `+++ new`. It must be content (lost),
// not mistaken for a file header and silently skipped.
{
  const res = await run(
    "src/q.sql",
    "-- old note\nSELECT 1;\n",
    "++ new\nSELECT 1;\n",
  );
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
  const res = await run(
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
  const res = await run(
    "src/app.ts",
    "// original wording here\nfunction f() {\n  return 1;\n}\n",
    "function f() {\n  return 1;\n}\n// unrelated remark\n",
  );
  assert(res.ok === true, "same-hunk (3): result is ok");
  if (res.ok) {
    assert(res.ok && res.lost.length === 1 && res.replaced.length === 0, "same-hunk (3): unrelated added comment → dropped comment stays lost");
  }
}

// (4) Row wording: "comment-retention: N lost, M replaced (exempt: K)".
{
  const row = formatLostComments(["// a"], 2, 3);
  assert(
    row.startsWith("comment-retention: 1 lost, 3 replaced (exempt: 2)"),
    `row wording: "N lost, M replaced (exempt: K)" (got ${row.split("\n")[0]})`,
  );
}

process.exit(exit);
