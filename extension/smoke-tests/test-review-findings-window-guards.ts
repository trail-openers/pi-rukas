#!/usr/bin/env bun
/**
 * #1934 — witnesses for the TWO round-clock guards in `confirmedFor`'s pass and
 * the AC4 re-observation pass (`review-findings-round.ts`).
 *
 * WHY THIS FILE EXISTS. Both guards were measured as un-witnessed: deleting
 * `if (r.lastSeen >= now) return;` (the AC4 re-observation guard, `:222`) left
 * all five confirmation tests green, and relaxing either guard's `>=` to `>`
 * changed nothing under the whole suite. Two comparisons whose entire job is a
 * time ordering had no test that could see them.
 *
 * HOW THE BOUNDARY IS MADE OBSERVABLE — the round's clock is a frozen clock.
 * `recordFindingRunOutcome` takes `now`, and the store hands that same value to
 * `applyFindingRound` (review-findings-store.ts: `const now = run.now ??
 * Date.now()`, then `now,` in the round's opts). Row stamps are therefore exact
 * integers the test picks, not `Date.now()` readings. A `Date.now()` fixture
 * would make `>=` and `>` differ only by a millisecond of adjacency, which is a
 * coincidence of the clock rather than a discrimination of the operator — so
 * every case below writes its stamps as literals and the adversarial ledger row
 * is stamped at the boundary minus one.
 *
 * Four mutations, four witnesses. Each asserts the operator's boundary case
 * (`stamp === now`) AND the strictly-later case (`stamp > now`), so removing a
 * guard and relaxing it both redden here:
 *
 *   - `guard:222` DELETED  → the AC4 pass re-opens a row stamped AT the round's
 *     clock and loses the lapse notice (the row still opens via the matched
 *     pass, which is exactly why deleting the guard was invisible to the old
 *     assertions — the notice is the only observable);
 *   - `guard:222` RELAXED to `>` → that same notice vanishes for a row stamped
 *     strictly after the round's clock;
 *   - `guard:181` DELETED  → a row the round FILED retires on a confirmation
 *     stamped at its own filing instant;
 *   - `guard:181` RELAXED to `>` → that retirement survives a confirmation
 *     stamped strictly later than the filing.
 *
 * Isolation comes from the shared fixture (`lib/confirmation-store-fixture.ts`):
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pins both the ledger and the findings store
 * into the fixture dir, so a round reads and writes only this test's files.
 */

import { readFileSync } from "node:fs";
import {
  FINDING,
  HEAD_LINES,
  makeFixture,
  recordFindingRunOutcome,
  releaseFixture,
  removeFixture,
  rowsOf,
  writeLedger,
} from "./lib/confirmation-store-fixture.ts";
import { applyFindingRound } from "../src/review-findings-round.ts";
import type { Finding } from "../src/lens-review-types.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import type { LedgerEntry, LedgerFile } from "../src/review-ledger-entry.ts";
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

/** The frozen clock every case below drives its round at. */
const NOW = 500_000;
/** One round through the real store, with every clock value a literal. */
const round = async (
  dir: string,
  headSha: string,
  patchId: string,
  findings: (typeof FINDING)[],
  now: number,
) =>
  recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings,
    review: "full",
    confirmFixes: true,
    patchId,
    now,
  });

/** A passing adversarial ledger row naming `rowId`, stamped at `at`.
 * `toolPath` is non-empty on purpose: the store's own ledger read goes through
 * `readLedgerFileSafe` → `pruneExpired` (review-ledger.ts), which REWRITES the
 * file and drops any row with a blank or malformed `toolPath` — a row written
 * without it is gone before the round ever reads it, and the round then has no
 * confirmation to find. The shape is the one `recordAdversarialRun` writes. */
const confirmRow = (patchId: string, headSha: string, rowId: string, at: number) => ({
  branch: "feature/work",
  kind: "adversarial",
  patchId,
  passed: true,
  at,
  headSha,
  rowId,
  round: 2,
  toolPath: "extension/smoke-tests/test-review-findings-window-guards.ts",
});

// ---------------------------------------------------------------------------
// guard:222 — `if (r.lastSeen >= now) return;` in the AC4 re-observation pass
// ---------------------------------------------------------------------------

/** The head content the fixture's `src/a.ts` carries, so `headOf` answers with
 * the same lines the store read for the rounds above. */
const HEAD_OF = () => ({ kind: "lines" as const, lines: HEAD_LINES });

/** Retire a row through the real store, then hand back its stored bytes with
 * `lastSeen` overwritten to the caller's exact value and the ledger re-pointed
 * at an id NO round holds, so its confirmation no longer binds.
 *
 * WHY THE STAMP IS INJECTED. The store's own passes stamp a row's `lastSeen`
 * with the round's clock — the findings pass at `:322` and the untouched pass
 * at the round's `now` — so a store-driven row's `lastSeen` is always either
 * strictly before or exactly equal to a later round's clock, never in between.
 * Reaching `lastSeen` STRICTLY AFTER the next round's clock through the store
 * alone would need a clock that runs backwards, and a `Date.now()` fixture
 * cannot produce it either (the two stamps would land a millisecond apart, so
 * `>=` vs `>` would differ by clock adjacency rather than by construction). The
 * row is therefore born from a real store round — real id, real hashes, real
 * `resolved`/`confirmed` provenance — and only its `lastSeen` is moved, which
 * is the one value these two cases exist to place at the boundary.
 *
 * `confirmedBy` rides with the row because the AC4 pass reads it: no
 * provenance, no reportable lapse, and the assertion would witness nothing.
 */
