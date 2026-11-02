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

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { confirmationsFor } from "../src/review-confirmation.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import { lineHashAt, snippetHashAt } from "../src/review-findings-match.ts";
import { readBranchRows } from "../src/review-findings-store.ts";
import type { LedgerEntry } from "../src/review-ledger-entry.ts";
import { readLedgerAt } from "../src/review-ledger-read.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";
import { findingsStateDir, resetFindingsStateCache } from "../src/review-state-path.ts";
// The SAME store-shaped fixture the three sibling confirmation tests build: its
// `makeFixture` records BOTH env pins and its `releaseFixture` writes them back,
// which is what makes nesting a fixture safe. This file used to carry its own
// copy of the clone recipe, and that copy deleted both pins on teardown — see
// the nesting witness below.
import type { FixtureEnv } from "./lib/confirmation-store-fixture.ts";
import {
  CITED,
  FINDING,
  HEAD_LINES,
  makeFixture,
  reReport,
  releaseFixture,
  removeFixture,
  seed,
  writeLedger,
} from "./lib/confirmation-store-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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
    'kind: a passing "test" row is NOT a confirming kind — no producer writes it',
  );
  assert(
    ask([good({ kind: "test" as LedgerEntry["kind"] })], PATCH, HEAD_SHA, SEEN, new Set([ROW]))
      .size === 0,
    'kind: and the bound does not rescue a "test" row',
  );
}

// ---------------------------------------------------------------------------
// The fixture's env pins are restorable, not destructive.
//
// `makeFixture` pins BOTH `PI_ENSEMBLE_REVIEW_LEDGER_FILE` (which also pins the
// findings store — `review-state-path.ts` resolves the store beside the override)
// and `PI_AGENT_DIR`. A teardown that DELETES both instead of restoring them
// hands whatever scope is holding those pins back to the process, and the next
// round resolves the store at the real `~/.pi/agent` and the ledger at the
// clone's real git common dir. Nothing throws; the rows are simply written
// outside the fixture, so an assertion that only reads env strings accepts any
// assignment that happens to look right. Each arm below therefore asserts WHERE
// THE BYTES LANDED, and each is in its own block because an assertion inside a
// `finally` whose pins were just restored can be satisfied by the restoration
// rather than by the behaviour under test.
//
// The shape this replaced was this file's own private copy of the clone recipe,
// whose teardown was `delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE` plus
// `delete process.env.PI_AGENT_DIR` — exactly the defect `fa63e18d` closed in the
// shared fixture while this copy stayed open. `destructiveRelease` is that
// teardown, kept here as the counter-behaviour both arms measure against.
// ---------------------------------------------------------------------------

/** The teardown this file's private fixture had: both pins gone, whatever the
 * fixture recorded. Typed by the shared fixture's own record shape, so it is a
 * counterpart to `releaseFixture` and not a free-floating pair of `delete`s.
 *
 * `delete` and nothing else. Biome's `noDelete` autofix rewrites these to an
 * assignment of the `undefined` LITERAL to an env key, which on bun does NOT
 * remove the variable — it stores the 9-character string "undefined", which
 * every consumer here reads through `?.trim()` and therefore treats as a real
 * value. The contiguous dot-form is not written out here because this repo's
 * own env-clear ratchet (`test-env-clear-gate.ts`) scans comments too and would
 * redden on the explanation of the very trap it forbids. The override would
 * stay "set" to a file nobody can open, and this witness would go green having
 * measured nothing. The rule is suppressed rather than the behaviour changed. */
function destructiveRelease(f: { priorEnv: FixtureEnv }): void {
  // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined" on bun; only `delete` unsets
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  // biome-ignore lint/performance/noDelete: same reason — the string "undefined" is a truthy override to an unreadable file
  delete process.env.PI_AGENT_DIR;
  resetFindingsStateCache();
}

{
  // ARM A — the shared `releaseFixture` nests. Outer fixture, inner fixture, and
  // the inner's release must hand the OUTER its pins back. Red against a release
  // that deletes: `ledger=undefined` is the unpinning, and the round after it is
  // what proves the unpinning cost bytes rather than a string.
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "host-ledger-join-"));
  const hostLedger = path.join(hostDir, "ledger.json");
  const hostAgent = path.join(hostDir, "agent");
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = hostLedger;
  process.env.PI_AGENT_DIR = hostAgent;
  resetFindingsStateCache();
  const outer = makeFixture();
  try {
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === outer.ledgerFile &&
        process.env.PI_AGENT_DIR === path.join(outer.root, "agent"),
      `env: makeFixture pins the ledger and the agent dir into its own fixture (${process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE})`,
    );
    const inner = makeFixture();
    try {
      assert(
        process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === inner.ledgerFile,
        "env: the inner fixture re-pins the ledger to its own dir",
      );
    } finally {
      releaseFixture(inner);
      removeFixture(inner);
    }
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === outer.ledgerFile &&
        process.env.PI_AGENT_DIR === path.join(outer.root, "agent"),
      `env: the inner releaseFixture restores the OUTER fixture's pins (ledger=${String(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${String(process.env.PI_AGENT_DIR)})`,
    );
    const pid = (await workingTreePatchId(execp, outer.dir)).patchId;
    assert(pid !== undefined, "env: the outer round's review identity resolved");
    const row = await seed(outer.dir, outer.headSha);
    assert(
      (await readBranchRows(outer.dir, "feature/work")).some((r) => r.id === row.id),
      "env: the outer fixture's store still round-trips after the inner release",
    );
    assert(
      existsSync(hostLedger) === false && existsSync(hostAgent) === false,
      `env: ARM A leaked nothing to the host paths (${hostLedger}, ${hostAgent})`,
    );
  } finally {
    // The two-branch restore. On bun an assignment of `undefined` does NOT
    // remove the variable — it stores the literal string "undefined", which
    // every consumer reading the pin through `?.trim()` treats as a truthy
    // path, so the teardown would leave the process pinned at a file named
    // `undefined`. `delete` is the only shape that unsets.
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(outer);
    rmSync(hostDir, { recursive: true, force: true });
  }
}

