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
import type { DispatchResult } from "../../src/types.ts";
import { git, gitEnvFor } from "./lean-build-fixture.ts";

/**
 * What one dispatch of the fake child returns, per dispatch index: a list read
 * by index, or a rule called with it. `lib/lean-build-fixture.ts` puts it on
 * `RunOpts`; the override lives here so the fixture stays inside the size cap
 * while a case can still hand its dead child real fields.
 */
export type DispatchResultOverride =
  | Partial<DispatchResult>[]
  | ((n: number) => Partial<DispatchResult> | undefined);

/** The override for the nth child, or `undefined` when the case gave none. */
export function resultOverride(
  over: DispatchResultOverride | undefined,
  n: number,
): Partial<DispatchResult> | undefined {
  if (over === undefined) return undefined;
  return typeof over === "function" ? over(n) : over[n];
}

/**
 * The clock a case puts on the run record: the whole-cycle deadline (a fixed
 * epoch, or one read off the case's own clock) and the `now` the step is told to
 * use. Both absent is today's shape — no deadline, a fixed clock — which is what
 * every case that says nothing about the deadline expects.
 *
 * A bounded-wait case needs both: the wait-take and the wait-skip branch differ
 * only in what `deadline − now` leaves, and a fixture frozen at one reading can
 * drive neither. Such a case pins `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` so the
 * allowance it compares against is its own, not the shipped one.
 */
export interface ClockOpts {
  deadlineMs?: number | ((now: number) => number | undefined);
  now?: () => number;
}

/** The absolute deadline to stamp on the run, or `undefined` for none. */
export function deadlineOf(clock: ClockOpts | undefined, now: () => number): number | undefined {
  const d = clock?.deadlineMs;
  if (d === undefined) return undefined;
  return typeof d === "number" ? d : d(now());
}

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
