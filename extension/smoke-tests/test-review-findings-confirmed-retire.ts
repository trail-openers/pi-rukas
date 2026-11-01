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

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Finding } from "../src/lens-review-types.ts";
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
import { readBranchRows, recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";
import { execp } from "../src/exec.ts";
import { resetFindingsStateCache } from "../src/review-state-path.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HEAD_LINES = [
  "// header",
  "export function a() {",
  "  return unsafe(raw);", // the cited line — never changed by any case here
  "}",
  "export const b = 2;",
];
const CITED = 3;
const AT_HEAD: HeadState = { kind: "lines", lines: HEAD_LINES };

/** A row whose cited line still exists at head, byte for byte. */
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
  };
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
      status: "accepted" as const,
      acceptance: { by: "op", reason: "x".repeat(30), at: 1, snippetHash: "ff" },
    },
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
      status: "accepted" as const,
      acceptance: { by: "op", reason: "x".repeat(30), at: 1, snippetHash: "ff" },
    }],
    ["HIGH CRITICAL-shape row", stuckRow({ severity: "HIGH" })],
    ["CRITICAL with no line", { ...stuckRow(), line: undefined, noLine: true as const }],
    ["CRITICAL with no lineHash", stuckRow({ lineHash: undefined })],
    ["resolved CRITICAL", { ...stuckRow(), status: "resolved" as const }],
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

// ---------------------------------------------------------------------------
// AC1/AC2/AC4 through the real store on a real clone
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "conf-store-"));
  const dir = path.join(root, "repo");
  mkdirSync(dir, { recursive: true });
  const ledgerFile = path.join(root, "review-ledger.json");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), `${HEAD_LINES.join("\n")}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  // `workingTreePatchId` resolves the identity against `<remote>/<mainline>`, so
  // the fixture needs the same origin the real clone has — without it there is
  // no patch id, and a round with no identity consults no confirmation (AC2's
  // answer, never AC1's).
  const origin = path.join(root, "origin.git");
  git(root, "init", "--bare", "-q", "--initial-branch=main", origin);
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "checkout", "-q", "-b", "feature/work");
  writeFileSync(path.join(dir, "src", "fix.ts"), "// the fix, in a DIFFERENT file\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix in another file");
  const headSha = git(dir, "rev-parse", "HEAD");
  // The env is pointed at THIS fixture only after every git call: a relative
  // `git rev-parse --git-common-dir` answer is resolved against `cwd`, so a
  // fixture that set the override first would key its store on a path under a
  // different directory than the one it writes to.
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  process.env.PI_AGENT_DIR = path.join(root, "agent");
  resetFindingsStateCache();
  return { root, dir, ledgerFile, headSha };
}

/** The finding round 1 files; identical line/path/title so round 2 re-reports it. */
const FINDING: Finding = {
  lens: "PERFORMANCE",
  severity: "CRITICAL",
  path: "src/a.ts",
  line: CITED,
  title: "Unvalidated input reaches the executor",
};

function writeLedger(file: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
}

/** Seed an open CRITICAL row through the real store (real hashes, real ids). */
async function seed(dir: string, headSha: string) {
  const out = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
  });
  if (!out.ok) throw new Error(`seed failed: ${out.reason}`);
  const rows = await readBranchRows(dir, "feature/work");
  const row = rows.find((r) => r.severity === "CRITICAL");
  if (!row) throw new Error("seed produced no CRITICAL row");
  return row;
}

/** A round that re-reports the finding, with confirmations consulted. */
async function reReport(dir: string, headSha: string, patchId: string) {
  return recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
    confirmFixes: true,
    patchId,
    now: Date.now() + 10_000,
  });
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
    const after = (await readBranchRows(f.dir, "feature/work")).find((r) => r.id === row.id);
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
    const again = (await readBranchRows(f.dir, "feature/work")).find((r) => r.id === row.id);
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
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    delete process.env.PI_AGENT_DIR;
    resetFindingsStateCache();
    rmSync(f.root, { recursive: true, force: true });
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
    const after = (await readBranchRows(f.dir, "feature/work")).find((r) => r.id === row.id);
    assert(
      after?.status === "open" && after.resolvedReason === undefined,
      `AC2 store: a mismatched patchId retires NOTHING — the row carries exactly as today (${after?.status}/${after?.resolvedReason})`,
    );
    assert(
      after?.confirmationLapsed === undefined,
      "AC2 store: and no lapse field appears on a row nobody ever retired",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    delete process.env.PI_AGENT_DIR;
    resetFindingsStateCache();
    rmSync(f.root, { recursive: true, force: true });
  }
}

process.exit(exit);
