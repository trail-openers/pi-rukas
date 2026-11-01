#!/usr/bin/env bun
/**
 * #1934 — the confirmation JOIN, asserted where production reaches it.
 *
 * Split out of test-review-findings-confirmed-retire.ts for the AGENTS.md §12
 * 500-line gate: that file carries the pure fate rule, the query's refusals and
 * the store-side AC1/AC2/AC4 rounds, and the join's own unit + store assertions
 * pushed it over the cap. The split is along a real seam — everything here is
 * the #1934 wire, not the pre-#1934 rules.
 *
 * **Why these assertions and not the sibling's.** The store-side AC1 assertion
 * ("a bound adversarial row retires a re-reported CRITICAL with provenance")
 * passed even with `applyFindingRound` NOT threading its own row ids into the
 * `confirmationsFor` join: a ledger whose single row already names that row
 * needs no bound, so the assertion exercised the fate rule while the join itself
 * went untested — exactly the gap the review gate warned about ("the feature
 * can ship inert and pass"). The `join:` assertions below drive the real store
 * with a second adversarial row for a row the round does NOT hold, stamped
 * LATER than the one it does. `confirmationsFor` keeps one row per confirming
 * kind, so without the bound that stale row wins the race and the round's own
 * confirmation is never consulted: they are the assertions that go RED when the
 * wire in review-findings-round.ts is reverted, and the sibling's stay green.
 *
 * Also asserted here: `"test"` is not a confirming kind. The kind has no
 * producer — `validEntries` (review-ledger-read.ts) drops any kind outside
 * `adversarial|lens` — so `CONFIRMING_KINDS` (review-confirmation.ts) lists only
 * what production writes. Re-adding it without first shipping the lean-`toolPath`
 * writer reddens this file, which is what keeps a dead path from being mistaken
 * for a shipped one. That writer is the change that edits both together.
 *
 * Isolation follows its sibling: `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pins BOTH the
 * ledger and the findings store into the fixture dir, so a round reads and writes
 * only this test's files.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Finding } from "../src/lens-review-types.ts";
import { confirmationsFor } from "../src/review-confirmation.ts";
import type { LedgerEntry } from "../src/review-ledger-entry.ts";
import { lineHashAt, snippetHashAt } from "../src/review-findings-match.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import { readBranchRows, recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { readLedgerAt } from "../src/review-ledger-read.ts";
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
/** The row the store-side round files, and the id its confirmation must name. */
const ROW = "abcd1234";
/** A row id no round ever holds — the stale ledger row's join key. */
const STALE_ROW = "eeee1111";
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
  rowId: ROW,
  ...over,
});
const ask = (
  entries: readonly LedgerEntry[],
  id = PATCH,
  sha = HEAD_SHA,
  seen = SEEN,
  rowIds?: ReadonlySet<string>,
) => confirmationsFor(entries, "feature/work", { patchId: id, headSha: sha }, seen, rowIds);

// ---------------------------------------------------------------------------
// The join is bounded by the rows the round holds
// ---------------------------------------------------------------------------

{
  assert(
    ask([good()], PATCH, HEAD_SHA, SEEN, new Set([ROW])).get(ROW) !== undefined,
    "join: a bound confirmation for a row the round holds answers",
  );
  assert(
    ask([good()], PATCH, HEAD_SHA, SEEN, new Set(["ffff0000"])).size === 0,
    "join: a confirmation for a row this round does NOT hold answers nothing",
  );
  // The race the bound exists for: `best` keeps one row per kind, so a stale
  // rowId that wins it must not hide a binding confirmation recorded under it
  // for a row the round does hold. End-to-end at the production path below.
  const stale = good({ at: 1900, rowId: STALE_ROW });
  assert(
    ask([stale, good()], PATCH, HEAD_SHA, SEEN, new Set([ROW])).get(ROW) !== undefined,
    "join: a stale rowId cannot win the per-kind race and hide the round's own confirmation",
  );
  assert(
    ask([stale], PATCH, HEAD_SHA, SEEN, new Set([ROW])).size === 0,
    "join: and the stale rowId alone confirms nothing",
  );
  assert(
    ask([good()], PATCH, HEAD_SHA, SEEN, undefined).get(ROW) !== undefined,
    "join: an unthreaded join keeps its pre-#1934 behaviour (no caller that omits ids changes)",
  );
}

// ---------------------------------------------------------------------------
// `"test"` is not a confirming kind — nothing writes it, so it confirms nothing
// ---------------------------------------------------------------------------

{
  // Shaped exactly like a real adversarial row: the only difference is `kind`,
  // so a refusal here is the constant's answer and not a malformed row's.
  assert(
    ask([good({ kind: "test" as LedgerEntry["kind"] })]).size === 0,
    "kind: a passing \"test\" row is NOT a confirming kind — no producer writes it",
  );
  assert(
    ask([good({ kind: "test" as LedgerEntry["kind"] })], PATCH, HEAD_SHA, SEEN, new Set([ROW]))
      .size === 0,
    "kind: and the bound does not rescue a \"test\" row",
  );
}

