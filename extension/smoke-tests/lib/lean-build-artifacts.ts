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

import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ExecResult, execp } from "../../src/exec.ts";
import type { BuildExec } from "../../src/lean/build-types.ts";
import { git, gitEnvFor } from "./lean-build-fixture.ts";

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
 * One file committed into a FIXTURE commit, executable, with its parent
 * directories — the shape an acceptance test needs so the project's runner can
 * run it. `dir` is the caller's repo-relative joiner, so a fixture never spells
 * an absolute path and a case never chooses a mode: these are committed bytes.
 */
export function putCommitted(dir: (rel: string) => string, rel: string, text: string): void {
  const target = dir(rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { mode: 0o755 });
  chmodSync(target, 0o755);
}

/** The child committed whatever it had, itself. */
export function childCommit(wt: string, message: string): void {
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", message);
}

/** The worktree's HEAD, or `""` when the tree is gone. */
export function headOf(wt: string): string {
  try {
    return git(wt, "rev-parse", "HEAD");
  } catch {
    return "";
  }
}

/**
 * Write a file outside every repo and return its absolute path
 * Write a file outside every repo and return its absolute path
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

/**
 * A stand-in runner for the driver's re-run of a reported frozen test: called
 * INSTEAD of the real `execp` for a non-git command issued after the child
 * returned — which is exactly when the blocked gate re-runs the named files.
 * git keeps going to the real binary and is recorded in `gitArgvs`, so a case
 * about the step's normalisation and commit path is untouched by a bad-runner
 * case.
 */
export function reRunStub(
  stub: ((cmd: string, o?: unknown) => Promise<unknown>) | undefined,
  dispatched: () => number,
  gitArgvs: string[][],
): BuildExec {
  return async (cmd, o) => {
    if (cmd === "git" && o?.argv) gitArgvs.push(o.argv);
    if (stub !== undefined && cmd !== "git" && dispatched() > 0)
      return (await stub(cmd, o)) as ExecResult;
    return execp(cmd, { ...o, env: gitEnvFor() });
  };
}

/**
 * Watches every non-git exec WITHOUT replacing it: the real runner still runs,
 * so a case can read what the driver handed it (an env, a timeout) while the
 * runner's verdict stays the real one. `reRunStub`'s stub REPLACES the runner,
 * which is the wrong shape for an assertion about the arguments.
 */
export function execObserver(
  inner: BuildExec,
  spy: ((cmd: string, o?: unknown) => void) | undefined,
): BuildExec {
  return async (cmd, o) => {
    if (cmd !== "git") spy?.(cmd, o);
    return inner(cmd, o);
  };
}