async function retiredRowAtLastSeen(
  dir: string,
  headSha: string,
  patchId: string,
  lastSeen: number,
): Promise<{ row: StoredFinding; ledger: LedgerEntry[] }> {
  const filed = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
    patchId,
    now: 400_000,
  });
  if (!filed.ok) throw new Error(`filing round failed: ${filed.reason}`);
  const row = (await rowsOf(dir)).find((r) => r.title === FINDING.title);
  if (!row) throw new Error("filing round filed no row");
  writeLedger(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!, [
    confirmRow(patchId, headSha, row.id, 450_000),
  ]);
  const retire = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [],
    review: "full",
    confirmFixes: true,
    patchId,
    now: 490_000,
  });
  if (!retire.ok) throw new Error(`retire round failed: ${retire.reason}`);
  const retired = (await rowsOf(dir)).find((r) => r.id === row.id);
  if (
    retired?.status !== "resolved" ||
    retired.resolvedReason !== "confirmed" ||
    retired.confirmedBy === undefined
  ) {
    throw new Error(`setup did not retire the row (${retired?.status}/${retired?.resolvedReason})`);
  }
  const stamped: StoredFinding = { ...retired, lastSeen } as StoredFinding;
  // The confirmation now names an id NO round holds, so the join's bound
  // rejects it and this row's retirement no longer binds — which is what AC4
  // acts on.
  writeLedger(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!, [
    confirmRow(patchId, headSha, "ffffffff", 450_000),
  ]);
  // The ledger the round reads, from the file the store itself reads: written
  // with the fixture's writer and re-read here rather than reconstructed, so the
  // round's join and the file on disk cannot disagree about the row.
  const ledger = (
    JSON.parse(readFileSync(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!, "utf8")) as LedgerFile
  ).entries;
  return { row: stamped, ledger };
}

/** Drive one round over `rows` through the real entry point. `findings` is what
 * the round reports — empty for a round silent about every row, which is the
 * shape the AC4 guard's own notice is observable in. */
const runRound = (
  rows: StoredFinding[],
  findings: Finding[],
  ledger: LedgerEntry[],
  patchId: string,
  headSha: string,
) =>
  applyFindingRound({
    branch: "feature/work",
    findings,
    mine: rows,
    taken: new Set(rows.map((r) => r.id)),
    headOf: HEAD_OF,
    review: "full",
    confirmations: { ledger, patchId, headSha },
    now: NOW,
  });

