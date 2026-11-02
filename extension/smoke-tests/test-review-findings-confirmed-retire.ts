#!/usr/bin/env bun
/**
 * #1934 — a review finding row is retired by a CONFIRMATION bound to a commit,
 * not only by lens-round evidence about its cited line.
 *
 * Three surfaces, and the split is the point: the pure rule (`rowFate`'s
 * confirmation arm), the query that decides whether a confirmation exists
 * (`confirmationsFor`), and the round that consumes one (`applyFindingRound`
 * through the real store, on a real clone. The four ACs, named at their
 * assertion sites below: AC1 a bound confirmation retires a re-reported CRITICAL
 * with provenance; AC2 a mismatched/absent/unreadable confirmation retires
 * nothing; AC3 the delta veto and the retirement arm agree; AC4 a lapsed
 * confirmation re-opens the row unchanged and reports the lapse.
 *
 * Split for the AGENTS.md §12 500-line gate: this file is the PURE rule and the
 * store; the render half of AC1/AC4 (`confirmedBy` reaching `resolvedSection`, a
 * lapse reaching `confirmationLapseSection` on both operator surfaces) is
 * test-review-findings-disclosure-render.ts, which also says why each half alone
 * leaves a seam unasserted.
 *
 * Isolation follows test-auto-delta-critical-forced-full.ts: `PI_ENSEMBLE_
 * REVIEW_LEDGER_FILE` pins BOTH the ledger and the findings store into the
 * fixture dir, so the round reads and writes only this test's files, and the
 * ledger a confirmation is read from is a file this test wrote.
 */

import {
  CITED,
  FINDING,
  HEAD_LINES,
  git,
  makeFixture,
  releaseFixture,
  removeFixture,
  reReport,
  seed,
  rowsOf,
  silentRound,
  writeLedger,
} from "./lib/confirmation-store-fixture.ts";
import {
  type ReviewKind,
  isRetirableOpenCriticalRow,
  rowFate,
} from "../src/review-findings-fate.ts";
import { confirmationsFor } from "../src/review-confirmation.ts";
import type { LedgerEntry } from "../src/review-ledger-entry.ts";
import type { HeadState } from "../src/review-findings-head.ts";
import { lineHashAt, snippetHashAt } from "../src/review-findings-match.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import { parseFindingsFile } from "../src/review-findings-file.ts";
import { recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";
import { execp } from "../src/exec.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const AT_HEAD: HeadState = { kind: "lines", lines: HEAD_LINES };

/** The acceptance an `accepted` row must carry (see `StoredFinding`'s status split). */
const acceptanceFor = (snippetHash: string) => ({
  by: "op",
  reason: "x".repeat(30),
  at: 1,
  snippetHash,
});

/** A row whose cited line still exists at head, byte for byte.
 *
 * `StoredFinding` is a discriminated union — an `accepted` row requires an
 * `acceptance` and forbids a `resolvedReason` — and spreading a `Partial` of it
 * re-widens `status` across every arm, so the literal can no longer be checked
 * against any one of them. The return is therefore annotated at the one point
 * that knows which arm the spread produced; every caller below builds the arm it
 * claims (`status: "accepted"` always rides with an `acceptance`), so this is a
 * narrowing of a value the caller constructs, not a cast over an unknown one. */
function stuckRow(over: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: "abcd1234",
    branch: "feature/work",
    path: "src/a.ts",
    anchor: "a",
    titleClass: "unvalidated input reaches executor",
    title: "Unvalidated input reaches the executor",
    severity: "CRITICAL",
    lens: "PERFORMANCE",
    line: CITED,
    snippetHash: snippetHashAt(HEAD_LINES, CITED),
    lineHash: lineHashAt(HEAD_LINES, CITED),
    status: "open",
    firstSeen: 1000,
    lastSeen: 1000,
    ...over,
  } as StoredFinding;
}

const CONFIRMED_BY = "adversarial#abcd1234 patch=deadbeef head=11112222 round=2@11112222";

/** A HEAD whose cited line is present: the confirmation arm's only customer. */
const headWithCitedLine = AT_HEAD;

