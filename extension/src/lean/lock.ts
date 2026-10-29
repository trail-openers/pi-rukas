/**
 * lean/lock — one run per issue.
 *
 * The engine has no other concurrency control, and the absence is not
 * theoretical: two `runLean` calls on one issue started together both drove
 * the whole table, both ran `land`, and the second merge (or the second
 * comment, or the second branch) happened anyway. The step log makes a
 * *resumed* run safe; nothing made a *concurrent* one safe, because both
 * processes read the same file before either wrote it.
 *
 * The lock is `<repoRoot>/.pi/lean-state/<issue>.lock`, created with `O_EXCL`
 * (`wx`) so two openers cannot both see it as absent, and holding the owner's
 * pid so a reader can tell a live run from the residue of a killed one.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { LeanStateError, leanLockFile } from "./state.ts";

/**
 * Take the per-issue lock, or refuse. Returns the release function; the
 * caller MUST call it in a `finally` so a throw mid-drive does not wedge the
 * issue for every later run.
 */
export function acquireLock(repoRoot: string, issue: number): () => void {
  const file = leanLockFile(repoRoot, issue);
  mkdirSync(dirname(file), { recursive: true });
  const openOnce = (): number | undefined => {
    try {
      return openSync(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST")
        throw new LeanStateError(`cannot lock ${file}: ${(err as Error).message}`);
      return undefined;
    }
  };
  let fd = openOnce();
  if (fd === undefined) {
    const owner = readLockPid(file);
    if (owner !== undefined && processAlive(owner))
      throw new LeanStateError(`run already in progress (pid ${owner}) for issue ${issue}`);
    // Stale: the pid is dead or the bytes are unreadable. One retry — a
    // second EEXIST means somebody took it between the check and here, and
    // looping would turn a contention into a hang.
    try {
      rmSync(file, { force: true });
    } catch {
      /* nothing to remove; the retry below reports what actually happened */
    }
    fd = openOnce();
    if (fd === undefined) {
      const racer = readLockPid(file);
      throw new LeanStateError(
        `run already in progress${racer === undefined ? "" : ` (pid ${racer})`} for issue ${issue}`,
      );
    }
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return () => {
    try {
      rmSync(file, { force: true });
    } catch {
      /* best effort — a leftover lock ages out the moment this pid is gone */
    }
  };
}

/** The pid a lock file names, or undefined when it names none. */
function readLockPid(file: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Is this pid a live process? EPERM means it EXISTS but belongs to another
 * uid — still alive as far as this lock is concerned.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