{
  // The boundary itself: the retired row's `lastSeen` EQUALS the round's clock,
  // and the round is SILENT about the row. Silence is the only shape that
  // witnesses this guard: a round that re-reports the row takes it through the
  // matched pass, which stamps the lapse notice whether or not the AC4 pass ran
  // at all (measured — both mutations of this guard left a re-reporting case
  // green). With the guard in place the AC4 pass skips the row, and the round
  // reports NOTHING about it.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:222 boundary: the review identity resolved");
    const { row, ledger } = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW);
    assert(
      row.lastSeen === NOW,
      `guard:222 boundary: the row's stamp IS the round's clock (${row.lastSeen})`,
    );
    const out = runRound([row], [], ledger, pid!, f.headSha);
    assert(
      out.lapsed === undefined && row.status === "resolved",
      `guard:222 boundary: a row stamped AT the round's clock is left retired and reports no lapse (lapsed=${JSON.stringify(out.lapsed)}, status=${row.status})`,
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

{
  // The relaxation witness: the retired row's `lastSeen` is STRICTLY LATER than
  // the round's clock — a stamp no store-driven round can produce, which is why
  // the row's own stamp is injected (see `retiredRowAtLastSeen`). `>=` still
  // skips the pass; `>` runs it, re-opens the row and pushes a lapse notice.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:222 relax: the review identity resolved");
    const { row, ledger } = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW + 60_000);
    assert(
      row.lastSeen === NOW + 60_000,
      `guard:222 relax: the row's stamp is STRICTLY AFTER the round's clock (${row.lastSeen} > ${NOW})`,
    );
    const out = runRound([row], [], ledger, pid!, f.headSha);
    assert(
      out.lapsed === undefined && row.status === "resolved",
      `guard:222 relax: a row stamped STRICTLY AFTER the round's clock is left retired and reports no lapse (lapsed=${JSON.stringify(out.lapsed)}, status=${row.status})`,
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

{
  // The other side of the same guard, and the reason it is not dead code: a row
  // stamped STRICTLY BEFORE the round's clock is exactly the row AC4 exists for,
  // and the guard must NOT skip it. Without this case a `return;` stuffed into
  // the top of the pass would satisfy both witnesses above.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:222 live: the review identity resolved");
    const { row, ledger } = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW - 60_000);
    const out = runRound([row], [], ledger, pid!, f.headSha);
    assert(
      out.lapsed?.some((l) => l.rowId === row.id) === true,
      `guard:222 live: a row stamped BEFORE the round's clock IS re-opened by AC4 and reported (lapsed=${JSON.stringify(out.lapsed)})`,
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

// ---------------------------------------------------------------------------
// guard:181 — `if (r.firstSeen >= now) return undefined;` in `confirmedFor`
// ---------------------------------------------------------------------------

/** File an OPEN row through the real store at the caller's clock, then hand back
 * its stored bytes with `firstSeen` set to the caller's exact value.
 *
 * The same reason as `retiredRowAtLastSeen`: the store stamps `firstSeen` with
 * the filing round's `now`, so a store-driven row's `firstSeen` can never sit
 * STRICTLY AFTER a later round's clock — and `>=` versus `>` is only decided by
 * a case that does. The row is real (real id, real hashes, filed by a real
 * round); only its filing stamp is moved. */
async function openRowAtFirstSeen(
  dir: string,
  headSha: string,
  patchId: string,
  firstSeen: number,
): Promise<StoredFinding> {
  const filed = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
    patchId,
    now: firstSeen,
  });
  if (!filed.ok) throw new Error(`filing round failed: ${filed.reason}`);
  const row = (await rowsOf(dir)).find((r) => r.title === FINDING.title);
  if (!row) throw new Error("filing round filed no row");
  if (row.firstSeen !== firstSeen || row.status !== "open") {
    throw new Error(`filing round stamped ${row.firstSeen}/${row.status}`);
  }
  return { ...row, firstSeen } as StoredFinding;
}

/** Re-report `row` through the real entry point with a confirmation for it on
 * file, stamped at `at`. */
const reReportWithConfirmation = (
  row: StoredFinding,
  patchId: string,
  headSha: string,
  at: number,
) =>
  applyFindingRound({
    branch: "feature/work",
    findings: [FINDING],
    mine: [row],
    taken: new Set([row.id]),
    headOf: HEAD_OF,
    review: "full",
    confirmations: {
      ledger: [confirmRow(patchId, headSha, row.id, at)] as LedgerEntry[],
      patchId,
      headSha,
    },
    now: NOW,
  });

{
  // The boundary: the row was FILED at the round's clock (`firstSeen === now`).
  // `>=` refuses the confirmation; relaxing to `>` lets the row retire on a
  // confirmation stamped at its own filing instant — a row this round filed is
  // never evidence a LATER review fixed it.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 boundary: the review identity resolved");
    const row = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW);
    assert(
      row.firstSeen === NOW,
      `guard:181 boundary: the row's stamp IS the round's clock (${row.firstSeen})`,
    );
    const out = reReportWithConfirmation(row, pid!, f.headSha, NOW);
    assert(
      out.decisions.some((d) => d.action === "matched") &&
        out.resolved.every((r) => r.rowId !== row.id),
      `guard:181 boundary: a row filed AT the round's clock is NOT retired by a confirmation stamped at that instant (decisions=${JSON.stringify(out.decisions)}, resolved=${JSON.stringify(out.resolved)})`,
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

{
  // The relaxation witness: the row's `firstSeen` is STRICTLY LATER than the
  // round's clock. `>=` still refuses; `>` admits the confirmation and the row
  // retires — which is the shape this guard exists to refuse.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 relax: the review identity resolved");
    const row = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW + 60_000);
    assert(
      row.firstSeen === NOW + 60_000,
      `guard:181 relax: the row's stamp is STRICTLY AFTER the round's clock (${row.firstSeen} > ${NOW})`,
    );
    const out = reReportWithConfirmation(row, pid!, f.headSha, NOW + 30_000);
    assert(
      out.decisions.some((d) => d.action === "matched") &&
        out.resolved.every((r) => r.rowId !== row.id),
      `guard:181 relax: a row filed AFTER the round's clock is NOT retired by a later confirmation (decisions=${JSON.stringify(out.decisions)}, resolved=${JSON.stringify(out.resolved)})`,
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

{
  // The other side of the same guard: a row filed STRICTLY BEFORE the round's
  // clock IS the row AC1 exists for, and the guard must not skip it. Without
  // this, `if (true) return undefined;` would satisfy both witnesses above.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 live: the review identity resolved");
    const row = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW - 60_000);
    const out = reReportWithConfirmation(row, pid!, f.headSha, NOW - 30_000);
    assert(
      out.resolved.some((r) => r.rowId === row.id && r.reason === "confirmed") &&
        out.decisions.some((d) => d.action === "matched" && d.rowId === row.id),
      `guard:181 live: a row filed BEFORE the round's clock IS retired by a bound confirmation (resolved=${JSON.stringify(out.resolved)}, decisions=${JSON.stringify(out.decisions)})`,
    );
  } finally {
    releaseFixture();
    removeFixture(f);
  }
}

process.exit(exit);
