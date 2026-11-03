/**
 * lean/state-store — the run's file: where it lives, and the two operations
 * that touch it.
 *
 * Split from `state.ts` at AGENTS.md §12's line cap along the seam the module
 * already had: `state.ts` says what a run IS (its fields, its states, its
 * validator), this file says where one is kept and how a write survives a crash.
 * The paths are exported from here and re-exported by `state.ts`, so callers keep
 * one import site and the layout of `.pi/lean-state/` is stated once.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type LeanRun, LeanStateError, assertRunFile } from "./state.ts";

/** The directory every run's record lives in, under the repo root. */
export function leanStateDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "lean-state");
}

/** The one file that says where issue `issue`'s run stands. */
export function leanStateFile(repoRoot: string, issue: number): string {
  return path.join(leanStateDir(repoRoot), `${issue}.json`);
}

/** Lock file path for a run. One per issue, alongside the state file. */
export function leanLockFile(repoRoot: string, issue: number): string {
  return `${leanStateFile(repoRoot, issue)}.lock`;
}

/** A run as found on disk, or `undefined` when no file exists yet. Throws on garbage. */
export function loadRun(repoRoot: string, issue: number): LeanRun | undefined {
  const file = leanStateFile(repoRoot, issue);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new LeanStateError(`cannot read ${file}: ${(err as Error).message}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new LeanStateError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return assertRunFile(obj, file);
}

/**
 * Persist atomically. A failed write cleans up its tmp file and rethrows: the
 * caller keeps the previous good file and learns the save did not happen,
 * rather than believing a step was durable when it was not.
 */
export function saveRun(repoRoot: string, run: LeanRun): void {
  const file = leanStateFile(repoRoot, run.issue);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    // Only ever our own file, at a path we generated, and `renameSync` either
    // fully replaced the target or did not run — so removing it cannot destroy
    // durable state.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the tmp file is left behind; the caller already has the real error */
    }
    throw err;
  }
}
