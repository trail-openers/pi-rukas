#!/usr/bin/env bun
/**
 * #1934 — the confirmation path THROUGH THE REAL STORE on a real clone: AC1 (a
 * bound adversarial row retires a re-reported CRITICAL, with provenance), AC4
 * (the retirement is re-evaluated every round and lapses openly), and AC2 (an
 * unbound confirmation retires nothing).
 *
 * Split out of test-review-findings-confirmed-retire.ts for the AGENTS.md §12
 * 500-line gate, along the seam that already existed inside that file: the pure
 * rule and the query stay there, the rounds that DRIVE THE STORE come here, and
 * all three build the same fixture from lib/confirmation-store-fixture.ts.
 * Splitting along that seam is what makes each half small enough to read; it is
 * not a truncation of any assertion — every `assert` moved with its block.
 *
 * Isolation comes from the shared fixture: `PI_ENSEMBLE_REVIEW_LEDGER_FILE`
 * pins both the ledger and the findings store into the fixture dir, so a round
 * reads and writes only this test's files, and the ledger a confirmation is
 * read from is a file this test wrote.
 */

import {
  CITED,
  FINDING,
  HEAD_LINES,
  git,
  makeFixture,
  recordFindingRunOutcome,
  releaseFixture,
  removeFixture,
  reReport,
  rowsOf,
  seed,
  writeLedger,
} from "./lib/confirmation-store-fixture.ts";
import { parseFindingsFile } from "../src/review-findings-file.ts";
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

{
  // AC1 through the store: the row is re-reported every round, its cited line
  // never changes, and a bound adversarial row retires it with provenance.
  const f = makeFixture();
  try {
    const row = await seed(f.dir, f.headSha);
    assert(
      row.lineHash !== undefined && row.status === "open",
      "AC1 store: the seeded row is open and hash-bearing",
    );
    // The cited line is byte-unchanged at head — assert it, don't assume it.
    const atHead = git(f.dir, "show", `${f.headSha}:src/a.ts`).split("\n");
    assert(
      atHead[CITED - 1] === HEAD_LINES[CITED - 1],
      "AC1 store: the cited line is BYTE-UNCHANGED at the reviewed head",
    );
    // The identity the round under test computes, taken from the SAME accessor
    // the store uses for its own ledger read — the override-aware one, not a
    // direct `workingTreePatchId` call whose result could disagree with the
    // round's (which is precisely the cross-writer mismatch AC2 refuses).
    const { ledgerPathFor: lpf, readLedgerAt: rla } = await import("../src/review-ledger.ts");
    const probeLedger = await lpf(execp, f.dir);
    assert(probeLedger === f.ledgerFile, `fixture: the round's ledger resolves to the fixture file (${probeLedger})`);
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "fixture: the review identity resolved");
    // Round 2 re-reports the finding (so `hasCritical` would be true) and a
    // passing adversarial row bound to this commit exists.
    writeLedger(f.ledgerFile, [
      {
        branch: "feature/work",
        kind: "adversarial",
        patchId: pid,
        passed: true,
        at: Date.now(),
        headSha: f.headSha,
        rowId: row.id,
        round: 2,
      },
    ]);
    const out = await reReport(f.dir, f.headSha, pid!);
    assert(out.ok, `AC1 store: the round recorded (${out.ok ? "" : out.reason})`);
    const after = (await rowsOf(f.dir)).find((r) => r.id === row.id);
    assert(
      after?.status === "resolved" && after.resolvedReason === "confirmed",
      `AC1 store: the re-reported row is resolved as "confirmed" (${after?.status}/${after?.resolvedReason})`,
    );
    assert(
      typeof after?.confirmedBy === "string" && after.confirmedBy.length > 0,
      `AC1 store: the retirement carries non-empty provenance (got ${JSON.stringify(after?.confirmedBy)})`,
    );
    // AC4: the confirmation is re-evaluated per round, never latched. A row that
    // was retired by a confirmation and whose cited code is STILL THERE is a row
    // the confirmation no longer describes: the next full round re-opens it
    // through the ordinary reopen path, with its line and hashes intact, and
    // stamps it `confirmationLapsed` instead of leaving the retirement standing.
    writeLedger(f.ledgerFile, [
      {
        branch: "feature/work",
        kind: "adversarial",
        patchId: "stale",
        passed: true,
        at: Date.now(),
        headSha: f.headSha,
        rowId: row.id,
      },
    ]);
    // Narrowed by the assert below (`second.ok`): a round that did not record has
    // no lapse list to report, so the arm it must be read through is the `ok` arm.
    const second = await recordFindingRunOutcome({
      cwd: f.dir,
      branch: "feature/work",
      headSha: f.headSha,
      // The finding is reported again — its code never left the file.
      findings: [FINDING],
      review: "full",
      confirmFixes: true,
      // A DIFFERENT patchId than the one the ledger row binds to: this is the
      // round that reviewed other code, so the stored retirement is no longer
      // evidence about the commit under review.
      patchId: "a-different-patch-not-the-reviewed-one",
      now: Date.now() + 20_000,
    });
    assert(second.ok, "AC4 store: the follow-up round recorded");
    if (!second.ok) throw new Error(`AC4 store: ${second.reason}`);
    const again = (await rowsOf(f.dir)).find((r) => r.id === row.id);
    assert(
      again?.status === "open" && again.line === CITED && again.lineHash === row.lineHash,
      `AC4 store: the next round re-opens the row and leaves line+hashes UNCHANGED (${again?.status}, line ${again?.line})`,
    );
    // The row cannot carry the provenance itself: the file's schema refuses
    // `confirmedBy` on a row that is not resolved as confirmed, and this row is
    // open again. So the disclosure is the NOTICE the round reported, whose
    // provenance names the real ledger row the earlier retirement stood on.
    assert(
      second.lapsed?.some((l) => l.rowId === row.id && /patch=/.test(l.provenance)) === true,
      `AC4 store: the round reports the lapse with its provenance (got ${JSON.stringify(second.lapsed)})`,
    );
    assert(
      again?.confirmedBy === undefined && again?.confirmationLapsed === undefined,
      "AC4 store: the reopened row carries no stale provenance and no latch (the notice, not the row, is the disclosure)",
    );
    // And the field is written to disk in the shape the reader's schema accepts.
    const file = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!.replace(
      "review-ledger.json",
      "review-findings.json",
    );
    const parsed = parseFindingsFile(file);
    assert(
      parsed.ok && parsed.malformed.length === 0,
      `AC4 store: the row with the new fields reads back VALID (not set aside as malformed)`,
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

{
  // AC2 through the store: an UNBOUND confirmation retires nothing.
  const f = makeFixture();
  try {
    const row = await seed(f.dir, f.headSha);
    writeLedger(f.ledgerFile, [
      {
        branch: "feature/work",
        kind: "adversarial",
        patchId: "a-different-patch-not-the-reviewed-one",
        passed: true,
        at: Date.now(),
        headSha: f.headSha,
        rowId: row.id,
      },
    ]);
    const out = await reReport(f.dir, f.headSha, "the-reviewed-patch-not-the-stored-one");
    assert(out.ok, "AC2 store: the round recorded");
    const after = (await rowsOf(f.dir)).find((r) => r.id === row.id);
    assert(
      after?.status === "open" && after.resolvedReason === undefined,
      `AC2 store: a mismatched patchId retires NOTHING — the row carries exactly as today (${after?.status}/${after?.resolvedReason})`,
    );
    assert(
      after?.confirmationLapsed === undefined,
      "AC2 store: and no lapse field appears on a row nobody ever retired",
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

process.exit(exit);