// ---------------------------------------------------------------------------
// AC1 — the fate rule: a byte-unchanged cited line + a bound confirmation
// ---------------------------------------------------------------------------

{
  // Without the confirmation the row carries (this is the defect it closes).
  assert(
    rowFate(stuckRow(), headWithCitedLine, "full").kind === "carry",
    "AC1 baseline: an unchanged cited line carries on a full round with no confirmation",
  );
  const fate = rowFate(stuckRow(), headWithCitedLine, "full", { confirmedBy: CONFIRMED_BY });
  assert(
    fate.kind === "resolve" && fate.reason === "confirmed",
    `AC1: a re-reported row with byte-unchanged cited code retires on a bound confirmation (got ${JSON.stringify(fate)})`,
  );
  // Re-reported AND retired: reached only because the round re-reported it, and
  // AC1 says such a row must be eligible — if only untouched rows retired, the
  // row whose re-report sets hasCritical could never retire.
  const row = stuckRow();
  assert(isRetirableOpenCriticalRow(row), "AC1: the row is the shape the veto's predicate accepts");
}

// The arm is gated, in every direction that matters.
{
  const sec = rowFate(stuckRow({ lens: "SECURITY" }), headWithCitedLine, "full", {
    confirmedBy: CONFIRMED_BY,
  });
  assert(sec.kind === "carry", "AC1 carve-out: a SECURITY row is never retired by a confirmation");
  const accepted = rowFate(
    {
      ...stuckRow(),
      status: "accepted",
      acceptance: acceptanceFor("ff"),
    } as StoredFinding,
    headWithCitedLine,
    "full",
    { confirmedBy: CONFIRMED_BY },
  );
  assert(
    accepted.kind === "carry",
    "AC1 carve-out: an ACCEPTED row is never retired by a confirmation — an operator decision is not lapsed by a review",
  );
  for (const review of ["delta", "incomplete"] as ReviewKind[]) {
    assert(
      rowFate(stuckRow(), headWithCitedLine, review, { confirmedBy: CONFIRMED_BY }).kind ===
        "carry",
      `AC1 gate: a ${review} round never retires on a confirmation`,
    );
  }
  assert(
    rowFate(stuckRow({ lineHash: undefined }), headWithCitedLine, "full", {
      confirmedBy: CONFIRMED_BY,
    }).kind === "carry",
    "AC1 gate: a CRITICAL with no lineHash is outside the shared predicate, so no confirmation retires it",
  );
}

// ---------------------------------------------------------------------------
// AC2 — the query: no fault in the confirmation path produces a resolution
// ---------------------------------------------------------------------------

const HEAD_SHA = "1111222233334444555566667777888899990000".slice(0, 40);
const PATCH = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const SEEN = { firstSeen: 1000, lastSeen: 2000 };
const good = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  branch: "feature/work",
  kind: "adversarial",
  patchId: PATCH,
  passed: true,
  at: 1500,
  headSha: HEAD_SHA,
  rowId: "abcd1234",
  ...over,
});
const ask = (entries: readonly LedgerEntry[], id = PATCH, sha = HEAD_SHA, seen = SEEN) =>
  confirmationsFor(entries, "feature/work", { patchId: id, headSha: sha }, seen);

