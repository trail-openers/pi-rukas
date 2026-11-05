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
  okFixture,
  recordFindingRunOutcome,
  releaseFixture,
  removeFixture,
  reReport,
  rowsOf,
  rowsOk,
  seed,
  seedOk,
  setupOk,
  writeLedger,
  type SeedResult,
  type SetupOutcome,
} from "./lib/confirmation-store-fixture.ts";
import { parseFindingsFile, splitRows } from "../src/review-findings-file.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
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

/** The setup channels this file's cases use: a fault is a NAMED RED plus a
 * `break` out of the case's labelled block, never a `throw`. Bound to this
 * file's own `assert` because a helper module cannot own a test file's exit code
 * (an imported test file runs its top level, and its `process.exit`, inside the
 * importer). `throw`ing is what this replaces: these calls sit before the case's
 * `try` is entered, so the exception escaped the file and the run reported ZERO
 * `✗` lines while the cases after the fault silently did not run — measured on
 * the pre-channel shape: 2 lines printed, remaining cases absent. */
const needSeed = (s: SeedResult, label: string) => seedOk(s, label, (m) => assert(false, m));
const needRows = (
  r: { rows: StoredFinding[]; problem: string },
  label: string,
): r is { rows: StoredFinding[]; problem: "" } => rowsOk(r, label, (m) => assert(false, m));
const needRound = (o: SetupOutcome, label: string) =>
  setupOk(o, label, (m) => assert(false, m));

store_case: {
  // AC1 through the store: the row is re-reported every round, its cited line
  // never changes, and a bound adversarial row retires it with provenance.
  const f = makeFixture();
  try {
    if (!okFixture(f, "AC1 store", (m) => assert(false, m))) break store_case;
    const seeded = await seed(f.dir, f.headSha);
    if (!needSeed(seeded, "AC1 store: seed")) break store_case;
    const row = seeded.row;
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
        patchId: pid!,
        passed: true,
        at: Date.now(),
        headSha: f.headSha,
        rowId: row.id,
        round: 2,
      },
    ]);
    const out = await reReport(f.dir, f.headSha, pid!);
    assert(needRound(out, "AC1 store: re-report"), `AC1 store: the round recorded (${out.problem || "ok"})`);
    if (!needRound(out, "AC1 store: re-report")) break store_case;
    const read1 = await rowsOf(f.dir);
    if (!needRows(read1, "AC1 store: read after re-report")) break store_case;
    const after = read1.rows.find((r) => r.id === row.id);
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
    // A round that did not record has no lapse list to report, so the arms below
    // are read through the recorded arm only: the shared channel reports a
    // non-recording round as a named red and skips the case rather than throwing
    // past this block's `finally`.
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
    if (!second.ok) break store_case;
    const read2 = await rowsOf(f.dir);
    if (!needRows(read2, "AC4 store: read after reopen")) break store_case;
    const again = read2.rows.find((r) => r.id === row.id);
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
    releaseFixture(f);
    removeFixture(f);
  }
  break store_case;
}

