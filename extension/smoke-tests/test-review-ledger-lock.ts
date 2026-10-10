#!/usr/bin/env bun
/**
 * #1071 — the review-ledger lock: proves appendLedgerEntry's
 * read→transform→rename window is serialised so two concurrent writers on
 * one clone no longer lose a row. The lock contract lives in
 * review-ledger-lock.ts's header; this file proves it with four sections:
 * (1) lock lifecycle (held/removed/stale-swept/degraded no-op + default
 * constants), (2) the two-process race regression (both rows survive; one is
 * lost without the lock — see the fail-without-lock note there), (3) an
 * in-process Promise.all supplement, and (4) an event-loop non-blocking
 * proof for the async acquire poll loop.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEDGER_LOCK_STALE_MS,
  LEDGER_LOCK_WAIT_MS,
  acquireLedgerLock,
  ledgerLockPath,
} from "../src/review-ledger-lock.ts";
import { type LedgerEntry, appendLedgerEntry, readLedgerAt } from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ===========================================================
// 1. lock lifecycle
// ===========================================================

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-lock-"));
  const ledger = path.join(dir, "review-ledger.json");
  const lock = ledgerLockPath(ledger);
  try {
    // The lock path is colocated with the ledger file (the resolved path).
    assert(
      lock === `${ledger}.lock`,
      "the lockfile is colocated with the ledger file (named from the resolved path)",
    );

    // present while held, removed on release.
    const release = await acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
    assert(existsSync(lock), "the lockfile exists while held");
    release();
    assert(!existsSync(lock), "the lockfile is removed on release");

    // A FRESH (non-stale) held lock is NOT swept by a second acquire — the
    // second acquire waits (bounded) then degrades to a no-op release.
    {
      const r1 = await acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
      const started = Date.now();
      // A second acquire with a short wait times out (the first holds the
      // lock fresh), degrading to a no-op release.
      const r2 = await acquireLedgerLock(ledger, { waitMs: 30, pollMs: 5 });
      const elapsed = Date.now() - started;
      assert(
        elapsed >= 20,
        `a fresh held lock is waited on (not swept) — the second acquire blocked ${elapsed}ms`,
      );
      r2();
      r1();
      assert(!existsSync(lock), "the lockfile is removed after both releases");
    }

    // A STALE lockfile is swept and re-acquired.
    {
      const staleAt = Date.now() - 60_000; // 60 s old, past the 30 s default
      writeFileSync(lock, JSON.stringify({ pid: 999999, at: staleAt, holder: "999999:x" }));
      const release = await acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
      const parsed = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
      assert(parsed.pid === process.pid, "a stale lockfile is swept and re-acquired (our pid)");
      release();
      assert(!existsSync(lock), "the swept lock is removed on release");
    }

    // An UNPARSEABLE lockfile is treated as stale (swept and re-acquired).
    {
      writeFileSync(lock, "not json at all");
      const release = await acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
      const parsed = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
      assert(
        parsed.pid === process.pid,
        "an unparseable lockfile is treated as stale (swept, re-acquired)",
      );
      release();
    }

    // A FRESH held lock past the bounded wait → degraded no-op release (the
    // caller falls through to the unlocked write + mergeAfterRace). The
    // degraded path never throws and never blocks long.
    {
      const r1 = await acquireLedgerLock(ledger, { waitMs: 200, pollMs: 5 });
      let threw = false;
      let degraded: (() => void) | undefined;
      try {
        degraded = await acquireLedgerLock(ledger, { waitMs: 30, pollMs: 5 });
      } catch (e) {
        threw = true;
      }
      assert(!threw, "a past-deadline wait does not throw (degraded no-op release)");
      // The degraded release is a no-op — calling it does not remove the
      // lock (we don't own it).
      try {
        degraded?.();
      } catch {
        threw = true;
      }
      assert(!threw, "the degraded no-op release is safe to call");
      r1();
      assert(!existsSync(lock), "the original lock is removed on its own release");
    }

    // The default constants match the issue's "≈5 s wait / ≈30 s stale".
    assert(
      LEDGER_LOCK_WAIT_MS === 5_000,
      `the default bounded wait is ≈5 s (got ${LEDGER_LOCK_WAIT_MS} ms)`,
    );
    assert(
      LEDGER_LOCK_STALE_MS === 30_000,
      `the default stale window is ≈30 s (got ${LEDGER_LOCK_STALE_MS} ms)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================
// 2. the two-process race regression
//
// Two bun children each call the REAL appendLedgerEntry (imported from the
// module, not mocked) against a shared PI_ENSEMBLE_REVIEW_LEDGER_FILE temp
// file. The race straddles the read/rename gap via the test-only injection
// point setLedgerCriticalSectionHookForTests (review-ledger-lock.ts): the
// child script sets a ~150 ms await hook between readLedgerFile and
// renameSync (production never sets it — undefined → no-op). Without the
// lock, both children read an empty file, both write their own row, and the
// second's rename silently drops the first's row (the #1071 symptom). With
// the lock, the second waits for the first's release, re-reads, and both
// rows survive.
//
// Only PI_ENSEMBLE_REVIEW_LEDGER_FILE is passed via the spawn env (so both
// children resolve the same ledger path); the delay hook is set inside the
// child, so it needs no env variable.
// ===========================================================

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-race-"));
  const ledger = path.join(dir, "review-ledger.json");
  const childScript = path.join(dir, "child.ts");
  try {
    // The child imports the REAL appendLedgerEntry and writes ONE entry for
    // the branch named by the first CLI arg. It sets the test-only
    // critical-section hook (a ~150 ms await between the ledger read and
    // the rename) BEFORE calling appendLedgerEntry, so the race straddles
    // the gap deterministically. Only PI_ENSEMBLE_REVIEW_LEDGER_FILE is
    // passed via the spawn env.
    writeFileSync(
      childScript,
      `import { appendLedgerEntry } from "${path.join(import.meta.dir, "..", "src", "review-ledger.ts").replace(/\\/g, "/")}";
import { setLedgerCriticalSectionHookForTests } from "${path.join(import.meta.dir, "..", "src", "review-ledger-lock.ts").replace(/\\/g, "/")}";
setLedgerCriticalSectionHookForTests(async () => {
  await new Promise((r) => setTimeout(r, 150));
});
const branch = process.argv[2];
const at = Number(process.argv[3]);
const r = await appendLedgerEntry(
  { branch, kind: "adversarial", patchId: "p-" + branch, passed: true, at },
  async (cmd, opts) => {
    void cmd;
    void opts;
    return { stdout: "", stderr: "" };
  },
  process.cwd(),
);
if (r !== undefined) {
  console.error("child appendLedgerEntry failed: " + r);
  process.exit(1);
}
process.exit(0);
`,
      "utf8",
    );

    // Two children spawned CONCURRENTLY (not sequentially), each with a
    // 150 ms hook INSIDE the critical section (between read and rename).
    // Without the lock, both read an empty file, both write their own row,
    // and the second's rename silently drops the first's row. With the
    // lock, the second waits for the first's release, re-reads, and both
    // rows survive.
    {
      const at = Date.now();
      const childEnv = {
        ...process.env,
        PI_ENSEMBLE_REVIEW_LEDGER_FILE: ledger,
      };
      const p1 = new Promise<void>((resolve) => {
        const c = spawn("bun", [childScript, "feature/a", String(at)], {
          env: childEnv,
          stdio: "ignore",
        });
        c.on("close", () => resolve());
      });
      const p2 = new Promise<void>((resolve) => {
        const c = spawn("bun", [childScript, "feature/b", String(at + 1)], {
          env: childEnv,
          stdio: "ignore",
        });
        c.on("close", () => resolve());
      });
      await Promise.all([p1, p2]);
      const entries = readLedgerAt(ledger);
      const rowsA = entries.filter((e) => e.branch === "feature/a");
      const rowsB = entries.filter((e) => e.branch === "feature/b");
      assert(
        rowsA.length === 1 && rowsA[0]?.patchId === "p-feature/a",
        "two-process race: the feature/a row survived (the other writer's row was not lost)",
      );
      assert(
        rowsB.length === 1 && rowsB[0]?.patchId === "p-feature/b",
        "two-process race: the feature/b row survived (both concurrent writers are present)",
      );
      assert(
        rowsA[0]?.at === at && rowsB[0]?.at === at + 1,
        "two-process race: each row carries its own (branch, kind, at) — no cross-contamination",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================
// 3. the in-process Promise.all supplement
//
// Two concurrent appendLedgerEntry calls for DIFFERENT branches against a
// shared temp-file ledger (the PI_ENSEMBLE_REVIEW_LEDGER_FILE override).
// Both rows must survive — the lock serialises the two in-process critical
// sections, and the degraded path (if the lock times out) falls through to
// mergeAfterRace, which also preserves both rows.
// ===========================================================

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-ppo-"));
  const ledger = path.join(dir, "review-ledger.json");
  const prevLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledger;
  const execp = async (
    cmd: string,
    opts?: { cwd?: string; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }> => {
    void cmd;
    void opts;
    return { stdout: "", stderr: "" };
  };
  try {
    const at = Date.now();
    await Promise.all([
      appendLedgerEntry(
        { branch: "feature/x", kind: "adversarial", patchId: "px", passed: true, at },
        execp,
        dir,
      ),
      appendLedgerEntry(
        { branch: "feature/y", kind: "lens", patchId: "py", passed: true, at: at + 1 },
        execp,
        dir,
      ),
    ]);
    const entries = readLedgerAt(ledger);
    const x = entries.filter((e) => e.branch === "feature/x");
    const y = entries.filter((e) => e.branch === "feature/y");
    assert(x.length === 1 && x[0]?.patchId === "px", "in-process: feature/x survived");
    assert(y.length === 1 && y[0]?.patchId === "py", "in-process: feature/y survived");
  } finally {
    if (prevLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevLedger;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================
// 4. event-loop non-blocking proof
//
// While a held lock forces a contended (async) acquire into its poll loop,
// a concurrent setTimeout(…, 10) callback in the SAME process must still
// fire before the acquire gives up. A synchronous (Atomics.wait) sleep in
// the poll would stop the whole event loop for the poll — the timer could
// not fire inside the wait window. An awaited setTimeout yields back to
// the loop, so the timer fires while the acquire is still waiting.
// ===========================================================

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-el-"));
  const ledger = path.join(dir, "review-ledger.json");
  const lock = ledgerLockPath(ledger);
  try {
    // A held FRESH lock: the contended acquire below cannot create the
    // lockfile (EEXIST) and enters its bounded async poll loop.
    const r1 = await acquireLedgerLock(ledger, { waitMs: 300, pollMs: 10 });
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 10);
    const started = Date.now();
    const r2 = await acquireLedgerLock(ledger, { waitMs: 100, pollMs: 10 });
    const elapsed = Date.now() - started;
    assert(
      timerFired,
      "event loop not blocked: a concurrent 10 ms setTimeout fired while the contended acquire was waiting",
    );
    assert(
      elapsed >= 80,
      `the contended acquire actually waited (not instant) — ${elapsed}ms, so the timer firing is not a trivial ordering`,
    );
    r2(); // degraded no-op release; safe
    r1();
    clearTimeout(timer);
    assert(!existsSync(lock), "the held lock is removed on its own release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
