#!/usr/bin/env bun
/**
 * #1153 — the driver's git plumbing has one typed entry point, and the
 * "commits ahead of base, and can we tell?" question has one answer.
 *
 * 1. CANARY — no driver git call in the listed modules passes a command
 *    string. Every call goes through `execGit` (argv + timeout). The control
 *    proves the scanner can fail.
 * 2. REAL GIT — `aheadOfBase` returns each of its five kinds against a real
 *    repository, and `refResolves` separates "absent" from "unknown".
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { aheadOfBase, execGit, refResolves } from "../src/git-range.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── 1. canary ────────────────────────────────────────────────────────────────

const LISTED = [
  "git-range.ts",
  "work-driver-diff.ts",
  "work-driver-verify.ts",
  "work-driver-verify-pr17.ts",
  "comment-retention.ts",
];

/** A git command string handed to an exec call: a `(` then a literal beginning `git `. */
const COMMAND_STRING = /\([ \t]*["'`]git[ \t]/;

function commandStringLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    return COMMAND_STRING.test(line);
  });
}

const srcDir = path.join(import.meta.dir, "..", "src");
for (const f of LISTED) {
  const hits = commandStringLines(readFileSync(path.join(srcDir, f), "utf8"));
  assert(hits.length === 0, `${f}: no git command string (${hits.length} found)`);
}
assert(
  commandStringLines('await exec("git diff HEAD", {})').length === 1,
  "control: the scanner flags a git command string",
);

// ── 2. real git ──────────────────────────────────────────────────────────────

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

const dir = mkdtempSync(path.join(tmpdir(), "git-range-1153-"));
const git = (args: string[]) =>
  execGit(exec, dir, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);

try {
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-q", "-m", "base"]);
  // The base is what origin/main would point at.
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await git(["update-ref", "refs/remotes/origin/main", base]);
  // Two commits on the feature branch, pushed as origin/feat.
  await git(["checkout", "-q", "-b", "feat"]);
  for (const n of [1, 2]) {
    writeFileSync(path.join(dir, `f${n}.txt`), `${n}\n`);
    await git(["add", `f${n}.txt`]);
    await git(["commit", "-q", "-m", `c${n}`]);
  }
  await git(["update-ref", "refs/remotes/origin/feat", "HEAD"]);

  const ahead = await aheadOfBase(exec, dir, "origin/main", "origin/feat");
  assert(
    ahead.kind === "ahead" && ahead.n === 2,
    `ahead: two commits ahead (got ${JSON.stringify(ahead)})`,
  );

  const empty = await aheadOfBase(exec, dir, "origin/feat", "origin/feat");
  assert(empty.kind === "empty", `empty: head equals base (got ${JSON.stringify(empty)})`);

  const unpushed = await aheadOfBase(exec, dir, "origin/main", "origin/nope");
  assert(
    unpushed.kind === "unpushed",
    `unpushed: head ref absent (got ${JSON.stringify(unpushed)})`,
  );

  const unresolved = await aheadOfBase(exec, dir, "origin/nomain", "origin/feat");
  assert(
    unresolved.kind === "unresolved",
    `unresolved: base ref absent (got ${JSON.stringify(unresolved)})`,
  );

  const notARepo = mkdtempSync(path.join(tmpdir(), "git-range-1153-norepo-"));
  try {
    const unknown = await aheadOfBase(exec, notARepo, "origin/main", "origin/feat");
    assert(
      unknown.kind === "unknown",
      `unknown: git cannot run in a non-repo (got ${JSON.stringify(unknown)})`,
    );
    const probe = await refResolves(exec, notARepo, "origin/feat");
    assert(probe.state === "unknown", "refResolves: a non-repo is unknown, not absent");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }

  const absent = await refResolves(exec, dir, "origin/nope");
  assert(absent.state === "absent", "refResolves: a missing ref is absent (exit 1)");
  const resolves = await refResolves(exec, dir, "origin/feat");
  assert(resolves.state === "resolves", "refResolves: a present ref resolves");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);
