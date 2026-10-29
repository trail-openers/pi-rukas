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
 * The lock is `<repoRoot>/.pi/lean-state/<issue>.lock` and it is taken
 * ATOMICALLY WITH ITS OWNER INSIDE: the bytes are written to a unique temp
 * file in the same directory and then `link`ed into place, so the moment the
 * lock exists it names the pid that created it. The old shape — `open(O_EXCL)`
 * and then `write` the pid — had a window between those two calls in which a
 * concurrent reader saw a lock with NO pid in it, called it unreadable, and
 * either refused a legitimate takeover or (worse, under the old stale rule)
 * deleted a lock that was being taken.
 *
 * Stealing is what the rename is for. A stale lock is first renamed to a
 * unique `<lock>.stale-<pid>-<rand>` and only then unlinked: two stealers that
 * both decided the lock was dead cannot both delete a fresh lock one of them
 * just created, because whichever renamed first has moved the file the second
 * one goes looking for.
 *
 * An unparseable or empty lock is NEVER stolen. Only a body whose pid parses
 * and whose process is demonstrably dead may be removed — a lock whose owner
 * this process cannot identify is somebody's run, and refusing is cheaper
 * than double-driving a merge.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { processAlive } from "../process-liveness.ts";
import { LeanStateError, leanLockFile } from "./state.ts";

/**
 * Take the per-issue lock, or refuse. Returns the release function; the
 * caller MUST call it in a `finally` so a throw mid-drive does not wedge the
 * issue for every later run.
 */
export function acquireLock(repoRoot: string, issue: number): () => void {
  const file = leanLockFile(repoRoot, issue);
  mkdirSync(dirname(file), { recursive: true });
  const own = `${process.pid}\n`;
  // One attempt, then one more after a stale sweep; a second EEXIST means
  // somebody took the lock between the check and here, and looping further
  // would turn contention into a hang.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryLink(file, own)) return releaser(file, own);
    const owner = readLockPid(file);
    if (owner === "unreadable") throw new LeanStateError(`lock unreadable: ${file}`);
    if (owner !== undefined) {
      if (processAlive(owner))
        throw new LeanStateError(`run already in progress (pid ${owner}) for issue ${issue}`);
      stealStale(file);
    } else {
      // The path is there but cannot be read at all — a permission or I/O
      // problem, not a stale run. Refuse rather than sweep what we cannot see.
      throw new LeanStateError(`lock unreadable: ${file}`);
    }
  }
  const racer = readLockPid(file);
  throw new LeanStateError(
    `run already in progress${typeof racer === "number" ? ` (pid ${racer})` : ""} for issue ${issue}`,
  );
}

/**
 * Link a pid-bearing temp file into the lock path. True means we hold it.
 *
 * `link` fails with EEXIST when the target exists and with nothing else we
 * care about here, so every other errno is a real error and is reported as
 * one. The temp file is the caller's own (unique name, in the same directory
 * so the link never crosses a filesystem) and is always unlinked.
 */
function tryLink(file: string, body: string): boolean {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, "utf8");
    try {
      linkSync(tmp, file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new LeanStateError(`cannot lock ${file}: ${(err as Error).message}`);
    }
  } finally {
    // Only ever our own file at a path we generated; the lock, if it exists,
    // is a separate directory entry that this unlink cannot touch.
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean; the outcome above already says what happened */
    }
  }
}

/**
 * Move a dead owner's lock out of the way, then remove it.
 *
 * The rename is the race-proof part: exactly one of two concurrent stealers
 * can rename a given inode, and a stealer that loses the rename finds nothing
 * at the lock path and stops. Unlinking a path both stealers could still see
 * is how a fresh lock gets deleted by a process that judged an OLD one stale.
 */
function stealStale(file: string): void {
  const moved = `${file}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(file, moved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: another stealer already moved it, which is the outcome we want.
    if (code !== "ENOENT")
      throw new LeanStateError(`cannot clear the stale lock ${file}: ${(err as Error).message}`);
    return;
  }
  try {
    unlinkSync(moved);
  } catch {
    /* a leftover `.stale-*` file is inert — nothing reads it, and it is named
     * for the pid that left it, so it is greppable when one wonders */
  }
}

/** The release closure: it may only ever delete the lock it wrote. */
function releaser(file: string, own: string): () => void {
  return () => {
    let current: string;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      return;
    }
    // A lock that now names somebody else was taken after ours went stale and
    // was cleared: deleting it would release a run that is not ours.
    if (current.trim() !== own.trim()) return;
    try {
      unlinkSync(file);
    } catch {
      /* best effort — a leftover lock ages out the moment this pid is gone */
    }
  };
}

/**
 * The pid a lock file names.
 *
 * Three answers, deliberately distinct: a number (a pid to judge), `undefined`
 * (no pid at all — nothing to judge, so nothing to steal) and `"unreadable"`
 * (the bytes are there but mean nothing, which is a different complaint an
 * operator should see verbatim).
 */
function readLockPid(file: string): number | "unreadable" | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return "unreadable";
  }
  const trimmed = raw.trim();
  if (trimmed === "") return "unreadable";
  const n = Number.parseInt(trimmed, 10);
  // `12abc` parses as 12 and would be judged as a pid; a body has to BE one.
  if (!/^\d+$/.test(trimmed)) return "unreadable";
  return Number.isInteger(n) && n > 0 ? n : "unreadable";
}
