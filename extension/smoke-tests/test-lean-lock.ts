#!/usr/bin/env bun
/**
 * lean/lock — one run per issue, judged on the bytes of the lock file.
 *
 * `runLean` takes this lock for its whole life, and `test-lean-engine-resume.ts`
 * covers the two shapes that show up in a drive (a live owner refuses, a dead
 * one is swept). What those cases cannot see is the machinery underneath: they
 * both go through the engine, so a bug in the engine's own bookkeeping — never
 * calling `release`, or releasing the wrong file — looks identical to a bug in
 * the lock. These cases call `acquireLock` directly and assert on what is on
 * disk, which is the only thing a second process reads.
 *
 * The three properties worth pinning, each the reason the module is written
 * the way it is:
 *
 *   - the lock names its owner the instant it exists (temp file + `link`, not
 *     `O_EXCL` then `write`), so a refusal can name the pid and a reader never
 *     sees a lock with nobody in it;
 *   - an empty lock is somebody's run — the shape the old
 *     `open(O_EXCL)`-then-`write` left in the window between its two calls —
 *     and an owner this process cannot identify is refused, never swept;
 *   - `release` deletes what it wrote and nothing else, so a lock that was
 *     taken over while ours went stale survives its own releaser.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { acquireLock } from "../src/lean/lock.ts";
import { leanLockFile } from "../src/lean/state.ts";
import { formatIdentity, selfIdentity } from "../src/process-liveness.ts";
import { makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/**
 * A pid the kernel cannot hand out, so `processAlive` — and with it
 * `judgeOwner` — says dead on every OS.
 */
const DEAD_PID = 4294967200;

/** The identity this process writes into a lock it takes. */
const OWN = formatIdentity(selfIdentity());

/** An identity on this host, in this pid namespace, with a pid nothing owns. */
function deadIdentity(): string {
  const self = selfIdentity();
  return formatIdentity({ ...self, pid: DEAD_PID, startTime: "1" });
}

/** An identity on another host — a pid this process cannot probe either way. */
function foreignIdentity(): string {
  const self = selfIdentity();
  return formatIdentity({ ...self, host: "another-host", pid: process.pid });
}

/** A body in the OLD pid-only format — not an identity, so not judgeable. */
function legacyPidBody(): string {
  return `${process.pid}\n`;
}

/** The refusal thrown by a second acquire, or `undefined` when it succeeded. */
function acquireThrows(dir: string, issue: number): Error | undefined {
  try {
    acquireLock(dir, issue)();
    return undefined;
  } catch (err) {
    return err as Error;
  }
}

// ── a double acquire refuses, and names the owner ─────────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 60;
    const release = acquireLock(dir, issue);
    const second = acquireThrows(dir, issue);
    assert(
      second instanceof Error && second.name === "LeanLockError",
      `the second acquire is refused (got ${String(second)})`,
    );
    assert(
      /run already in progress/.test(second?.message ?? ""),
      `the refusal says what it is (got ${second?.message})`,
    );
    assert(
      (second?.message ?? "").includes(OWN),
      `the refusal names the owner's identity (got ${second?.message})`,
    );
    assert(
      (second?.message ?? "").includes(`issue ${issue}`),
      `the refusal names the issue (got ${second?.message})`,
    );
    // The holder is still the holder: a refused reader must not disturb it.
    assert(
      readFileSync(leanLockFile(dir, issue), "utf8").trim() === OWN,
      "the refused acquire leaves the live lock owned by its holder",
    );
    release();
    assert(
      acquireThrows(dir, issue) === undefined,
      "releasing our own identity's lock frees the issue for the next acquire",
    );
  } finally {
    cleanup();
  }
}

// ── a dead owner's lock is reclaimed, a foreign one is refused ─────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 61;
    mkdirSync(`${dir}/.pi/lean-state`, { recursive: true });
    // Same host, same pid namespace, a pid nothing owns: the bytes a killed
    // drive leaves, and the only body this process may call dead.
    writeFileSync(leanLockFile(dir, issue), `${deadIdentity()}\n`, "utf8");
    let thrown: Error | undefined;
    let release: (() => void) | undefined;
    try {
      release = acquireLock(dir, issue);
    } catch (err) {
      thrown = err as Error;
    }
    assert(
      thrown === undefined,
      `a lock whose identity is on this host with a dead pid is reclaimed rather than refused (got ${String(thrown)})`,
    );
    assert(
      readFileSync(leanLockFile(dir, issue), "utf8").trim() === OWN,
      "the reclaimed lock now names the new holder",
    );
    release?.();
    assert(
      (() => {
        try {
          readFileSync(leanLockFile(dir, issue), "utf8");
          return false;
        } catch {
          return true;
        }
      })(),
      "and releasing removes it, so the issue is not wedged",
    );
  } finally {
    cleanup();
  }
}

