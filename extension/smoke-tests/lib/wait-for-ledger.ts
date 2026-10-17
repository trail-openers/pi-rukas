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
 *    a negative case would burn a full budget per case);
 *  - `once: true` is an EXPLICIT single read for a caller that owns its own
 *    wall clock elsewhere. Today that is exactly one caller, `waitForLensRound`
 *    in lib/review-autonomy-fixtures.ts, which supplies its own awaited 20 ms
 *    tick; every other caller stays on the budgeted `Atomics.wait` path below.
 *    It exists because `budgetMs: 0` reached the same
 *    code path by accident — the `while (Date.now() < deadline)` guard is
 *    false on entry, so the loop body (the parse, and the torn-write handling
 *    that keeps the poll going on a mid-rename read) never ran and the call
 *    fell straight to the deadline tail. A caller who wrote "zero budget" to
 *    mean "one read" therefore got deadline semantics, including the
 *    unparseable-file re-raise, rather than read semantics. `once` says what
 *    the caller meant and pins the single-read contract (miss = "not yet",
 *    never a raise). `budgetMs: 0` still works and still means "do not wait";
 *    it is simply no longer how you ask for one read.
 *
 * `until` (waiting for a PROPERTY of an already-present file, e.g. a later
 * round of a ledger that exists from round 1) has its own failure mode, which
 * the file-exists rule cannot express: at the deadline the file IS readable, so
 * returning its entries would hand the caller a STALE row and let a "the entry
 * must exist" assertion pass on an older entry. A `until` whose predicate was
 * never satisfied therefore returns null — the same "nothing arrived" signal a
 * missing file gives — while a file that was never readable for the whole budget
 * still re-raises (a torn write is a failure, not an absence). That is why the
 * flag below records "was the file readable", not "was the predicate true":
 * the predicate's own falseness is exactly what null must report.
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

/** Poll cadence. Also the smallest unit a `once` read could have waited on. */
const POLL_INTERVAL_MS = 20;

export interface WaitForLedgerOpts {
  budgetMs?: number;
  until?: (entries: LedgerEntry[]) => boolean;
  /** One read, no poll, no wait. */
  once?: boolean;
}

/**
 * Poll `file` until it appears and parses (returning its entries), or the
 * budget expires. A partial write keeps the poll going; a file that is still
 * unreadable at the deadline is a test failure (re-raised), not a silent null.
 *
 * `once: true` collapses the whole thing to a single read — no poll, no
 * `Atomics.wait`, no budget. The contract that makes it useful is what a
 * MISS means: an absent file and an unparseable file are both reported as
 * "not yet" (`null`), never as the error the budgeted path raises at its
 * deadline. That is deliberate. A caller that asks for one read is asking
 * "what is on disk right now", typically from inside its own retry loop that
 * owns the wall clock; a torn write at that instant is the next tick's
 * business, and raising here would turn a transient mid-rename read into a
 * test failure the caller has no way to recover from. The budgeted path keeps
 * the re-raise precisely because there the deadline is the last chance.
 */
export function waitForLedger(
  file: string,
  opts: number | WaitForLedgerOpts = {},
): LedgerEntry[] | null {
  const o = typeof opts === "number" ? { budgetMs: opts } : opts;
  const budgetMs = o.budgetMs ?? LEDGER_WAIT_BUDGET_MS;
  const read = (): LedgerEntry[] => {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray((parsed as { entries?: unknown } | null)?.entries)) {
      throw new SyntaxError("malformed ledger file (expected an object with an entries array)");
    }
    return validEntries((parsed as { entries: unknown[] }).entries);
  };
  // `until` lets a caller wait for a PROPERTY of the file rather than for the
  // file itself (a later round of an already-existing ledger). The poll checks
  // it first and only sleeps on a miss, so the passing path costs one read.
  const satisfied = (entries: LedgerEntry[]): boolean => (o.until ? o.until(entries) : true);
  if (o.once) {
    // The single-read shape. An absent file and an unparseable one are the same
    // answer here — see the docstring for why neither raises. No `Atomics.wait`,
    // which is what parks the whole thread and starves the async writer this
    // poll normally waits on (#984).
    if (!existsSync(file)) return null;
    try {
      const entries = read();
      return satisfied(entries) ? entries : null;
    } catch {
      return null;
    }
  }
  const deadline = Date.now() + budgetMs;
  let silentReads = 0;
  // Whether the file was EVER readable during the poll. A caller waiting for a
  // property (`until`) that never appeared must get `null` — not the stale
  // entries a final read would hand back, which would let an "entry expected"
  // assertion pass on an older row. A file that stayed unparseable for the whole
  // budget is a different failure and re-raises, so the two are tracked apart.
  let everReadable = false;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const entries = read();
        everReadable = true;
        if (satisfied(entries)) return entries;
      } catch {
        // Not parseable yet (mid-rename/torn write) — count it for the
        // deadline re-raise and keep polling (the rename is atomic).
        silentReads += 1;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_INTERVAL_MS);
  }
  if (!existsSync(file)) return null;
  if (o.until && everReadable) return null;
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
