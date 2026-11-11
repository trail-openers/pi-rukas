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

import { readFileSync } from "node:fs";
import type { Finding } from "../../src/lens-review-types.ts";
import type { StoredFinding } from "../../src/review-findings-file.ts";
import { applyFindingRound } from "../../src/review-findings-round.ts";
import type { LedgerEntry, LedgerFile } from "../../src/review-ledger-entry.ts";
import {
  FINDING,
  HEAD_LINES,
  recordFindingRunOutcome,
  rowsOf,
  writeLedger,
} from "./confirmation-store-fixture.ts";
import { NOW } from "./window-guards-clock.ts";

/**
 * The `open` arm of a stamping construction that the surrounding narrowing has
 * already made unreachable. It THROWS rather than builds: since #1934 the `open`
 * arm of `StoredFinding` declares `confirmedBy?: undefined`, so spreading a
 * not-yet-narrowed union into it is a type error — which is the schema refusing
 * an open row that carries a retirement's provenance, asserted by the compiler
 * at the fixture rather than papered over with a cast. Named, not `as`-ed, for
 * the same reason the callers refuse `as StoredFinding`.
 */
export function neverArm(status: never): StoredFinding {
  throw new Error(`setup: row is ${String(status)}, not open`);
}

/** Read the ledger file's bytes. A named helper so the file that OWNS the
 * witness (`test-review-findings-window-guards.ts`) keeps a repository-path text
 * read of its own: the #1647 always-run predicate classifies a test as a reader
 * from its own lexed source, and a read that lives only in a helper would let a
 * documentation or fixture change select this witness file out of the develop
 * gate. `window-guards-helpers.ts` is in `smoke-tests/lib/`, which the selector
 * treats as shared code and falls back to the full suite for — so routing the
 * read through here and calling it from the test keeps the witness selected.
 */
export function readLedgerText(file: string): string {
  return readFileSync(file, "utf8");
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
): Promise<{ row?: StoredFinding; ledger?: LedgerEntry[]; problem: string }> {
  const fault = (why: string) => ({ problem: `setup: ${why}` });
  const filed = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
    patchId,
    now: 400_000,
  });
  if (!filed.ok) return fault(`filing round failed: ${filed.reason}`);
  const read = await rowsOf(dir);
  if (read.problem !== "") return fault(read.problem);
  const row = read.rows.find((r) => r.title === FINDING.title);
  if (!row) return fault("filing round filed no row");
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
  if (!retire.ok) return fault(`retire round failed: ${retire.reason}`);
  const after = await rowsOf(dir);
  if (after.problem !== "") return fault(after.problem);
  const retired = after.rows.find((r) => r.id === row.id);
  // EVERY field the returned row is built from is pinned before the
  // construction below, not just the stamp. The narrowing this throw supplies
  // is what makes the two arms of `stamped` type-check WITHOUT a cast, and
  // `resolvedReason` / `confirmedBy` are the two the AC4 pass reads: a row that
  // came back with a different reason, or with no provenance, would leave that
  // pass with nothing to report and the caller's assertion would witness
  // nothing. All three are checked here so a setup that quietly produced a
  // different row is a named red rather than a green over the wrong fixture.
  if (
    retired?.status !== "resolved" ||
    retired.resolvedReason !== "confirmed" ||
    retired.confirmedBy === undefined
  ) {
    return fault(`setup did not retire the row (${retired?.status}/${retired?.resolvedReason})`);
  }
  // The stamped copy the round judges, built per discriminated arm rather than
  // as a spread of the union plus an assertion afterwards. A spread of a
  // union-typed value is itself a union and the compiler will not settle which
  // arm it is, so the only alternatives to branching here were `as StoredFinding`
  // (which silences exactly the disagreement the compiler would raise) or an
  // unchecked construction plus a runtime throw (which witnesses a stamp that
  // cannot fail). In each arm the compiler judges every field against the arm
  // the narrowing above established; the `resolved` arm is written in full and
  // the `open` arm is unreachable-by-narrowing, so it is a named fault rather
  // than a cast through `undefined`.
  const stamped: StoredFinding =
    retired.status === "resolved"
      ? {
          ...retired,
          status: "resolved",
          acceptance: undefined,
          resolvedReason: "confirmed",
          lastSeen,
        }
      // Unreachable by the narrowing above: the `open` arm of
      // `StoredFinding` now declares `confirmedBy?: undefined`, so a spread of
      // the not-yet-narrowed union is a TYPE ERROR (#1934's rule, asserted by the
      // compiler at the fixture). Spreading the narrowed `never` instead yields an
      // empty object, so the arm calls a never-typed helper and can never be
      // silently constructed.
      : neverArm(retired);
  // Each field the construction is supposed to have placed is checked against
  // the value the CALLER supplied, so a construction that silently kept the
  // store's own stamp — or the store's own status — is a named fault.
  if (stamped.lastSeen !== lastSeen) {
    return fault(`stamping did not take (${stamped.lastSeen} != ${lastSeen})`);
  }
  if (stamped.status !== "resolved" || stamped.resolvedReason !== "confirmed") {
    return fault(`stamped row lost its retirement (${stamped.status}/${stamped.resolvedReason})`);
  }
  if (stamped.confirmedBy === undefined) {
    return fault("stamped row lost its provenance");
  }
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
    JSON.parse(readLedgerText(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE!)) as LedgerFile
  ).entries;
  return { row: stamped, ledger, problem: "" };
}

