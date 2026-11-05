/**
 * spawn-operator-config — restore the operator's global git and gh config if a
 * spawned child changed it.
 *
 * A child's bash is not read-only (AGENTS.md §3), and a redirect to an absolute
 * path is invisible to the bash write fence (`write-fence-deps.ts`): a reviewer
 * child replaced the operator's `~/.gitconfig` and created a per-user git config
 * with one `printf`, which took the host's HTTPS pushes down until a manual
 * restore. Relocating the child's HOME would not help — an absolute path defeats
 * it, and moving HOME/XDG breaks gh auth, Pi's agent dir, skills and the vipune
 * cache. So the four files that carry the operator's git identity and gh
 * credentials are snapshotted before the child spawns and verified when it ends:
 * any change is restored from the snapshot and reported. A child cannot leave
 * the operator's identity or credential helper altered.
 *
 * A restore never leaves the operator's bytes reachable through an entry the
 * child made — see `restoreOne`, whose two arms each refuse the way the child
 * could share them: the replace arm writes no entry it found (it unlinks the
 * symlink or unwritable file and creates a fresh regular file), and the in-place
 * arm refuses to open a link and refuses an entry another name already holds.
 * Without that, a child that swaps the protected path for a symlink of its own
 * — or hard-links it to a path of its own — keeps the credential file under its
 * control after a line that reads `— restored`.
 *
 * Git excludes/ignore files are deliberately not protected — they carry neither
 * identity nor credentials.
 *
 * Concurrency is accepted rather than prevented: two overlapping children share
 * one snapshot set, so whichever ends first restores the other's in-flight
 * bytes. That is why every line says "during the <role> run" and names the
 * path — the warn is the attribution, and it is disclosure only: `ok`,
 * `loopOutcome` and the adversarial/lens verdicts are untouched, since the
 * restore already happened. A legitimate operator edit made while a child runs
 * is reverted by the same rule; the line names the file.
 *
 * Reads are whole local config files (kilobytes), so no timeout machinery sits
 * on them. A read that fails for any reason other than ENOENT is reported once
 * as `cannot snapshot`, and a path with no baseline is never treated as a child
 * write — an unreadable file is never evidence of a change.
 *
 * The same unreadability has the opposite meaning AFTER the child: there the
 * baseline exists, so "I cannot read it" is "I cannot prove it is unchanged"
 * and the path gets the restore like any other change. A child's last act could
 * otherwise be `chmod 000` or `rm && mkdir` on the gh credential file and keep
 * its payload with no violation line anywhere. `undefined` therefore means two
 * different things on the two sides of the run, and the two sets keep them
 * apart: paths that could be read go into `snapshots` and are compared and
 * repaired, a path with no baseline never enters that set and is left alone.
 *
 * For a REVIEWER role the same window also lists the top level of `$HOME` before
 * and after the child and reports one line per NEW entry — a reviewer is the
 * child that probes hostile config, and the four protected files say nothing
 * about a name the child creates elsewhere under the operator's home (`~/.pi`,
 * `~/.cache`, a dotfile of its own). Listing is disclosure, never deletion: the
 * operator's own entries are not this guard's to remove, and a line naming a
 * leftover costs one read to act on.
 *
 * What the guard cannot catch: a write that lands after the child exits (a
 * detached grandchild), since one snapshot set belongs to one child. Group-kill
 * (`spawn-kill.ts`) is what reaps a lingering grandchild; that is a separate
 * mechanism from this restore.
 */

import type { Stats } from "node:fs";
import {
  constants,
  type FileHandle,
  access,
  lstat,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPlainObject } from "./plain-object.ts";
import { isReviewerRole } from "./review-bounds.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/** A process environment shaped enough to resolve the protected paths from. */
export type OperatorConfigEnv = Record<string, string | undefined>;

