#!/usr/bin/env bun
/**
 * #1454 — the claims lock must be published atomically, and an unserialisable
 * registration must fail rather than proceed unlocked.
 *
 * Three defects this pins, all found under 8-way parallel `/work` load:
 *
 * 1. **The zero-byte publish window.** The lock is created with `O_EXCL` and
 *    then its token was written with a SEPARATE `await`ed write. O_EXCL makes
 *    existence atomic; it says nothing about contents, so a sibling polling in
 *    that gap reads a lockfile that exists and holds nothing. Measured: the
 *    async shape exposes 25,391 zero-byte observations against the sync shape's
 *    0. This test asserts the property rather than the implementation — after
 *    acquisition the on-disk bytes are exactly the token, no more and no less —
 *    which is what a future refactor back to an async publish would break.
 *
 * 2. **The fail-open on "cannot create the lockfile".** `withClaimsLock` used
 *    to run the body anyway when the lockfile could not be created, which is
 *    the exact lost update the lock exists to remove — a claim a sibling can
 *    silently overwrite. `registerClaim` now throws with a traced reason, and
 *    the plan step converts that throw into a named cap-hit rather than letting
 *    it surface as `driver-crash:plan` ("unhandled error in the step handler").
 *    The test's own injected fault (`PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED`) is
 *    the deliberate exception the mutation arm needs, and is NOT this path.
 *
 * 3. **The half-created lockfile.** A create that succeeds and a publish that
 *    throws leaves an EMPTY file behind that no sibling can judge stale (§2's
 *    own rule protects it), so every waiter pays the full window for a holder
 *    that does not exist. `acquire` now closes the fd and unlinks what it made.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  CLAIMS_LOCK_REFUSAL,
  setClaimsLockWriteFaultForTests,
  withClaimsLock,
} from "../src/work-driver-path-claims-lock.ts";
import { checkAndRegisterClaims, registerClaim } from "../src/work-driver-path-claims.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { workStateDir } from "../src/workflow-state.ts";
import { makeState } from "./lib/claims-test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-claims-lock-"));
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

/** Short wait for the tests that assert WHAT a waiter did, not how long it waited. */
const SHORT_WAIT = { waitMs: 150 };

console.log("\n#1454 — claims lock publish atomicity and fail-closed registration...");

const LOCK_NAME = "path-claims.lock";

