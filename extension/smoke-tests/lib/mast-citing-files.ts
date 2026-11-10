#!/usr/bin/env bun
/**
 * mast-citing-files — the derived roster of repository files that cite the MAST
 * paper, for `test-mast-authoritative-block.ts`. Split out to keep both files
 * under the size ratchet (the same move `lib/pi-version-census.ts` made for the
 * Pi version census, which enumerates with the identical `ls-files` argv).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { gitTestEnv } from "./git-test-env.ts";

/**
 * Every repository file that names the paper — derived, never hand-listed, and
 * enumerated by git, never by a filesystem walk. The gate means "every file of
 * the repository", and a walk reaches content that is not part of it — a private
 * notes directory, a nested separate repo, a checkout leftover — so consolidated
 * /work verify in the main checkout failed on files no reviewer sees and no PR can
 * fix. Git enumeration still counts untracked work (a citing file not yet added is
 * a site) while anything .gitignore'd is out by definition — including a path the
 * host's per-user ignore file names, which is why the git child below runs with
 * `gitTestEnv()` rather than the operator's environment. The skip-list stays
 * because git enumerates tracked paths too, so an accidentally committed vendor
 * directory is listed content rather than a stray local one.
 *
 * `minSites` is the roster floor: what the registry checks consume is this roster,
 * not the listing, and the filters below can empty it while git still reports
 * paths. Silence is never a pass — an empty or incomplete roster throws rather
 * than letting the registry loops judge nothing.
 */
export function discoverCitingFiles(repoRoot: string, arxiv: string, minSites: number): string[] {
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "tmp",
    ".worktrees",
    "outputs",
    "coverage",
  ]);
  // No shell: argv array to execFileSync, so the repo path is never parsed; a
  // failed `ls-files` throws out of it rather than passing. `env: gitTestEnv()`
  // is not decoration — `--exclude-standard` consults the ignore stack whose
  // topmost source is the host's per-user ignore file, so on a host with a
  // hostile `~/.config/git/ignore` a new citing file vanishes from the listing
  // and this gate reports green while the file sits in the tree. `execFileSync`
  // with no `env` inherits the REAL `environ` on bun 1.3, so the isolated set
  // has to be threaded (see lib/git-test-env.ts). `maxBuffer` bounds a listing
  // that grows with the repository; overflowing it throws red, never green.
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
  const out: string[] = [];
  for (const relative of listed.split("\u0000")) {
    if (relative === "") continue;
    const segments = relative.split("/");
    if (segments.some((segment) => skip.has(segment))) continue;
    if (!(relative.endsWith(".ts") || relative.endsWith(".md"))) continue;
    // The detector's own exclusion: `.d.ts` declarations are not sites.
    if (relative.endsWith(".d.ts")) continue;
    try {
      if (readFileSync(path.join(repoRoot, relative), "utf8").includes(arxiv)) out.push(relative);
    } catch {
      /* unreadable — not a site, and not this gate's problem */
    }
  }
  if (out.length < minSites) {
    throw new Error(
      `discovery found ${out.length} citing files among the git-listed paths at ${repoRoot}, below the ${minSites} registered sites — refusing to judge an incomplete roster`,
    );
  }
  return out.sort();
}
