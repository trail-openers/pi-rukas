/**
 * lib/lean-build-artifacts — the files a `lean/build` child leaves in its
 * worktree, and the frozen blobs the fixture commits for it.
 *
 * Split from `lib/lean-build-fixture.ts` for the 500-line gate (AGENTS.md §12),
 * along the seam that already exists there: the fixture BUILDS the repo and
 * drives the step; these make the ARTIFACTS a case puts in the child's way. They
 * are the two-argument writers (path + bytes) rather than the one-argument
 * readers of `lean-build-asserts.ts`.
 */

import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Worktree-relative path of a file the child may create. */
export function put(wt: string, rel: string, content: string, mode?: number): void {
  const target = path.join(wt, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: mode ?? 0o644 });
}

/** The child made a symlink at `rel` pointing at `target`. */
export function symlink(wt: string, rel: string, target: string): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  symlinkSync(target, path.join(wt, rel));
}

/**
 * The child hard-linked `rel` in the worktree to a file OUTSIDE the repo.
 * `linkSync` across filesystems throws EXDEV, so the outside file is written
 * into the same filesystem as the repo.
 */
export function hardlinkFromOutside(wt: string, rel: string, outsideAbs: string): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  linkSync(outsideAbs, path.join(wt, rel));
}

/**
 * Write a file outside every repo and return its absolute path, so a link case
 * can point at it. The return is the whole point: a caller that had to rebuild
 * the path would be asserting against a string it invented rather than the file
 * it wrote.
 */
export function putOutside(abs: string, content: string): string {
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}