/**
 * One protected file that WAS readable before the child ran, and the bytes it
 * held (null = it did not exist). A path that could not be read is absent from
 * the set entirely: with no baseline there is nothing to restore and no
 * evidence of a change, which is the opposite of what an unreadable path means
 * once the child has run — see the module header.
 */
type Snapshot = { path: string; bytes: Buffer | null };

/** `${XDG_CONFIG_HOME:-$HOME/.config}` — the XDG base directory git and gh both honour. */
function configHome(env: OperatorConfigEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && path.isAbsolute(xdg)) return xdg;
  return path.join(homeDir(env), ".config");
}

/**
 * The operator's home, resolved from the live environment the way a shell does.
 * `os.homedir()` is the fallback only when HOME is absent or not absolute: Bun
 * snapshots HOME inside `os.homedir()` at process start, so a value read from
 * there is the home the process was launched with rather than the current one
 * (the same rule `write-fence-path.ts`'s `homeDir()` states).
 */
function homeDir(env: OperatorConfigEnv): string {
  const home = env.HOME;
  return home !== undefined && path.isAbsolute(home) ? home : os.homedir();
}

/** The config root gh resolves — gh's own documented order, not ours. */
function ghConfigDir(env: OperatorConfigEnv): string {
  const gh = env.GH_CONFIG_DIR;
  // Absolute-only, like every other resolver here: a relative `GH_CONFIG_DIR`
  // would protect paths under the CWD instead of the operator's gh config, so
  // the XDG default is used and the real files stay watched.
  if (gh !== undefined && gh !== "" && path.isAbsolute(gh)) return gh;
  return path.join(configHome(env), "gh");
}

/**
 * The files whose contents a child must not leave changed, resolved from `env`
 * at CALL time — never latched at module load, so a test (or a caller) that
 * points HOME / XDG_CONFIG_HOME / GH_CONFIG_DIR at a sentinel tree points the
 * guard there too.
 */
export function protectedPaths(env: OperatorConfigEnv = process.env): string[] {
  const gitHome = path.join(configHome(env), "git");
  const gh = ghConfigDir(env);
  return [
    path.join(homeDir(env), ".gitconfig"),
    path.join(gitHome, "config"),
    path.join(gh, "config.yml"),
    path.join(gh, "hosts.yml"),
  ];
}