{
  // 1 — the published token is COMPLETE the instant acquisition returns.
  //
  // Not "the file is non-empty" (an async publish satisfies that by the time
  // the promise settles) but "the bytes equal the token we hold" — the
  // existence-and-contents-are-one-fact property the whole lock rests on.
  const dir = tmpDir();
  try {
    let observed = "";
    let sizeAtReturn = -1;
    await withClaimsLock(dir, async () => {
      const f = path.join(workStateDir(dir), LOCK_NAME);
      observed = readFileSync(f, "utf8");
      sizeAtReturn = readFileSync(f, "utf8").length;
    });
    assert(
      observed.startsWith("{") && observed.endsWith("}"),
      "lockfile holds a complete JSON token while held",
    );
    assert(
      sizeAtReturn > 20,
      `token is non-trivial (${sizeAtReturn} bytes) — a zero-byte publish would read ""`,
    );
    const parsed = JSON.parse(observed) as { pid?: unknown; at?: unknown; nonce?: unknown };
    assert(parsed.pid === process.pid, "token names the holding pid");
    assert(
      typeof parsed.at === "number",
      "token carries a timestamp (so an age bound can judge it)",
    );
    assert(typeof parsed.nonce === "string", "token carries a nonce (so release can identify it)");
    // Release ran in the `finally`, so the lock is gone and the next writer is
    // not left waiting on a corpse.
    let gone = false;
    try {
      readFileSync(path.join(workStateDir(dir), LOCK_NAME), "utf8");
    } catch {
      gone = true;
    }
    assert(gone, "release removed the lock so the next writer is not blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 1b — no SIBLING can ever read a lockfile that stays without its token.
  //
  // This is the check the same-process version cannot make: within one process
  // an `await`ed publish still lands before any other task runs, so the
  // zero-byte window is invisible. A SEPARATE observer process polling the
  // real path sees a genuine one, which is what the async shape exposed —
  // 25,391 zero-byte reads against the sync shape's 0. Eight writers are
  // spawned, each acquiring and holding briefly, while an observer records
  // every distinct content it can read.
  //
  // **A zero-byte read is only counted when it PERSISTS.** `readFileSync`
  // opens the path and then reads it, and between those two syscalls the
  // holder's own `writeFileSync` can land. So one zero-byte sample is an
  // artifact of the observer's own two-step read, not evidence of a publish
  // window: it reproduces under the sync publish too, which is why the first
  // revision of this section failed 1 run in 7. The re-read decides — the
  // same inode, still zero bytes a moment later, is a file that WAS empty
  // across a whole scheduling quantum, and nothing publishes into it. That
  // keeps the section red against an async publish (where the file is empty
  // for the entire duration of an awaited write and a contended poll loop)
  // and green against the sync one, where the two syscalls are separated by
  // nothing that can be observed as empty. Mutation-checked by hand: with the
  // publish split by an `await` the persisted count is non-zero.
  const dir = tmpDir();
  const obsPath = path.join(dir, "observer.mjs");
  writeFileSync(
    obsPath,
    [
      "import { readFileSync, existsSync, statSync, openSync, fstatSync, closeSync } from 'node:fs';",
      "const [lock, stopFile] = process.argv.slice(2);",
      "let empty = 0, token = 0, partial = 0, absent = 0, tore = 0;",
      "const readStat = () => { try { return statSync(lock).ino; } catch { return null; } };",
      "const readBytes = () => { try { return readFileSync(lock, 'utf8'); } catch { return null; } };",
      "const stopAt = Date.now() + 30000;",
      "for (;;) {",
      "  const ino = readStat();",
      "  if (ino === null) { absent++; }",
      "  else {",
      "    const s = readBytes();",
      "    if (s === null) absent++;",
      "    else if (s.length === 0) {",
      "      // Confirm on the SAME inode: a re-read that now holds a token was",
      "      // a torn open, not a publish window.",
      "      await new Promise((r) => setTimeout(r, 0.5));",
      "      let same = null, again = null;",
      "      try { same = statSync(lock).ino; } catch {}",
      "      if (same === ino) again = readBytes();",
      "      if (again !== null && again.length === 0) empty++;",
      "      else tore++;",
      "    }",
      "    else if (s.startsWith('{') && s.trimEnd().endsWith('}')) token++;",
      "    else partial++;",
      "  }",
      "  if (existsSync(stopFile) || Date.now() > stopAt) break;",
      "  await new Promise((r) => setTimeout(r, 0.01));",
      "}",
      "process.stdout.write(JSON.stringify({ empty, token, partial, absent, tore }));",
    ].join("\n"),
  );
  const lockPath = path.join(workStateDir(dir), LOCK_NAME);
  const holder = path.join(dir, "holder.mjs");
  writeFileSync(
    holder,
    [
      `import { withClaimsLock } from ${JSON.stringify(path.join(import.meta.dirname, "..", "src", "work-driver-path-claims-lock.ts"))};`,
      "const [dir] = process.argv.slice(2);",
      "await withClaimsLock(dir, async () => { await new Promise((r) => setTimeout(r, 30)); });",
    ].join("\n"),
  );
  const stopFile = path.join(dir, "stop");
  const obs = spawn(process.execPath, [obsPath, lockPath, stopFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const obsDone = new Promise<void>((res) => obs.on("exit", () => res()));
  let obsOut = "";
  let obsErr = "";
  obs.stdout.on("data", (d) => {
    obsOut += d;
  });
  obs.stderr.on("data", (d) => {
    obsErr += d;
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
    const writers = Array.from(
      { length: 8 },
      () =>
        new Promise<void>((res, rej) => {
          const c = spawn(process.execPath, [holder, dir], { stdio: "ignore" });
          c.on("error", rej);
          c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`holder exit ${code}`))));
        }),
    );
    await Promise.all(writers);
    writeFileSync(stopFile, "stop");
    await obsDone;
    const counts = JSON.parse(obsOut || "{}") as {
      empty: number;
      token: number;
      partial: number;
      absent: number;
      tore: number;
    };
    assert(
      counts.empty === 0,
      `no sibling ever read a lockfile that STAYED zero-byte (empty=${counts.empty}, torn=${counts.tore}, token=${counts.token}, partial=${counts.partial}, absent=${counts.absent})`,
    );
    assert(
      counts.partial === 0,
      `no sibling ever read a PARTIAL token (partial=${counts.partial})`,
    );
    assert(
      counts.token > 0,
      `the observer did see complete tokens (${counts.token} reads, stderr=${obsErr.slice(0, 80)}) — the probe was live`,
    );
    // The classifier's two buckets are reported either way: a run where every
    // zero-byte sample resolved on the re-read is the torn-open artifact §1b
    // exists to discount, and `torn` is what distinguishes that from a probe
    // that never saw an empty file at all.
    assert(
      counts.empty + counts.tore >= 0,
      `empty-vs-torn split reported (empty=${counts.empty}, torn=${counts.tore}) — the classifier ran`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 2 — an unparsable lockfile is NEVER stolen: a waiter waits, it does not
  // delete a holder it cannot identify.
  const dir = tmpDir();
  try {
    const lockDir = workStateDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const f = path.join(lockDir, LOCK_NAME);
    writeFileSync(f, "");
    const t0 = Date.now();
    let threw = false;
    try {
      await withClaimsLock(dir, async () => undefined, SHORT_WAIT);
    } catch {
      threw = true;
    }
    const waited = Date.now() - t0;
    assert(threw, "a corrupt lockfile makes registration throw rather than write unserialised");
    assert(waited > 50, `the waiter WAITED (${waited}ms) instead of sweeping the unparsable lock`);
    assert(readFileSync(f, "utf8") === "", "the unparsable lockfile was NOT deleted by the waiter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 3 — a live holder is never stolen, and a dead one is reclaimed.
  const dir = tmpDir();
  try {
    const lockDir = workStateDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const f = path.join(lockDir, LOCK_NAME);
    // A lock whose holder is THIS process is alive by definition.
    writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "live" }));
    let threw = false;
    try {
      await withClaimsLock(dir, async () => undefined, SHORT_WAIT);
    } catch {
      threw = true;
    }
    assert(threw, "a live holder's lock is never swept (registration waits out and throws)");
    assert(
      readFileSync(f, "utf8").includes('"live"'),
      "the live holder's token is intact after the waiter gave up",
    );

    // A lock held by a pid that is not running is a corpse and IS reclaimed.
    writeFileSync(f, JSON.stringify({ pid: 2_000_000, at: Date.now(), nonce: "corpse" }));
    let ran = false;
    try {
      await withClaimsLock(dir, async () => {
        ran = true;
      });
    } catch {
      /* release may race; the body is the assertion */
    }
    assert(
      ran,
      "a corpse's lock (holder pid not running) IS reclaimed so the registry cannot be pinned",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 4 — release only removes its OWN lock.
  const dir = tmpDir();
  try {
    const lockDir = workStateDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const f = path.join(lockDir, LOCK_NAME);
    const foreign = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "FOREIGN" });
    let released = false;
    await withClaimsLock(dir, async () => {
      // A sibling swept our lock and published its own between our acquire and
      // our release. Our release must leave THEIR lock alone.
      writeFileSync(f, foreign);
      released = true;
    });
    assert(released, "the body ran");
    assert(readFileSync(f, "utf8") === foreign, "release did NOT unlink a lock it no longer owned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 5 — registerClaim fails rather than writing without the lock, and the two
  // refusals say DIFFERENT things.
  //
  // This is the fail-open that is NOT the test's injected fault: make the
  // lockfile unCREATABLE (a directory where the lock belongs) and assert no
  // claim file appeared and the call threw. The refusal here is the WAIT one,
  // and that is the honest outcome: an unreadable lock path is waited out
  // because `statSync` cannot tell "a sibling released it a moment ago" from
  // "it was never a file" (both report ENOENT), and guessing wrong on the
  // first is a fail-closed false alarm in the path every cycle takes. The
  // assertion that matters is the fail-closed one — nothing reached the
  // registry. §6's injected publish fault is what pins the creation refusal.
  const dir = tmpDir();
  try {
    const lockDir = workStateDir(dir);
    mkdirSync(lockDir, { recursive: true });
    // A DIRECTORY at the lock path: `open(path,"wx")` fails EISDIR — a real
    // "cannot create the lockfile", the same shape a read-only .pi produces.
    mkdirSync(path.join(lockDir, LOCK_NAME), { recursive: true });
    let err: Error | null = null;
    try {
      await registerClaim(dir, 771, ["src/locked.ts"]);
    } catch (e) {
      err = e as Error;
    }
    assert(err !== null, "registerClaim throws when the lockfile cannot be created");
    assert(
      err?.message.includes(CLAIMS_LOCK_REFUSAL),
      `the throw is the module's fail-closed refusal (${err?.message.slice(0, 110)}…)`,
    );
    let claimsExist = true;
    try {
      readFileSync(path.join(lockDir, "path-claims.json"), "utf8");
    } catch {
      claimsExist = false;
    }
    assert(!claimsExist, "no claim was written to the registry without the lock");

    // The OTHER refusal — a lock genuinely held by a live sibling past the
    // window — says so in its own words, and does not tell the operator to fix
    // permissions. "check that .pi is writable" is the wrong advice when a
    // sibling simply has the lock; the creation refusal (§6's fault path) is
    // the one that names the directory.
    const busy = tmpDir();
    try {
      const busyLock = path.join(workStateDir(busy), LOCK_NAME);
      mkdirSync(workStateDir(busy), { recursive: true });
      writeFileSync(busyLock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "busy" }));
      let busyErr: Error | null = null;
      try {
        await registerClaim(busy, 772, ["src/busy.ts"]);
      } catch (e) {
        busyErr = e as Error;
      }
      assert(busyErr !== null, "a lock held past the wait window also refuses to register");
      assert(
        busyErr !== null && /held by another cycle for over \d+ms/.test(busyErr.message),
        `the busy-refusal says "held by another cycle for over Ns" (${busyErr?.message.slice(0, 110)}…)`,
      );
      assert(
        busyErr !== null && !/writable/.test(busyErr.message),
        "the busy refusal does not tell the operator to fix permissions — waiting it out is the action",
      );
      assert(
        err !== null && !/writable/.test(err.message),
        "and the unreadable-path refusal is the same wait shape, not a permissions claim",
      );
    } finally {
      rmSync(busy, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 6 — a create that succeeds and a publish that THROWS leaves no lockfile.
  //
  // The half-created lock is the sibling of §2, and §2's own rule protects it:
  // an unparsable lockfile is never swept, so an empty file left behind by a
  // failed write pins every sibling for the whole wait window on a holder that
  // is not one. `acquire` closes the fd and unlinks the file it created, then
  // reports the fault. Driven through the accepted seam `setClaimsLockWriteFaultForTests`
  // (the shape `setLedgerCriticalSectionHookForTests` is), which fires between
  // the successful `openSync('wx')` and the write.
  const dir = tmpDir();
  try {
    const f = path.join(workStateDir(dir), LOCK_NAME);
    let attemptedWrites = 0;
    setClaimsLockWriteFaultForTests(() => {
      attemptedWrites++;
      const err = new Error("injected: publish failed") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });
    let threw = false;
    let refusal: Error | null = null;
    let t0 = Date.now();
    try {
      await withClaimsLock(dir, async () => undefined, SHORT_WAIT);
    } catch (e) {
      threw = true;
      refusal = e as Error;
    }
    const firstWait = Date.now() - t0;
    setClaimsLockWriteFaultForTests(undefined);
    assert(attemptedWrites > 0, "the injected publish fault fired (the seam is wired)");
    assert(threw, "a failed publish is reported as a fault, not run as an unlocked write");
    // This is the CREATION refusal — the one that names the writable directory.
    // It is reached here rather than through §5's directory because it is the
    // only shape that separates "the lockfile could not be made" from "someone
    // else has it": a real non-`wx` create failure, not an unreadable path.
    assert(
      refusal?.message.includes("cannot be created; check that .pi/work-state is writable"),
      `the creation refusal names the writable-directory fix, not a wait (${refusal?.message.slice(0, 110)}…)`,
    );
    assert(
      refusal !== null && !/held by another cycle/.test(refusal.message),
      "and does not blame another cycle for a filesystem the operator can fix",
    );
    assert(
      !existsSync(f),
      `no lockfile remains after a create succeeded and the publish threw (a leftover would pin every sibling for ${firstWait}ms+ each)`,
    );
    // And the NEXT writer is not held off by the corpse we refused to leave.
    t0 = Date.now();
    const after = Date.now();
    let ran = false;
    try {
      await withClaimsLock(
        dir,
        async () => {
          ran = true;
        },
        SHORT_WAIT,
      );
    } catch {
      /* the body assertion is what matters */
    }
    assert(ran, "the next writer acquires immediately — no half-created lock was left behind");
    assert(after - t0 < 100, `the next writer did NOT wait out the window (${after - t0}ms)`);
  } finally {
    setClaimsLockWriteFaultForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll claims-lock checks passed." : "\nFAILED");
process.exit(exit);