// Labelled, not bare: every case block in this file is labelled so a setup
// fault skips the rest of the case with `break <label>`. A bare `{` makes that
// `break` a syntax error, so the next person who adds a skip path here
// discovers the convention by being unable to write it.
validator_case: {
  // #1934 — the RUNTIME half of the `StoredFinding` split, which the type cannot
  // provide a witness for. A row read off disk arrives through `JSON.parse`, so
  // the compiler never sees it: `open` + `resolvedReason: "confirmed"` + a
  // `confirmedBy` is a shape a hand-edited or corrupted store can hold, and the
  // three-arm union would let `confirmedBy` sit on an open row that no code ever
  // wrote. `rowProblem` refuses it, and a refusal nobody reddens is a refusal
  // nobody verified: removing that clause leaves every other test in the suite
  // green, which is how a validation gate ships as decoration.
  const bad = (over: Record<string, unknown>) => ({
    id: "r1", branch: "b", path: "src/a.ts", anchor: "a", titleClass: "t", title: "T",
    severity: "CRITICAL", lens: "PERFORMANCE", line: 3, snippetHash: "h", lineHash: "l",
    firstSeen: 1, lastSeen: 2, ...over,
  });
  const refusals: Array<[string, Record<string, unknown>, boolean]> = [
    ["open + confirmed + provenance", bad({ status: "open", resolvedReason: "confirmed", confirmedBy: "adv#r1 patch=aa" }), true],
    ["open + provenance alone", bad({ status: "open", confirmedBy: "adv#r1 patch=aa" }), true],
    ["accepted + provenance", bad({ status: "accepted", confirmedBy: "adv#r1 patch=aa" }), true],
    // The legal shapes, so the clause above cannot be satisfied by refusing
    // EVERYTHING: a legitimate retirement and a plain open row both still read.
    ["resolved + confirmed + provenance", bad({ status: "resolved", resolvedReason: "confirmed", confirmedBy: "adv#r1 patch=aa" }), false],
    ["plain open", bad({ status: "open" }), false],
    ["accepted without provenance", bad({ status: "accepted", acceptance: { by: "author", reason: "wontfix", at: 2, snippetHash: "h" } }), false],
    // #2040 — the two cap spellings and the evidence field. `unproven` is a
    // value the merge path now writes, so a validator that still refuses it
    // copies every capped row aside as malformed and the operator loses the
    // finding AND its suppression. The reverse direction matters equally: a row
    // claiming some other cap spelling was edited by hand and is not readable.
    ["unproven cap marker", bad({ status: "open", severityCapped: "unproven", severity: "MEDIUM" }), false],
    ["test-path cap marker", bad({ status: "open", severityCapped: "test-path", severity: "MEDIUM" }), false],
    ["unknown cap marker", bad({ status: "open", severityCapped: "because-i-said-so" }), true],
    ["a two-string reproduction", bad({ status: "open", reproduction: { command: "bun test", observed: "1 fail" } }), false],
    ["a reproduction that is a string", bad({ status: "open", reproduction: "bun test" }), true],
    ["a reproduction missing observed", bad({ status: "open", reproduction: { command: "bun test" } }), true],
    ["a reproduction with a non-string field", bad({ status: "open", reproduction: { command: 1, observed: "x" } }), true],
  ];
  for (const [label, row, expectRefused] of refusals) {
    const r = splitRows([row]);
    const refused = r.malformed.length === 1 && r.rows.length === 0;
    assert(
      refused === expectRefused,
      `#1934 validator: ${label} ${expectRefused ? "is refused" : "is accepted"} (${JSON.stringify({ rows: r.rows.length, malformed: r.malformed.length })})`,
    );
  }
  break validator_case;
}

ac2_case: {
  // AC2 through the store: an UNBOUND confirmation retires nothing.
  const f = makeFixture();
  try {
    if (!okFixture(f, "AC2 store", (m) => assert(false, m))) break ac2_case;
    const seeded = await seed(f.dir, f.headSha);
    if (!needSeed(seeded, "AC2 store: seed")) break ac2_case;
    const row = seeded.row;
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
    assert(needRound(out, "AC2 store: re-report"), "AC2 store: the round recorded");
    if (!needRound(out, "AC2 store: re-report")) break ac2_case;
    const read = await rowsOf(f.dir);
    if (!needRows(read, "AC2 store: read")) break ac2_case;
    const after = read.rows.find((r) => r.id === row.id);
    assert(
      after?.status === "open" && after.resolvedReason === undefined,
      `AC2 store: a mismatched patchId retires NOTHING — the row carries exactly as today (${after?.status}/${after?.resolvedReason})`,
    );
    assert(
      after?.confirmationLapsed === undefined,
      "AC2 store: and no lapse field appears on a row nobody ever retired",
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
  break ac2_case;
}

process.exit(exit);
