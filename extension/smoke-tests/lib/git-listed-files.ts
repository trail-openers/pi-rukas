#!/usr/bin/env bun
/**
 * git-listed-files — the one enumeration of "the files of this repository" that
 * the repository-wide gates share (`test-file-size-limit.ts`, and
 * `lib/mast-citing-files.ts` for the MAST site roster).
 *
 * Both gates once walked the filesystem, and a walk reaches content that is not
 * part of the repository: a private notes directory, a nested separate repo, a
 * checkout leftover. Consolidated /work verify runs in the main checkout, so on a
 * host that owns such a tree both gates failed on files no reviewer sees and no PR
 * can fix, while CI stayed green. Git enumeration is the shape that matches the
 * contract: `--cached --others` keeps untracked work in scope (an oversized or
 * citing file not yet added is exactly what these gates exist to catch) while
 * anything the ignore stack excludes is out by definition.
 */

import { execFileSync } from "node:child_process";

import { gitTestEnv } from "./git-test-env.ts";

/**
 * Every path git considers part of `repoRoot`, repo-relative and sorted.
 *
 * No shell: an argv array to `execFileSync`, so the root is never parsed, and a
 * failed `ls-files` throws out of it rather than passing. `env: gitTestEnv()` is
 * not decoration — `--exclude-standard` consults the ignore stack whose topmost
 * source is the host's per-user ignore file, so on a host with a hostile
 * `~/.config/git/ignore` a path vanishes from the listing and the judging gate
 * reports green while the file sits in the tree. `execFileSync` with no `env`
 * inherits the REAL `environ` on bun 1.3, so the isolated set has to be threaded
 * (see lib/git-test-env.ts). `maxBuffer` bounds a listing that grows with the
 * repository; overflowing it throws red, never green. An empty listing throws:
 * silence is never a pass, and an unreadable roster is not a clean repository.
 */
export function gitListedFiles(repoRoot: string): string[] {
  const listed = execFileSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "-C",
      repoRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitTestEnv() },
  );
  if (listed.trim() === "") {
    throw new Error(
      `git ls-files at ${repoRoot} returned no paths — refusing to judge an empty roster`,
    );
  }
  return listed
    .split("\u0000")
    .filter((relative) => relative !== "")
    .sort();
}
