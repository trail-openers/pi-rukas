/**
 * lean/lock — one run per issue.
 *
 * The engine has no other concurrency control, and the absence is not
 * theoretical: two `runLean` calls on one issue started together both drove
 * the whole table, both ran `land`, and the second merge happened anyway. The
 * step log makes a *resumed* run safe; nothing makes a *concurrent* one safe,
 * because both processes read the same file before either wrote it.
 *
 * The lock is `<repoRoot>/.pi/lean-state/<issue>.lock` and it is taken
 * ATOMICALLY WITH ITS OWNER INSIDE: the bytes are written to a unique temp
 * file in the same directory and then `link`ed into place, so the moment the
 * lock exists it names the pid that created it. The old shape — `open(O_EXCL)`
 * and then `write` the pid — had a window in which a concurrent reader saw a
 * lock with NO pid in it and called it unreadable.
 *
 * Stealing is what the rename is for. A stale lock is first renamed to a
 * unique `<lock>.stale-<pid>-<rand>` and only then unlinked: two stealers that
 * both decided the lock was dead cannot both delete a fresh lock one of them
 * just created, because whichever renamed first has moved the file the second
 * one goes looking for.
 *
 * An unparseable or empty lock is NEVER stolen. Only a body that parses as an
 * OWNER IDENTITY (`<host> <pidns> <pid> <starttime>`) and whose process
 * `judgeOwner` can prove dead may be removed — a lock whose owner this process
 * cannot identify is somebody's run, and refusing is cheaper than double-driving
 * a merge.
 *
 * The body is an identity rather than a bare pid for the reason
 * `process-liveness.ts` gives: a pid read in a pid namespace this process
 * cannot see into proves nothing either way. The policy is the one
 * `host-spawn-slots.ts` applies to slot files.
 */

import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatIdentity, judgeOwner, parseIdentity, selfIdentity } from "../process-liveness.ts";
import { leanLockFile } from "./state.ts";

/**
 * The lock refusing to be taken.
 *
 * A TYPE and not a message: the headless `work-lean` verb has to tell "a live
 * run already holds this issue" (exit 40 — re-running now only collides again)
 * from "the engine blew up" (exit 30). Reading that distinction out of prose
 * left the verb matching a regex over somebody else's words.
 *
 * EVERY refusal `acquireLock` raises is one of these. A plain `LeanStateError`
 * is therefore NOT a refusal, which is what lets the verb map a schema
 * violation to 30 while this maps to 40.
 */
export class LeanLockError extends Error {
  override readonly name = "LeanLockError";
}

/**
 * Take the per-issue lock, or refuse. Returns the release function; the
 * caller MUST call it in a `finally` so a throw mid-drive does not wedge the
 * issue for every later run.
 */
export function acquireLock(repoRoot: string, issue: number): () => void {
  const file = leanLockFile(repoRoot, issue);
  mkdirSync(dirname(file), { recursive: true });
  const own = formatIdentity(selfIdentity());
  // One attempt, then one more after a stale sweep; a second EEXIST means
  // somebody took the lock between the check and here.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryLink(file, own)) return releaser(file, own);
    const body = readLockBody(file);
    if (body === "unreadable") throw new LeanLockError(`lock unreadable: ${file}`);
    if (body !== undefined) {
      // Only a holder this process can PROVE dead may be cleared: `alive`,
      // `foreign` and an unparseable body all mean "somebody's run I cannot
      // judge", and the safe answer is to refuse rather than drive twice.
      if (judgeOwner(parseIdentity(body), selfIdentity()) !== "dead")
        throw new LeanLockError(`run already in progress (${body}) for issue ${issue}`);
      stealStale(file);
    } else {
      // The path is there but cannot be read at all — a permission or I/O problem,
      // not a stale run.
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
 * `link` fails with EEXIST when the target exists; every other errno is a real
 * error and is reported as one. The temp file is the caller's own (unique name,
 * in the same directory so the link never crosses a filesystem).
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
    // Only ever our own file at a path we generated; the lock, if it exists, is a
    // separate directory entry that this unlink cannot touch.
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
      throw new LeanLockError(`cannot clear the stale lock ${file}: ${(err as Error).message}`);
    return;
  }
  try {
    unlinkSync(moved);
  } catch {
    /* a leftover `.stale-*` file is inert — nothing reads it, and it is named for
     * the pid that left it */
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
    // A lock that now names somebody else was taken after ours went stale and was
    // cleared: deleting it would release a run that is not ours. Compared against the
    // very bytes we linked, so the rule is "still us" and not "still this pid".
    if (current.trim() !== own.trim()) return;
    try {
      unlinkSync(file);
    } catch {
      /* best effort — a leftover lock ages out the moment this pid is gone */
    }
  };
}

/**
 * The lock's body, verbatim.
 *
 * Two answers, deliberately distinct: the trimmed bytes (an identity for
 * `judgeOwner` to pronounce on) and `"unreadable"` (the path exists but its
 * bytes cannot be read or are empty — a different complaint an operator should
 * see verbatim). No judgement happens here.
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