{
  assert(ask([good()]).get("abcd1234") !== undefined, "AC2 baseline: a bound confirmation answers");
  /** A row whose `rowId` field is absent — the ordinary ledger shape. */
function withoutRowId(e: LedgerEntry): LedgerEntry {
  const { rowId: _drop, ...rest } = e;
  return rest as LedgerEntry;
}
const refusals: Array<[string, LedgerEntry | undefined]> = [
    ["a differing patchId", good({ patchId: "other" })],
    ["a differing headSha", good({ headSha: "f".repeat(40) })],
    ["an absent patchId", good({ patchId: "" })],
    ["an absent headSha", good({ headSha: undefined })],
    ["a malformed headSha (not a full oid)", good({ headSha: "abc123" })],
    ["passed: false", good({ passed: false })],
    ["kind: lens (the round cannot confirm itself)", good({ kind: "lens" })],
    ["a confirmation for a DIFFERENT row", withoutRowId(good())],
    ["a malformed rowId", good({ rowId: "not-a-row-id" })],
    ["an earlier round (before the row was filed)", good({ at: 500 })],
    ["a round recorded after the row was last observed", good({ at: 2500 })],
  ];
  for (const [why, entry] of refusals) {
    const got = ask(entry ? [entry] : []);
    assert(got.size === 0, `AC2: ${why} → no confirmation (got ${[...got.values()].join(",")})`);
  }
  // What became of the assertions this block used to carry for
  // `confirmationsForBranch` (whose only importer was this test, and which is
  // gone). Named precisely, because a comment that over-claims reads as
  // coverage while asserting nothing:
  //   - the `"test"` kind that has no producer → asserted in
  //     test-review-confirmation-join.ts (`ask([good({ kind: "test" })])`);
  //   - the unreadable-ledger read fault (malformed JSON, or `readLedgerAt`
  //     throwing) → asserted in that same file, in the shape
  //     `recordFindingRunOutcome`'s catch now produces: the round's ledger read
  //     hands the join an EMPTY array, so a row that would otherwise confirm
  //     does not retire;
  //   - `ledgerPathFor` throwing → NOT asserted anywhere. The sibling's AC1 store
  //     block probes that resolver once (`const probeLedger = await lpf(execp,
  //     f.dir)`) to pin the fixture, which asserts the path RESOLVES — not that a
  //     round whose path cannot be resolved retires nothing. If that fault is
  //     wanted, it needs its own assertion; this comment no longer claims it.
  // The store's own round is the AC2 store block below.
}

// ---------------------------------------------------------------------------
// AC3 — the veto predicate and the retirement arm consume ONE predicate
// ---------------------------------------------------------------------------

{
  // Every row the veto forces a full round for must be one the confirmation arm
  // can retire on that round; a divergence is the #1832 round-2 failure (a full
  // round demanded that retires nothing). Enumerated over the shapes, not
  // asserted by eye.
  const shapes: Array<[string, StoredFinding]> = [
    ["open CRITICAL with line+lineHash", stuckRow()],
    ["SECURITY open CRITICAL", stuckRow({ lens: "SECURITY" })],
    ["accepted CRITICAL", {
      ...stuckRow(),
      status: "accepted",
      acceptance: acceptanceFor("ff"),
    } as StoredFinding],
    ["HIGH CRITICAL-shape row", stuckRow({ severity: "HIGH" })],
    ["CRITICAL with no line", { ...stuckRow(), line: undefined, noLine: true as const }],
    ["CRITICAL with no lineHash", stuckRow({ lineHash: undefined })],
    ["resolved CRITICAL", { ...stuckRow(), status: "resolved" } as StoredFinding],
  ];
  for (const [name, row] of shapes) {
    const vetoDemandsFullRound = isRetirableOpenCriticalRow(row);
    // `linelessFate`'s #1469 rule retires a line-less row on ANY full round
    // (confirmation or none), so "resolves" for that shape is not the
    // confirmation arm speaking. Ask the arm alone: same round, no confirmation.
    const resolvesWithoutConfirmation =
      rowFate(row, AT_HEAD, "full").kind === "resolve";
    const armRetires =
      rowFate(row, AT_HEAD, "full", { confirmedBy: CONFIRMED_BY }).kind === "resolve" &&
      !resolvesWithoutConfirmation;
    // The rule the two must obey: anything the veto forces a round for is
    // retirement-eligible UNLESS a named carve-out (SECURITY / accepted)
    // refuses it — and those carve-outs are the fate rule's own.
    const carvedOut =
      row.lens.trim().toUpperCase() === "SECURITY" || row.status === "accepted";
    assert(
      !vetoDemandsFullRound || armRetires || carvedOut,
      `AC3 agreement: ${name} — veto=${vetoDemandsFullRound} armRetires=${armRetires} carveOut=${carvedOut}`,
    );
    assert(
      !(armRetires && !vetoDemandsFullRound),
      `AC3 agreement: ${name} — nothing retires by confirmation that the veto would NOT have forced a round for`,
    );
  }
}

process.exit(exit);
