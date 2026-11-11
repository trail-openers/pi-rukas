#!/usr/bin/env bun
/**
 * mast-citing-files — the derived roster of repository files that cite the MAST
 * paper, for `test-mast-authoritative-block.ts`. Split out to keep both files
 * under the size ratchet. The listing itself is `lib/git-listed-files.ts`, shared
 * with `test-file-size-limit.ts` so the two repository-wide gates cannot drift to
 * different definitions of "the files of this repository".
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { gitListedFiles } from "./git-listed-files.ts";

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
  const out: string[] = [];
  for (const relative of gitListedFiles(repoRoot)) {
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
