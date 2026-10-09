#!/usr/bin/env bun
/**
 * #1071 — the review-ledger lock: the O_EXCL lockfile that serialises
 * appendLedgerEntry's read → dedupe → bumpLensRound → write-temp → rename
 * window so two concurrent writers on one clone (an adversarial_loop
 * finishing while a dispatch_lens_review finishes, or two Pi sessions on the
 * same clone) no longer lose a row.
 *
 * The lock (review-ledger-lock.ts) is colocated with the ledger file (named
 * from the resolved ledger path, honouring PI_ENSEMBLE_REVIEW_LEDGER_FILE),
 * holds {pid, at, holder}, and degrades to a no-op release on a past-deadline
 * wait or a non-EEXIST open error — the caller then falls through to the
 * existing unlocked write + mergeAfterRace fallback, which preserves the
 * other writer's row (the fallback re-reads before its rename).
 *
 * Three sections:
 *   1. lock lifecycle — present-while-held, removed-on-release, stale-swept,
 *      unparseable-treated-stale, past-deadline-degrades-to-no-op, and the
 *      default constants match the issue's "≈5 s wait / ≈30 s stale" spec.
 *   2. the two-process race regression — two bun children each call
 *      appendLedgerEntry against a shared PI_ENSEMBLE_REVIEW_LEDGER_FILE
 *      temp file. The race straddles the read/rename gap via a test-only
 *      env var (PI_ENSEMBLE_REVIEW_LEDGER_DELAY_READ_MS) that injects a
 *      delay INSIDE the critical section, between readLedgerFile and
 *      renameSync (see testDelayReadMs in review-ledger.ts). Without the
 *      lock, both children read an empty file, both write their own row,
 *      and the second's rename silently drops the first's row. With the
 *      lock, the second child waits for the first's critical section to
 *      release, then re-reads (the first's row is present), dedupes,
 *      bumps, and writes — both rows survive. The env var is passed
 *      explicitly via the spawn options so both children see the same
 *      value; the parent never sets it in its own env.
 *
 *   3. the in-process Promise.all supplement — two concurrent
 *      appendLedgerEntry calls for different branches against a shared
 *      temp-file ledger; both rows must survive.
 *
 * FAIL-WITHOUT-LOCK PROOF: with the lock temporarily bypassed (the
 * PI_ENSEMBLE_REVIEW_LEDGER_DELAY_READ_MS env var set to 150 ms and the
 * lock's acquireLedgerLock call removed from review-ledger.ts), the
 * two-process race in section 2 loses one row: both children read an empty
 * file, both write their own row, and the second's rename silently drops
 * the first's. This is the #1071 symptom. With the lock in place, the
 * second child waits for the first's release, re-reads, and both rows
 * survive. The proof is documented here; running it requires temporarily
 * bypassing the lock (see the issue's acceptance criteria).
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
    const release = acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
    assert(existsSync(lock), "the lockfile exists while held");
    release();
    assert(!existsSync(lock), "the lockfile is removed on release");

    // A FRESH (non-stale) held lock is NOT swept by a second acquire — the
    // second acquire waits (bounded) then degrades to a no-op release.
    {
      const r1 = acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
      const started = Date.now();
      // A second acquire with a short wait times out (the first holds the
      // lock fresh), degrading to a no-op release.
      const r2 = acquireLedgerLock(ledger, { waitMs: 30, pollMs: 5 });
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
      const release = acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
      const parsed = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
      assert(parsed.pid === process.pid, "a stale lockfile is swept and re-acquired (our pid)");
      release();
      assert(!existsSync(lock), "the swept lock is removed on release");
    }

    // An UNPARSEABLE lockfile is treated as stale (swept and re-acquired).
    {
      writeFileSync(lock, "not json at all");
      const release = acquireLedgerLock(ledger, { waitMs: 50, pollMs: 5 });
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
      const r1 = acquireLedgerLock(ledger, { waitMs: 200, pollMs: 5 });
      let threw = false;
      let degraded: (() => void) | undefined;
      try {
        degraded = acquireLedgerLock(ledger, { waitMs: 30, pollMs: 5 });
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
// file. The race straddles the read/rename gap via a test-only env var
// (PI_ENSEMBLE_REVIEW_LEDGER_DELAY_READ_MS) that injects a delay INSIDE
// the critical section, between readLedgerFile and renameSync. Without
// the lock, both children read an empty file, both write their own row,
// and the second's rename silently drops the first's row (the #1071
// symptom). With the lock, the second child waits for the first's
// release, re-reads (the first's row is present), dedupes, bumps, and
// writes — both rows survive.
//
// The env var is passed explicitly via the spawn options (env: {
// PI_ENSEMBLE_REVIEW_LEDGER_FILE: ledger,
// PI_ENSEMBLE_REVIEW_LEDGER_DELAY_READ_MS: "150" }) so both children see
// the same value; the parent never sets it in its own env.
// ===========================================================

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-race-"));
  const ledger = path.join(dir, "review-ledger.json");
  const childScript = path.join(dir, "child.ts");
  try {
    // The child imports the REAL appendLedgerEntry and writes ONE entry for
    // the branch named by the first CLI arg. The env vars
    // PI_ENSEMBLE_REVIEW_LEDGER_FILE and
    // PI_ENSEMBLE_REVIEW_LEDGER_DELAY_READ_MS are passed explicitly via
    // the spawn options.
    writeFileSync(
      childScript,
      `import { appendLedgerEntry } from "${path.join(import.meta.dir, "..", "src", "review-ledger.ts").replace(/\\/g, "/")}";
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
    // 150 ms delay INSIDE the critical section (between read and rename).
    // Without the lock, both read an empty file, both write their own row,
    // and the second's rename silently drops the first's row. With the
    // lock, the second waits for the first's release, re-reads, and both
    // rows survive.
    {
      const at = Date.now();
      const childEnv = {
        ...process.env,
        PI_ENSEMBLE_REVIEW_LEDGER_FILE: ledger,
        PI_ENSEMBLE_REVIEW_LEDGER_DELAY_READ_MS: "150",
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

console.log(`\nexit ${exit}`);
process.exit(exit);
