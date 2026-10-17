#!/usr/bin/env bun
/**
 * #1105 — readHeadLines (review-findings-head.ts) classifies a path at a commit
 * without ever reading a tree listing as file lines (offline, real git repo).
 *
 * Cases: a real blob reads as lines; an absent path is missing; a directory,
 * the empty path, `.`, an absolute path, a trailing-slash path and a `..` path
 * are invalid; a malformed sha is an error (refused before git runs).
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHeadLines } from "../src/review-findings-head.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const repo = mkdtempSync(path.join(os.tmpdir(), "findings-head-"));
const sh = (cmd: string) =>
  execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

try {
  sh("git init -q -b main");
  sh("git config user.email dev@example.com");
  sh("git config user.name dev");
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "a.ts"), "one\ntwo\n");
  sh("git add -A");
  sh("git commit -qm one");
  const sha = sh("git rev-parse HEAD");

  const file = await readHeadLines(repo, sha, "src/a.ts");
  assert(
    file.kind === "lines" && file.lines[1] === "two",
    "a blob at the commit reads as its lines",
  );
  const absent = await readHeadLines(repo, sha, "src/gone.ts");
  assert(absent.kind === "missing", "a path absent from a readable commit is missing");
  const dir = await readHeadLines(repo, sha, "src");
  assert(dir.kind === "invalid", "a directory is invalid, never read as lines");

  for (const p of [
    "",
    ".",
    "/etc/passwd",
    "src/",
    "../x",
    "-x",
    "a\0b",
    "./src/a.ts",
    "src//a.ts",
    "src/./a.ts",
  ]) {
    const out = await readHeadLines(repo, sha, p);
    assert(out.kind === "invalid", `path ${JSON.stringify(p)} is invalid`);
  }

  // The path is repo-root-relative even when git runs from a subdirectory: a
  // cwd-relative ls-tree would look for src/src/a.ts and report a false missing.
  const fromSub = await readHeadLines(path.join(repo, "src"), sha, "src/a.ts");
  assert(
    fromSub.kind === "lines" && fromSub.lines[1] === "two",
    "a root-relative path reads as lines when cwd is a subdirectory",
  );

  const badSha = await readHeadLines(repo, "not-a-sha", "src/a.ts");
  assert(badSha.kind === "error", "a malformed sha is an error, not a read");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

process.exit(exit);