/** Read one path: its bytes, null for absent, or undefined when it could not be read. */
async function readSnapshot(target: string): Promise<Buffer | null | undefined> {
  try {
    return await readFile(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Absent is a state the guard can put back by deleting; anything else is a
    // file the guard has no baseline for, so it must not become a "change".
    if (code === "ENOENT") return null;
    traceWarn(`operator-config: cannot snapshot ${target} (${code ?? "unknown"})`);
    return undefined;
  }
}

/**
 * The entry the in-place arm may write, or why it may not. `approved` is the
 * `lstat` the guard based its decision on, and it is the identity the open is
 * checked against afterwards — a fresh `lstat` inside the open would compare the
 * open against itself and prove nothing.
 *
 * Four shapes are refused, each because writing the inode would hand the
 * operator's bytes to a name the child holds:
 *
 * - NOT a regular file — `isFile()` on `lstat` keeps a symlink, a directory or
 *   any other non-regular entry out: those are replaced by ENTRY (unlink the
 *   link, create a fresh regular file), never written through.
 * - `nlink > 1` — a second name for the same inode. An in-place write changes
 *   the bytes seen through BOTH names, so a child that `ln`'d the credential
 *   file to its own path still reads the restored token from its own file after
 *   a `— restored` line. The replace arm breaks the share: `rm` drops this one
 *   link and `open("wx")` creates an inode nothing else names.
 * - Not owned by the guard's own uid — a file the child re-`chown`ed is one the
 *   guard cannot `chmod` back either, so it goes through unlink-and-create
 *   (EACCES there is reported as `NOT restored`, not papered over).
 * - Not writable — `access(W_OK)` fails (a `chmod 000` file), and the replace
 *   arm is also the arm that fixes the mode.
 *
 * An ABSENT path is approved with no identity to match: it needs no unlink
 * either, so it belongs to this arm rather than the one that has to `rm` first,
 * and `open(..., O_CREAT)` is what creates it. A symlink created in the window
 * between this check and the open is not this predicate's to close — the open
 * itself refuses to follow it (`__openInPlaceForTest`).
 *
 * The in-place arm exists because unlinking needs write permission on the
 * PARENT, which a child that left its directory `0555` does not grant. Never
 * throws: an unreadable directory is simply not in-place writable and falls to
 * the replace arm, which reports its EACCES.
 */
async function inPlaceApproval(target: string): Promise<Stats | "replace" | "absent"> {
  let st: Stats;
  try {
    st = await lstat(target);
  } catch (err) {
    // An absent path is the third shape this arm handles; anything the guard
    // cannot even stat goes to the arm that reports its own errno.
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "replace";
  }
  if (!st.isFile()) return "replace";
  if (st.nlink > 1) return "replace";
  if (process.getuid !== undefined && st.uid !== process.getuid()) return "replace";
  try {
    await access(target, constants.W_OK);
  } catch {
    return "replace";
  }
  return st;
}

/**
 * Put one path back. Two shapes, chosen by what the guard can actually DO to
 * the entry it finds:
 *
 * - A regular, singly-linked file the guard can OPEN FOR WRITE is restored IN
 *   PLACE: the existing inode is truncated and written. Unlinking first needs
 *   write permission on the PARENT, which a child that ran `chmod 555` on the
 *   directory does not leave — an unlink-first restore fails EACCES there and
 *   the child's payload survives under a line that says `— restored`. The
 *   in-place write needs only the file's own write bit, so the child cannot
 *   defend against it without also dropping that bit, and a file it made
 *   unwritable falls to the other arm instead. The open carries `O_NOFOLLOW`,
 *   so a symlink put at the path after the check is refused (`ELOOP`) rather
 *   than written through, and the bytes already sit in a single-inode file that
 *   no other name shares — `O_TRUNC` is safe only because `nlink > 1` was
 *   refused above.
 * - Anything else — a non-regular entry (symlink, directory), a file with a
 *   second name (`nlink > 1`), or a file the child made unwritable or
 *   re-`chown`ed — is replaced by ENTRY: `rm` unlinks a symlink rather than its
 *   target and `open(..., "wx")` creates a fresh regular
 *   file instead of following a link the child planted, so the operator's file
 *   ends up one the child does not already own. Writing through a symlink would
 *   put the token in the child's own file. An entry the guard can neither write
 *   in place nor unlink (a child-owned file in a `0555` directory) is what
 *   `NOT restored` names.
 *
 * Mode is set explicitly to 0600 either way: `hosts.yml` holds the gh token,
 * a plain write keeps whatever mode the child loosened, and `wx` bypasses umask.
 *
 * A snapshot was read with `readFile`, so it followed any pre-existing link at
 * snapshot time and its bytes are the target's own: writing them back as a
 * regular file is the faithful restore, not a new behaviour.
 */
async function restoreOne(target: string, bytes: Buffer | null): Promise<string | undefined> {
  if (bytes !== null) {
    const approved = await inPlaceApproval(target);
    if (
      approved !== "replace" &&
      (await __openInPlaceForTest(target, bytes, approved)) === "open"
    ) {
      return undefined;
    }
  }
  try {
    await rm(target, { force: true, recursive: true });
    if (bytes === null) return undefined;
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "unknown";
  }
}

/**
 * The in-place open, on its own, so the suite can drive a link into it.
 *
 * Three things have to agree for this arm to be safe, and one of them is only
 * knowable AFTER the open: `open()` re-resolves the path, so a symlink the child
 * put at the target in the window since the check would receive the operator's
 * bytes, an entry the child replaced with a fresh inode would be truncated and
 * written under a name the check never saw, and a hard link raced in after the
 * check shares the very inode the check approved — so identity matches and only
 * the link count gives it away. So: open with `O_NOFOLLOW` (a link is `ELOOP`,
 * never a write-through), then compare `handle.stat()`'s `dev`/`ino` with the
 * `lstat` the caller's predicate settled on — what the
 * handle points at must be the very inode that predicate approved. Comparing
 * against a stat taken here instead would only ever agree with itself. The
 * `nlink` half of that verdict applies whichever identity was approved: a second
 * name for the approved inode shares the bytes an in-place write is about to
 * change, and the identity comparison cannot see it. Any disagreement, and any
 * error from the open, returns "replace": the caller falls
 * to the arm that unlinks the entry it found and creates a fresh file, which is
 * always safe and reports honestly.
 *
 * Exported for the symlink and swap cases of the entry-hardening and read-back
 * suites, which need a link or a fresh inode at the target at the moment of the
 * open; `testOnly` in the seams registry, and `restoreOne` is its only
 * production caller. `approved` is the identity the predicate settled on.
 */
export async function __openInPlaceForTest(
  target: string,
  bytes: Buffer,
  approved: Stats | "absent",
): Promise<"open" | "replace"> {
  let handle: FileHandle;
  try {
    // No `O_TRUNC`: the handle is opened, identified, and only then emptied. An
    // open that truncates on the way in destroys the child's bytes whatever the
    // identity check concludes, and a restore that ends up in the replace arm
    // has no reason to have deleted anything on its first attempt.
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    // A symlink at the path is ELOOP here, never a write-through.
    return "replace";
  }
  try {
    const post = await handle.stat();
    // The share is refused on BOTH arms. A second name raced in after the check
    // shares the inode the predicate approved, so the identity comparison alone
    // agrees with itself and the truncate writes the operator's bytes out under
    // the child's name; `nlink` is the only thing that sees it. For the absent
    // arm there is no identity to compare, so `nlink` is all there is.
    const leaky =
      post.nlink !== 1 ||
      (approved !== "absent" && (post.ino !== approved.ino || post.dev !== approved.dev));
    if (leaky) {
      return "replace";
    }
    await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    return "open";
  } catch {
    return "replace";
  } finally {
    await handle.close();
  }
}

/**
 * Did the entry change relative to the snapshot? `now === undefined` — the
 * post-child read failed — is a change: the baseline exists, so unreadable is
 * "cannot prove unchanged", not "unchanged". Paths that never had a baseline
 * never reach here (see the module header).
 */
function differsFrom(snap: Buffer | null, now: Buffer | null | undefined): boolean {
  if (now === undefined) return true;
  if (now === null) return snap !== null;
  return snap === null || !now.equals(snap);
}

/**
 * The `$HOME` before/after listing for a reviewer child, as one call made ONCE
 * before the child and once after it: the caller subtracts the two results, and
 * never deletes anything.
 *
 * `undefined` is the pre-run verdict "no baseline": an unreadable home is not
 * evidence of a child write, so a child that made entries in it is not accused —
 * the same rule `readSnapshot` applies to a protected file with no baseline.
 * `[]` means "the top level is unchanged", which is not a verdict at all.
 */
async function homeEntries(home: string): Promise<string[] | undefined> {
  try {
    return await readdir(home);
  } catch {
    return undefined;
  }
}

/** Why the listing of `$HOME` could not be taken, with the errno that says so. */
async function snapshotCode(home: string): Promise<string> {
  try {
    await readdir(home);
    return "unknown";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "unknown";
  }
}

/**
 * Run `runChild` with the operator's git/gh config guarded: snapshot the
 * protected files first, and in a `finally` — whatever ended the child, a
 * spawn throw, an abort, a cap kill — restore any file it changed and record a
 * line per change on the result as `operatorConfig`.
 *
 * The callback is invoked exactly once and never retried, so one snapshot set
 * belongs to one child. The result object is annotated in place (spawn builds
 * it fresh per dispatch, so nothing shares it); a callback whose value is not a
 * `DispatchResult` — the resume reattach returns its own shape — simply reports
 * its violations through the `traceWarn` channel, which is what that path
 * relies on since it builds no report to attach them to.
 *
 * A callback that THROWS has no value to annotate, so on that path the restore
 * still lands and only `traceWarn` carries the disclosure — `dispatch_parallel`
 * turns the throw into `{ failed: true, error }`, which is a shape with no
 * result to decorate (see async-jobs-batch-report.ts). The restore is the
 * protection; the report line is the record, and a thrown child's record lives
 * on the trace.
 */
export async function withOperatorConfigGuard<R>(
  role: string,
  runChild: () => Promise<R>,
): Promise<R> {
  const snapshots: Snapshot[] = [];
  for (const target of protectedPaths()) {
    const bytes = await readSnapshot(target);
    if (bytes !== undefined) snapshots.push({ path: target, bytes });
  }
  // The listing is gated on the SAME predicate the reviewer bounds use, so a
  // role can never be half-covered by a second hand-kept list.
  const homeBaseline = isReviewerRole(role) ? await homeEntries(homeDir(process.env)) : undefined;
  let result: R | null = null;
  try {
    result = await runChild();
    return result;
  } finally {
    const violations: string[] = [];
    for (const snap of snapshots) {
      // A baseline exists for every entry in `snapshots`, so a failed read here
      // is a violation to repair rather than a path to leave alone.
      if (!differsFrom(snap.bytes, await readSnapshot(snap.path))) continue;
      const code = await restoreOne(snap.path, snap.bytes);
      violations.push(
        code === undefined
          ? `operator-config: ${snap.path} modified during the ${role} run — restored`
          : `operator-config: ${snap.path} modified during the ${role} run — NOT restored (${code})`,
      );
    }
    // The $HOME disclosure, in the same channel and the same array as the
    // restore lines. A baseline that was never taken is not a child write: one
    // line says why, and no entry is named.
    let homeLines: string[] = [];
    if (homeBaseline !== undefined) {
      const after = await homeEntries(homeDir(process.env));
      if (after === undefined) {
        // There "cannot read" means "cannot prove unchanged" — a fact about the
        // home, not attributable to any entry the child made.
        const code = await snapshotCode(homeDir(process.env));
        homeLines = [`operator-config: could not re-read $HOME (${code})`];
      } else {
        const had = new Set(homeBaseline);
        homeLines = after
          .filter((name) => !had.has(name))
          .map((name) => `${name} created in $HOME during the ${role} run`);
      }
    } else if (isReviewerRole(role)) {
      homeLines = [
        `operator-config: could not snapshot $HOME (${await snapshotCode(homeDir(process.env))})`,
      ];
    }
    for (const line of violations) traceWarn(line);
    for (const line of homeLines) traceWarn(line);
    // Disclosure, never a verdict: `ok` and `loopOutcome` are left exactly as
    // the child's own run set them. When `result` is null the callback threw and
    // there is nothing to annotate — the traceWarn above is the only record.
    const lines = [...violations, ...homeLines];
    if (lines.length > 0 && result !== null && isDispatchResult(result)) {
      result.operatorConfig = lines;
    }
  }
}

/**
 * Only a plain object the caller built can be annotated. `isPlainObject` is the
 * repo's single "can this value BE a record" test (plain-object.ts): the fields
 * are checked as own values, so a value carrying `ok`/`text` on its prototype
 * chain — or one this wrapper must not gain a field on — is not annotated.
 */
function isDispatchResult(value: unknown): value is DispatchResult {
  return isPlainObject(value) && "ok" in value && "text" in value;
}
