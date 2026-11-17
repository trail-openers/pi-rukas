/**
 * lean/lock — one run per issue.
 *
 * The engine has no other concurrency control, and the absence is not theoretical: two `runLean` calls on one
 * issue started together both drove the whole table, both ran `land`, and the second merge happened anyway. The
 * step log makes a *resumed* run safe; nothing makes a *concurrent* one safe.
 *
 * The lock is `<repoRoot>/.pi/lean-state/<issue>.lock`, taken ATOMICALLY WITH ITS OWNER INSIDE: bytes go to a
 * unique temp file in the same directory and are then `link`ed into place, so the moment the lock exists it
 * names the process that created it.
 *
 * The rename is what stealing is for: a stale lock is first renamed to a unique `<lock>.stale-<pid>-<rand>` and
 * only then unlinked, so two stealers that both judged it dead cannot both delete a fresh lock one created.
 *
 * An unparseable or empty lock is NEVER stolen. Only a body parsing as an OWNER IDENTITY (`<host> <pidns>
 * <pid> <starttime>`) whose process `judgeOwner` proves dead may be removed — a lock whose owner cannot be
 * identified is somebody's run. The body is an identity rather than a bare pid for the reason
 * `process-liveness.ts` gives: a pid in a namespace this process cannot see into proves nothing either way.
 */

import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatIdentity, judgeOwner, parseIdentity, selfIdentity } from "../process-liveness.ts";
import { leanLockFile } from "./state.ts";

/**
 * The lock refusing to be taken.
 *
 * A TYPE, not a message: the headless `work-lean` verb must tell "a live run already holds this issue" (exit
 * 40) from "the engine blew up" (exit 30). EVERY refusal `acquireLock` raises is one of these.
 */
export class LeanLockError extends Error {
  override readonly name = "LeanLockError";
}

/**
 * Take the per-issue lock, or refuse. Returns the release function; the caller MUST call it in a `finally` so a
 * throw mid-drive does not wedge the issue for every later run.
 */
export function acquireLock(repoRoot: string, issue: number): () => void {
  const file = leanLockFile(repoRoot, issue);
  mkdirSync(dirname(file), { recursive: true });
  const own = formatIdentity(selfIdentity());
  // One attempt, then one more after a stale sweep — a second EEXIST means somebody took it in between.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryLink(file, own)) return releaser(file, own);
    const body = readLockBody(file);
    if (body === "unreadable") throw new LeanLockError(`lock unreadable: ${file}`);
    if (body !== undefined) {
      // Only a holder this process can PROVE dead may be cleared: `alive`, `foreign` and an unparseable body
      // all mean "somebody's run I cannot judge", so refuse.
      if (judgeOwner(parseIdentity(body), selfIdentity()) !== "dead")
        throw new LeanLockError(`run already in progress (${body}) for issue ${issue}`);
      stealStale(file);
    } else {
      // The path is there but unreadable — a permission or I/O problem, not a stale run.
      throw new LeanLockError(`lock unreadable: ${file}`);
    }
  }
  const racer = readLockBody(file);
  throw new LeanLockError(
    `run already in progress${racer !== undefined && racer !== "unreadable" ? ` (${racer})` : ""} for issue ${issue}`,
  );
}

/**
 * Link a pid-bearing temp file into the lock path. True means we hold it.
 *
 * `link` fails with EEXIST when the target exists; every other errno is a real error, reported as one.
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
      throw new LeanLockError(`cannot lock ${file}: ${(err as Error).message}`);
    }
  } finally {
    // Only ever our own file at a path we generated; the lock, if present, is a separate directory entry this
    // unlink cannot touch.
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean; the outcome above already says what happened */
    }
  }
}

/**
 * Move a dead owner's lock out of the way, then remove it. The rename is the race-proof part: exactly one of
 * two concurrent stealers renames a given inode, and the loser finds nothing at the lock path and stops.
 */
function stealStale(file: string): void {
  const moved = `${file}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(file, moved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: another stealer already moved it — the outcome we want.
    if (code !== "ENOENT")
      throw new LeanLockError(`cannot clear the stale lock ${file}: ${(err as Error).message}`);
    return;
  }
  try {
    unlinkSync(moved);
  } catch {
    /* a leftover `.stale-*` file is inert — nothing reads it */
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
    // "Still us", not "still this pid" — a recycled pid is what the identity's start time tells apart, and
    // deleting a lock that now names somebody else would release a run that is not ours. Compared against the
    // very bytes we linked.
    if (current.trim() !== own.trim()) return;
    try {
      unlinkSync(file);
    } catch {
      /* best effort — a leftover lock ages out the moment this pid is gone */
    }
  };
}

/**
 * The lock's body verbatim. Two deliberately distinct answers: the trimmed bytes, and `"unreadable"` (path
 * exists but its bytes cannot be read, or are empty). No judgement here.
 */
function readLockBody(file: string): string | "unreadable" | undefined {
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
  return trimmed;
}