/** File an OPEN row through the real store at the caller's clock, then hand back
 * its stored bytes with `firstSeen` set to the caller's exact value.
 *
 * WHY ONE COPY LIVES HERE. The two window-guards files each carried a local copy
 * and the copies had DIVERGED: the slack file's returned `{ problem }` while the
 * main file's `throw`ed out of a call site whose `try` had not opened — the exact
 * defect the shared helper exists to remove, kept alive by being written twice.
 * Two copies of one setup recipe also mean a fix applied to one leaves the other
 * silently faulty, which is what happened here. Same reason as
 * `window-guards-clock.ts`: a test file imported by another test file runs its
 * top level, including its `process.exit(exit)`, inside the importer's run.
 *
 * WHY THE STAMP IS INJECTED. `retiredRowAtLastSeen`'s reason, restated because
 * the two are not interchangeable: the store stamps `firstSeen` with the filing
 * round's `now`, so a store-driven row can never sit STRICTLY AFTER a later
 * round's clock — and `>=` versus `>` is only decided by a case that does. The
 * row is real (real id, real hashes, filed by a real round); only its filing
 * stamp is moved. */
export async function openRowAtFirstSeen(
  dir: string,
  headSha: string,
  patchId: string,
  firstSeen: number,
): Promise<{ row?: StoredFinding; problem: string }> {
  const fault = (why: string) => ({ problem: `setup: ${why}` });
  const filed = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
    patchId,
    now: firstSeen,
  });
  if (!filed.ok) return fault(`filing round failed: ${filed.ok ? "" : filed.reason}`);
  const read = await rowsOf(dir);
  if (read.problem !== "") return fault(read.problem);
  const row = read.rows.find((r) => r.title === FINDING.title);
  if (!row) return fault("filing round filed no row");
  if (row.firstSeen !== firstSeen || row.status !== "open") {
    return fault(`filing round stamped ${row.firstSeen}/${row.status}`);
  }
  // Built per discriminated arm rather than as `{ ...row, firstSeen }` over the
  // UNION-typed row: a spread of a union is itself an unresolved union, so the
  // choices were a cast (which erases the arm distinction `StoredFinding` exists
  // to keep) or this. The narrowing above pins `status === "open"`, so the
  // compiler judges the open arm field by field, and an arm that quietly wrote
  // the wrong status is caught by the check below rather than shipped.
  const stamped: StoredFinding =
    row.status === "open"
      ? {
          ...row,
          status: "open",
          acceptance: undefined,
          resolvedReason: undefined,
          firstSeen,
        }
      // Unreachable by the narrowing above: the `open` arm of `StoredFinding`
      // declares `confirmedBy?: undefined`, so spreading the not-yet-narrowed
      // union is a TYPE ERROR — #1934's rule, asserted by the compiler at the
      // fixture rather than papered over with a cast. Spreading the narrowed
      // `never` instead yields an empty object, so the arm calls a never-typed
      // helper and can never be silently constructed.
      : neverArm(row);
  if (stamped.firstSeen !== firstSeen || stamped.status !== "open") {
    return fault(`stamping did not take (${stamped.firstSeen} != ${firstSeen})`);
  }
  return { row: stamped, problem: "" };
}

/** A passing adversarial ledger row naming `rowId`, stamped at `at`.
 *
 * The producer this shape stands in for is `writeAdversarialLedgerEntry`
 * (`adversarial-ledger.ts`, the function by that name — line numbers rot and
 * this repo has a standing rule against citing them), the only writer of
 * `kind: "adversarial"` rows this codebase has; the fields below are named
 * directly rather than asserted by appeal to it. `toolPath` is deliberately NOT
 * carried: it is the #1360 tool-path PROVENANCE marker that writer takes as an
 * optional parameter, and nothing on the confirmation join's read path looks at
 * it. The validation chain a row must survive to be seen at all is
 * `readLedgerFile` → `validEntries`: `validEntries` is DECLARED in
 * `review-ledger-read.ts` and CALLED by `readLedgerFile`, and NOT by
 * `readLedgerAt` (which parses and then discards the rows), so a fixture row
 * `validEntries` refuses is invisible to this consumer whatever else reads the
 * file. For a caller that must not
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
    // #2040 — a round with no lens children of its own: an empty surface,
    // which caps any HIGH it would carry. These cases judge the confirmation
    // window, not the reproduction cap, and their rows are CRITICAL (a
    // severity the cap never moves).
    evidence: new Map(),
    now: NOW,
  });
