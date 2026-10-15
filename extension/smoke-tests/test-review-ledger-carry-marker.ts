#!/usr/bin/env bun
/**
 * #1176 — the carry marker in bumpLensRound (review-ledger-round.ts).
 *
 * The round counter skips the advance ONLY for an entry carrying the explicit
 * `carriedFrom` marker. A normal lens append that arrives with a preset `round`
 * (and no marker) still advances from the previous latest entry, so a stale or
 * caller-supplied round cannot freeze the counter.
 */

import type { LedgerEntry } from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { bumpLensRound } = await import("../src/review-ledger-round.ts");

const branch = "feature/work";
const prior: LedgerEntry = {
  branch,
  kind: "lens",
  patchId: "p",
  passed: false,
  at: 1000,
  detail: "ISSUES_FOUND",
  round: 2,
  hasCritical: false,
  headSha: "a".repeat(40),
};

// (1) a normal lens append with a PRESET round and no marker still advances
{
  const next = bumpLensRound(
    { ...prior, at: 2000, round: 7, headSha: "b".repeat(40), carriedFrom: undefined },
    [prior],
  );
  assert(next.round === 3, "a preset round without the carry marker still advances (2 → 3)");
}

// (2) the explicit carry marker: the entry is returned as written, round kept
{
  const carried: LedgerEntry = { ...prior, at: 2000, carriedFrom: prior.headSha };
  const out = bumpLensRound(carried, [prior]);
  assert(out === carried, "a carried entry is returned unchanged (same object)");
  assert(out.round === 2, "a carried entry keeps the round it copies (no advance)");
}

// (3) a first normal append with no previous entry is round 1
{
  const first = bumpLensRound({ ...prior, at: 1, round: undefined, carriedFrom: undefined }, []);
  assert(first.round === 1, "the first lens append is round 1");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