{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 64;
    mkdirSync(`${dir}/.pi/lean-state`, { recursive: true });
    // A holder on another host — a sibling container, or another machine on a
    // shared checkout. Its pid means nothing here, so `judgeOwner` says
    // `foreign` and the lock is somebody's run: refuse, never steal.
    const foreign = foreignIdentity();
    writeFileSync(leanLockFile(dir, issue), `${foreign}\n`, "utf8");
    const thrown = acquireThrows(dir, issue);
    assert(
      thrown !== undefined && /run already in progress/.test(thrown?.message ?? ""),
      `a foreign identity is refused, not stolen (got ${String(thrown)})`,
    );
    assert(
      (thrown?.message ?? "").includes(foreign),
      `the refusal names the foreign holder (got ${thrown?.message})`,
    );
    assert(
      readFileSync(leanLockFile(dir, issue), "utf8").trim() === foreign,
      "a refused foreign lock survives the attempt exactly as it was",
    );
  } finally {
    cleanup();
  }
}

{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 65;
    mkdirSync(`${dir}/.pi/lean-state`, { recursive: true });
    // The shape a lock written before the identity format carried. `parseIdentity`
    // answers undefined for it, `judgeOwner` answers `foreign` for that, and the
    // rule is the same as for any owner this process cannot judge: refuse.
    writeFileSync(leanLockFile(dir, issue), legacyPidBody(), "utf8");
    const thrown = acquireThrows(dir, issue);
    assert(
      thrown !== undefined && /run already in progress/.test(thrown?.message ?? ""),
      `a bare pid body is refused as unreadable rather than swept (got ${String(thrown)})`,
    );
    assert(
      readFileSync(leanLockFile(dir, issue), "utf8") === legacyPidBody(),
      "refusing leaves the unparseable lock exactly where it was",
    );
  } finally {
    cleanup();
  }
}

// ── an empty lock is refused, not stolen ───────────────────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 62;
    mkdirSync(`${dir}/.pi/lean-state`, { recursive: true });
    // The shape the old `O_EXCL`-then-`write` left in its window — a lock with
    // no owner in it. Judging that dead would let a reader delete a lock a run
    // is in the middle of taking.
    writeFileSync(leanLockFile(dir, issue), "", "utf8");
    const thrown = acquireThrows(dir, issue);
    assert(
      thrown !== undefined && /unreadable/.test(thrown?.message ?? ""),
      `an empty lock is refused as unreadable, never swept (got ${String(thrown)})`,
    );
    assert(
      readFileSync(leanLockFile(dir, issue), "utf8") === "",
      "refusing leaves the unreadable lock exactly where it was",
    );
    // A body that is neither an identity nor a pid is the same complaint.
    writeFileSync(leanLockFile(dir, issue), "not-an-identity\n", "utf8");
    const garbage = acquireThrows(dir, issue);
    assert(
      garbage !== undefined && /run already in progress/.test(garbage?.message ?? ""),
      `a lock whose body is not an identity is refused too (got ${String(garbage)})`,
    );
  } finally {
    cleanup();
  }
}

// ── release never touches a lock that names somebody else ─────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 63;
    const release = acquireLock(dir, issue);
    // What a takeover looks like after ours aged out: the path now holds
    // another identity. Deleting it would release a run that is not ours.
    const other = deadIdentity();
    writeFileSync(leanLockFile(dir, issue), `${other}\n`, "utf8");
    release();
    assert(
      readFileSync(leanLockFile(dir, issue), "utf8").trim() === other,
      "releasing after a takeover leaves the other holder's lock alone",
    );
    // And a lock that has gone entirely is not an error — the release closure
    // is best-effort, because it runs in a `finally` on a path that may have
    // already failed.
    const releaseAgain = acquireThrows(dir, issue);
    assert(
      releaseAgain === undefined,
      `the other holder being DEAD makes the lock reclaimable (got ${String(releaseAgain)})`,
    );
  } finally {
    cleanup();
  }
}

// ── two issues, two locks ──────────────────────────────────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const hold = acquireLock(dir, 70);
    const other = acquireThrows(dir, 71);
    assert(other === undefined, `one issue's lock never blocks another's (got ${String(other)})`);
    hold();
  } finally {
    cleanup();
  }
}

process.exit(failures());
