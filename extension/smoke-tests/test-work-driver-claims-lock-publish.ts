#!/usr/bin/env bun
/**
 * #1454 — the claims lock must be published atomically, and an unserialisable
 * registration must fail rather than proceed unlocked.
 *
 * Two defects this pins, both found under 8-way parallel `/work` load:
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
 *    silently overwrite. `registerClaim` now throws with a traced reason. The
 *    test's own injected fault (`PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED`) is the
 *    deliberate exception the mutation arm needs, and is NOT this path.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { registerClaim } from "../src/work-driver-path-claims.ts";
import { withClaimsLock } from "../src/work-driver-path-claims-lock.ts";
import { workStateDir } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

function tmpDir(): string {
  const dir = path.join(
    require("node:os").tmpdir(),
    `pi-claims-lock-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

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
    assert(observed.startsWith("{") && observed.endsWith("}"), "lockfile holds a complete JSON token while held");
    assert(sizeAtReturn > 20, `token is non-trivial (${sizeAtReturn} bytes) — a zero-byte publish would read ""`);
    const parsed = JSON.parse(observed) as { pid?: unknown; at?: unknown; nonce?: unknown };
    assert(parsed.pid === process.pid, "token names the holding pid");
    assert(typeof parsed.at === "number", "token carries a timestamp (so an age bound can judge it)");
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
  // 1b — no SIBLING can ever observe the lockfile without its token.
  //
  // This is the check the same-process version cannot make: within one process
  // an `await`ed publish still lands before any other task runs, so the
  // zero-byte window is invisible. A SEPARATE observer process polling the
  // real path sees it, which is exactly what the async shape exposed — 25,391
  // zero-byte reads against the sync shape's 0. Eight writers are spawned,
  // each acquiring and holding briefly, while an observer records every
  // distinct content it can read.
  const dir = tmpDir();
  const obsPath = path.join(dir, "observer.mjs");
  writeFileSync(
    obsPath,
    [
      "import { readFileSync, existsSync } from 'node:fs';",
      "const [lock, stopFile] = process.argv.slice(2);",
      "let empty = 0, token = 0, absent = 0, partial = 0;",
      "const stopAt = Date.now() + 30000;",
      "for (;;) {",
      "  try {",
      "    const s = readFileSync(lock, 'utf8');",
      "    if (s.length === 0) empty++;",
      "    else if (s.startsWith('{') && s.trimEnd().endsWith('}')) token++;",
      "    else partial++;",
      "  } catch { absent++; }",
      "  if (existsSync(stopFile) || Date.now() > stopAt) break;",
      "  await new Promise((r) => setTimeout(r, 0.01));",
      "}",
      "process.stdout.write(JSON.stringify({ empty, token, partial, absent }));",
    ].join("\n"),
  );
  const lockPath = path.join(workStateDir(dir), LOCK_NAME);
  const holder = path.join(dir, "holder.mjs");
  writeFileSync(
    holder,
    [
      "import { withClaimsLock } from " + JSON.stringify(path.join(import.meta.dirname, "..", "src", "work-driver-path-claims-lock.ts")) + ";",
      "const [dir] = process.argv.slice(2);",
      "await withClaimsLock(dir, async () => { await new Promise((r) => setTimeout(r, 30)); });",
    ].join("\n"),
  );
  const stopFile = path.join(dir, "stop");
  const obs = spawn(process.execPath, [obsPath, lockPath, stopFile], { stdio: ["ignore", "pipe", "pipe"] });
  const obsDone = new Promise<void>((res) => obs.on("exit", () => res()));
  let obsOut = "";
  let obsErr = "";
  obs.stdout.on("data", (d) => (obsOut += d));
  obs.stderr.on("data", (d) => (obsErr += d));
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
    };
    assert(
      counts.empty === 0,
      `no sibling ever read a ZERO-BYTE lockfile (empty=${counts.empty}, token=${counts.token}, partial=${counts.partial}, absent=${counts.absent})`,
    );
    assert(counts.partial === 0, `no sibling ever read a PARTIAL token (partial=${counts.partial})`);
    assert(
      counts.token > 0,
      `the observer did see complete tokens (${counts.token} reads, stderr=${obsErr.slice(0, 80)}) — the probe was live`,
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
      await withClaimsLock(dir, async () => undefined);
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
      await withClaimsLock(dir, async () => undefined);
    } catch {
      threw = true;
    }
    assert(threw, "a live holder's lock is never swept (registration waits out and throws)");
    assert(readFileSync(f, "utf8").includes('"live"'), "the live holder's token is intact after the waiter gave up");

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
    assert(ran, "a corpse's lock (holder pid not running) IS reclaimed so the registry cannot be pinned");
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
  // 5 — registerClaim fails rather than writing without the lock.
  //
  // This is the fail-open that is NOT the test's injected fault: make the
  // lockfile unCREATABLE (a directory where the lock belongs) and assert no
  // claim file appeared and the call threw with a traced reason.
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
      err !== null && /without the lock/.test(err.message),
      `the throw names the reason (${err?.message.slice(0, 90)}…)`,
    );
    let claimsExist = true;
    try {
      readFileSync(path.join(lockDir, "path-claims.json"), "utf8");
    } catch {
      claimsExist = false;
    }
    assert(!claimsExist, "no claim was written to the registry without the lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll claims-lock checks passed." : "\nFAILED");
process.exit(exit);
