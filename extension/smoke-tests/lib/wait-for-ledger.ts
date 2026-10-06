/**
 * Shared poll for the fire-and-forget review-ledger write (lens + adversarial
 * ledger paths). #984 — the flake these tests hit on a loaded host: the
 * writer is fire-and-forget (the #912 "never a gate on it" contract) and does
 * two awaited git subprocess calls before the atomic tmp+rename, so a fixed
 * 2-5 s budget consumed by child-process startup on a loaded machine makes
 * the file appear "late" and the test's existsSync-based assertions fail on
 * an idle host that is fine on a loaded one. The shared helper:
 *
 *  - returns the moment the file appears (the passing path stays fast — the
 *    poll is 20 ms, not a sleep), so a fast write does not cost the full
 *    budget;
 *  - defaults to a generous 30 s budget (the issue's ≥30 s floor) so a
 *    loaded host has headroom for the two subprocess hops;
 *  - preserves the partial-write handling the original inlined helpers had:
 *    an existsSync=true file whose JSON is not yet parseable (mid-rename, or
 *    a torn write) keeps the poll going rather than erroring or returning a
 *    corrupt row — the poll reads the file directly (readFileSync +
 *    JSON.parse, NOT readLedgerAt, which swallows parse errors to `[]`) so
 *    the unparseable case is actually distinguishable from a clean empty read;
 *  - distinguishes "no entry expected" (a negative assertion — a short
 *    budget, the caller asserts null) from "entry expected" (a 30 s budget,
 *    the caller asserts non-null), so the helper never blocks on a case
 *    that expects no write (the edge case the issue calls out: the writer
 *    may legitimately write nothing on a detached head, and a 30 s wait on
 *    a negative case would burn a full budget per case).
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/poll-until-killed.ts`, #846);
 * coverage comes through the test files that import it.
 */

import { existsSync, readFileSync } from "node:fs";
import { validEntries } from "../../src/review-ledger.ts";
import type { LedgerEntry } from "../../src/review-ledger.ts";

/** Default budget for "an entry is expected" — 30 s, the issue's floor. */
const LEDGER_WAIT_BUDGET_MS = 30_000;

/**
 * Poll `file` until it appears and parses (returning its entries), or the
 * budget expires. A partial write keeps the poll going; a file that is still
 * unreadable at the deadline is a test failure (re-raised), not a silent null.
 */
export function waitForLedger(
  file: string,
  budgetMs: number = LEDGER_WAIT_BUDGET_MS,
): LedgerEntry[] | null {
  const read = (): LedgerEntry[] => {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray((parsed as { entries?: unknown } | null)?.entries)) {
      throw new SyntaxError(
        "malformed ledger file (expected an object with an entries array)",
      );
    }
    return validEntries((parsed as { entries: unknown[] }).entries);
  };
  const deadline = Date.now() + budgetMs;
  let silentReads = 0;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return read();
      } catch {
        // Not parseable yet (mid-rename/torn write) — count it for the
        // deadline re-raise and keep polling (the rename is atomic).
        silentReads += 1;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (!existsSync(file)) return null;
  try {
    return read();
  } catch (err) {
    const e = err as Error;
    throw new Error(
      `waitForLedger: ledger file ${file} unreadable after ${budgetMs}ms budget ` +
        `(${silentReads} silent mid-poll read failure(s)): ${e.message}`,
    );
  }
}