{
  // ARM B — what the destructive teardown does to a REAL round. An outer round
  // seeds a row and a ledger entry while correctly pinned, the inner fixture's
  // teardown then runs the DESTRUCTIVE release (this file's old shape), and the
  // assertions measure where the NEXT round's store resolves. This arm cannot
  // assert the leaked bytes without writing them to the developer's real agent
  // dir — the damage it is reporting — so it asserts the relocation, and ARM A is
  // the arm that asserts the fix.
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "host-ledger-join-"));
  const hostLedger = path.join(hostDir, "ledger.json");
  const hostAgent = path.join(hostDir, "agent");
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = hostLedger;
  process.env.PI_AGENT_DIR = hostAgent;
  resetFindingsStateCache();
  const outer = makeFixture();
  try {
    const first = await seed(outer.dir, outer.headSha);
    const pid = (await workingTreePatchId(execp, outer.dir)).patchId;
    assert(pid !== undefined, "env: the outer round's review identity resolved");
    // Non-empty BEFORE the inner teardown, so "the fixture's file" and "the
    // host's file" are two different observable states, not two absences.
    writeLedger(outer.ledgerFile, [
      {
        branch: "feature/work",
        kind: "adversarial",
        patchId: pid!,
        passed: true,
        at: 1500,
        headSha: outer.headSha,
        rowId: first.id,
      },
    ]);
    const inner = makeFixture();
    try {
      assert(
        process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === inner.ledgerFile,
        "env: the inner fixture re-pins the ledger to its own dir",
      );
    } finally {
      destructiveRelease(inner);
      removeFixture(inner);
    }
    const leaky =
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE !== outer.ledgerFile ||
      process.env.PI_AGENT_DIR !== path.join(outer.root, "agent");
    assert(
      leaky,
      "env: ARM B's teardown really unpinned the process (witness that the harm is being measured, not imagined)",
    );
    // What the destructive teardown actually does, in the only form a test can
    // observe without committing the damage it is reporting. With the pins gone
    // the next round resolves its store at `findingsStateDir` with no override at
    // all, which is the developer's real `~/.pi/agent`; asserting bytes are
    // present there would WRITE them, so the assertion is the relocation itself.
    //
    // The `undefined` arms are not decoration and neither is the `"undefined"`
    // arm: bun stores the literal string for an `= undefined` assignment, and
    // every consumer reads the override through `?.trim()`, so a teardown that
    // assigned instead of deleting leaves the pin "set" and the store inside the
    // fixture. That arm is therefore red under an `= undefined` teardown and green
    // under a real `delete` — it is the guard on the one edit that would silently
    // defuse this whole block.
    const unPinnedStore = await findingsStateDir(execp, outer.dir);
    const pinsGone =
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === undefined &&
      process.env.PI_AGENT_DIR === undefined;
    const pinsStringified =
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === "undefined" ||
      process.env.PI_AGENT_DIR === "undefined";
    assert(
      pinsGone,
      `env: the destructive teardown really UNSET both pins (ledger=${JSON.stringify(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${JSON.stringify(process.env.PI_AGENT_DIR)})`,
    );
    assert(
      !pinsStringified,
      `env: no pin was left holding the literal string "undefined" — an =-undefined teardown rather than a delete (${JSON.stringify([process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE, process.env.PI_AGENT_DIR])})`,
    );
    assert(
      unPinnedStore !== undefined && unPinnedStore.dir !== path.dirname(outer.ledgerFile),
      `env: with the pins deleted the outer round's store relocates OUT of the fixture (${unPinnedStore?.file ?? "no location"})`,
    );
    assert(
      existsSync(hostLedger) === false,
      `env: and the host override file that was in place before the leak stayed untouched (${hostLedger})`,
    );
  } finally {
    // The two-branch restore. On bun an assignment of `undefined` does NOT
    // remove the variable — it stores the literal string "undefined", which
    // every consumer reading the pin through `?.trim()` treats as a truthy
    // path, so the teardown would leave the process pinned at a file named
    // `undefined`. `delete` is the only shape that unsets.
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(outer);
    rmSync(hostDir, { recursive: true, force: true });
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
    assert(pid !== undefined, "fault: the review identity resolved for the unreadable-ledger round");
    // `!` because the line above IS the check: `assert` records the red and the
    // exit code, and this narrowing carries that already-recorded fact into the
    // type rather than pretending an unchecked value is checked.
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
    releaseFixture(f);
    removeFixture(f);
  }
}

process.exit(exit);
