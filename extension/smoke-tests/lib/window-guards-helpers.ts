/**
 * #1934 — the retired-row setup and the round driver the `guard:222` witnesses
 * in test-review-findings-window-guards.ts share with the untouched-row file.
 *
 * Lives in `lib/` rather than in a test file for the same reason as
 * `window-guards-clock.ts`: a test file imported by another test file runs its
 * top level — including its `process.exit(exit)` — inside the importer's run,
 * so the importer dies at the callee's exit code. A helper module has no top
 * level to run, and the §12 500-line gate is what moved it out of the test file
 * once the SLACK witnesses landed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { Finding } from "../../src/lens-review-types.ts";
import type { StoredFinding } from "../../src/review-findings-file.ts";
import { applyFindingRound } from "../../src/review-findings-round.ts";
import type { LedgerEntry, LedgerFile } from "../../src/review-ledger-entry.ts";
import {
  FINDING,
  HEAD_LINES,
  recordFindingRunOutcome,
  rowsOf,
} from "./confirmation-store-fixture.ts";
import { NOW } from "./window-guards-clock.ts";

/** Read the ledger file's bytes. A named helper so the file that OWNS the
 * witness (`test-review-findings-window-guards.ts`) keeps a repository-path text
 * read of its own: the #1647 ALWAYS_RUN detector classifies a test as a reader
 * from its own lexed source, and a read that lives only in a helper would let a
 * documentation or fixture change select this witness file out of the develop
 * gate. `window-guards-helpers.ts` is in `smoke-tests/lib/`, which the selector
 * treats as shared code and falls back to the full suite for — so routing the
 * read through here and calling it from the test keeps the witness selected.
 */
export function readLedgerText(file: string): string {
  return readFileSync(file, "utf8");
}

/** Write ledger rows through the SAME serializer the fixture uses, but typed on
 * `LedgerEntry[]` rather than on the fixture's `Array<Record<string, unknown>>`.
 * That widening is what let a fixture row whose `kind` had been erased to
 * `string` reach the file and still type-check; `validEntries`
 * (review-ledger-read.ts) would then have dropped the row and the witness would
 * have passed on an empty join. Here the compiler checks every field against
 * the entry type the reader enforces. */
function writeLedgerRows(file: string, entries: LedgerEntry[]): void {
  writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
}

/** The head content the fixture's `src/a.ts` carries, so `headOf` answers with
 * the same lines the store read for the rounds above. */
export const HEAD_OF = () => ({ kind: "lines" as const, lines: HEAD_LINES });

/** Retire a row through the real store, then hand back its stored bytes with
 * `lastSeen` overwritten to the caller's exact value and the ledger re-pointed
 * at an id NO round holds, so its confirmation no longer binds.
 *
 * WHY THE STAMP IS INJECTED. The store's own passes stamp a row's `lastSeen`
 * with the round's clock — the findings pass and the untouched pass at the
 * round's `now` — so a store-driven row's `lastSeen` is always either strictly
 * before or exactly equal to a later round's clock, never in between. Reaching
 * `lastSeen` STRICTLY AFTER the next round's clock through the store alone would
 * need a clock that runs backwards, and a `Date.now()` fixture cannot produce it
 * either (the two stamps would land a millisecond apart, so `>=` vs `>` would
 * differ by clock adjacency rather than by construction). The row is therefore
 * born from a real store round — real id, real hashes, real `resolved` /
 * `confirmed` provenance — and only its `lastSeen` is moved, which is the one
 * value those cases exist to place at the boundary.
 *
 * `confirmedBy` rides with the row because the AC4 pass reads it: no
 * provenance, no reportable lapse, and the assertion would witness nothing.
 */
export async function retiredRowAtLastSeen(
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
  writeLedgerRows(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!, [
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
  // The stamped copy the round judges. Constructed as a fresh object rather
  // than a cast over a spread: `StoredFinding` is a discriminated union (the
  // resolve-reason / provenance fields are tied to `status` by the file's
  // schema), and `as StoredFinding` over `{ ...retired, lastSeen }` silences
  // exactly the disagreement the compiler would otherwise raise — which is the
  // one thing this witness must not hide. The three fields the caller's stamp
  // is meant to place are asserted before the return, so a construction that
  // silently kept the store's own stamp is a throw, not a green.
  const stamped: StoredFinding = {
    ...retired,
    lastSeen,
  };
  if (stamped.lastSeen !== lastSeen) {
    throw new Error(`stamping did not take (${stamped.lastSeen} != ${lastSeen})`);
  }
  // The confirmation now names an id NO round holds, so the join's bound
  // rejects it and this row's retirement no longer binds — which is what AC4
  // acts on.
  writeLedgerRows(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!, [
    confirmRow(patchId, headSha, "ffffffff", 450_000),
  ]);
  // The ledger the round reads, from the file the store itself reads: written
  // with the fixture's writer and re-read here rather than reconstructed, so the
  // round's join and the file on disk cannot disagree about the row.
  const ledger = (
    JSON.parse(readLedgerText(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!)) as LedgerFile
  ).entries;
  return { row: stamped, ledger };
}

/** A passing adversarial ledger row naming `rowId`, stamped at `at`.
 *
 * The producer this shape stands in for is `writeAdversarialLedgerEntry`
 * (`adversarial-ledger.ts:83`), the only writer of `kind: "adversarial"` rows
 * this codebase has; the fields below are named directly rather than asserted
 * by appeal to it. `toolPath` is deliberately NOT carried: it is the #1360
 * tool-path PROVENANCE marker that writer takes as an optional parameter, and
 * nothing on the confirmation join's read path looks at it. The read chain is
 * `readLedgerFile` → `validEntries` (review-ledger-read.ts:30, applied by
 * `readLedgerFile`, not by `readLedgerAt`) and, for a caller that must not
 * throw, `readLedgerFileSafe` → the same `readLedgerFile`; `validEntries` keeps
 * a row on `branch` / `kind` / `patchId` / `at` / `passed` only, and
 * `confirmationsFor` (review-confirmation.ts) selects on `branch`, `passed`,
 * `kind`, `patchId`, `headSha`, `at` and `confirmedRowId`. Deleting `toolPath`
 * from this fixture reddens nothing in either consumer (measured: the whole
 * file stays green without it), so the field is not carried here for any reason
 * a test can see. */
export const confirmRow = (
  patchId: string,
  headSha: string,
  rowId: string,
  at: number,
): LedgerEntry => ({
  branch: "feature/work",
  // Typed at the source as `LedgerEntry` (declared return type above), so the
  // object literal is checked against the entry type HERE. Callers therefore
  // need no `as LedgerEntry[]` — the annotation is what lets the compiler judge
  // `kind` against `ReviewKind` instead of widening it to `string`.
  kind: "adversarial",
  patchId,
  passed: true,
  at,
  headSha,
  rowId,
  round: 2,
});

/** Drive one round over `rows` through the real entry point. `findings` is what
 * the round reports — empty for a round silent about every row, which is the
 * shape the AC4 guard's own notice is observable in. */
export const runRound = (
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