// ---------------------------------------------------------------------------
// The join at the production path: a real round over a real clone
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "conf-join-"));
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
  // no patch id, and a round with no identity consults no confirmation.
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
  // `git rev-parse --git-common-dir` answer is resolved against `cwd`.
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

/** A row whose cited line still exists at head, byte for byte. */
function stuckRow(id: string): StoredFinding {
  return {
    id,
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
  };
}

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

/** A full round that re-reports the finding, with confirmations consulted. */
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
  const f = makeFixture();
  try {
    const row = await seed(f.dir, f.headSha);
    // The shape the join must answer for, asserted rather than assumed: the
    // cited line is byte-unchanged at head, so nothing but a confirmation can
    // retire this row.
    assert(
      row.lineHash === stuckRow(row.id).lineHash && row.status === "open",
      "join store: the seeded row is open with the unchanged-cited-line hash",
    );
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "join store: the review identity resolved");
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
      {
        branch: "feature/work",
        kind: "adversarial",
        patchId: pid,
        passed: true,
        // Later than the row the round holds: this is what the unbounded join
        // keeps as the kind's `best`, so the round's own row never gets asked.
        at: Date.now() + 500,
        headSha: f.headSha,
        rowId: STALE_ROW,
      },
    ]);
    const out = await reReport(f.dir, f.headSha, pid!);
    const after = (await readBranchRows(f.dir, "feature/work")).find((r) => r.id === row.id);
    assert(
      out.ok && after?.status === "resolved" && after.resolvedReason === "confirmed",
      `join store: a stale rowId cannot hide the round's own confirmation (${after?.status}/${after?.resolvedReason})`,
    );
    assert(
      typeof after?.confirmedBy === "string" &&
        after.confirmedBy.includes(`#${row.id}`) &&
        /patch=/.test(after.confirmedBy) &&
        /head=/.test(after.confirmedBy),
      `join store: the provenance names THIS round's row and the reviewed commit (got ${JSON.stringify(after?.confirmedBy)})`,
    );
  } finally {
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    delete process.env.PI_AGENT_DIR;
    resetFindingsStateCache();
    rmSync(f.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// An UNREADABLE ledger is not a confirmation — asserted in the shape the store's
// own catch produces
// ---------------------------------------------------------------------------

{
  // The assertion this file's split was reported as having inherited, and had
  // not: the retired `confirmationsForBranch` used to be asserted against a
  // `readLedgerAt` that threw (malformed JSON / unreadable file). That read now
  // lives in `recordFindingRunOutcome` (review-findings-store.ts), whose catch
  // leaves `ledgerRows` at `[]` and still passes `confirmations`, so the shape
  // that matters is not "the reader throws" — it is "the join is handed an EMPTY
  // array". This block drives exactly that: the same fixture as the AC1 store
  // block above, with the ledger file the round resolves to made unreadable
  // while the review identity still resolves. `readLedgerAt` swallows the fs
  // fault (`readLedgerFileSafe`), so the round reaches the join with no rows.
  const f = makeFixture();
  try {
    const row = await seed(f.dir, f.headSha);
    // The identity the round will key on, and the row it would confirm: both
    // come from the fixture's own accessors, so the ONLY difference from the
    // green case above is the read fault — a red below cannot be blamed on a
    // mismatched patch id or a stale `seen` window.
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(
      pid !== undefined,
      "fault: the review identity resolved for the unreadable-ledger round",
    );
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
    // The fault itself: a file that exists whose bytes cannot be read. 0o000
    // makes `readFileSync` throw EACCES for any user who is not the file's
    // owner; the assert below is what stops a run that ignores 0o000 from
    // silently asserting nothing.
    chmodSync(f.ledgerFile, 0o000);
    let readable = true;
    try {
      readFileSync(f.ledgerFile, "utf8");
    } catch {
      readable = false;
    }
    assert(
      !readable,
      `fault: the fixture's ledger really is unreadable before the round (readable=${readable})`,
    );
    assert(
      readLedgerAt(f.ledgerFile).length === 0,
      "fault: the store's own reader answers an unreadable ledger with NO rows",
    );
    const out = await reReport(f.dir, f.headSha, pid!);
    const after = (await readBranchRows(f.dir, "feature/work")).find((r) => r.id === row.id);
    assert(
      out.ok && after?.status === "open",
      `unreadable ledger: the round still records, and the row the ledger would have confirmed stays open (${out.ok ? after?.status : out.reason})`,
    );
    assert(
      after?.resolvedReason === undefined && after?.confirmedBy === undefined,
      `unreadable ledger: nothing is retired on bytes nobody read — no reason, no provenance (${JSON.stringify([after?.status, after?.resolvedReason, after?.confirmedBy])})`,
    );
  } finally {
    try {
      chmodSync(f.ledgerFile, 0o600);
    } catch {
      // The dir removal below owns the file either way.
    }
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    delete process.env.PI_AGENT_DIR;
    resetFindingsStateCache();
    rmSync(f.root, { recursive: true, force: true });
  }
}

process.exit(exit);