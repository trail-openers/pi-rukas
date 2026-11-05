#!/usr/bin/env bun
/**
 * #1934 — witnesses for the TWO round-clock guards in `confirmedFor`'s pass and
 * the AC4 re-observation pass (`review-findings-round.ts`).
 *
 * WHY THIS FILE EXISTS. Both guards were measured as un-witnessed: deleting
 * `if (r.lastSeen >= now) return;` (the AC4 re-observation guard the
 * `guard:222` cases drive) left all five confirmation tests green, and relaxing
 * either guard's `>=` to `>` changed nothing under the whole suite. Two
 * comparisons whose entire job is a time ordering had no test that saw them.
 *
 * HOW THE BOUNDARY IS MADE OBSERVABLE — the round's clock is frozen:
 * `recordFindingRunOutcome` takes `now` and the store hands it to
 * `applyFindingRound`, so stamps are exact integers the test picks. A
 * `Date.now()` fixture would make `>=` and `>` differ only by a millisecond of
 * adjacency — a clock coincidence, not a discrimination of the operator — so
 * every case below stamps with literals and names the boundary explicitly.
 * WHAT IS WITNESSED, and what is not — measured per mutation, not asserted.
 * Each line came from rewriting the ONE comparison in a scratch copy of
 * `src/review-findings-round.ts` (a complete repo-root worktree under /tmp) and
 * running this file. A mutation is a witness only for the cases that actually
 * reddened, and each mutant was checked to differ from shipped in the code line
 * and nowhere else (blob hash plus a one-line diff): a mutant whose strings
 * differ only by an escape byte reports a green it did not earn.
 *
 *   - `guard:222` DELETED            → `boundary` AND `relax` both redden (the
 *     AC4 pass runs, re-opens the retired row and stamps a lapse notice it must
 *     not have — the notice is the only observable, which is why the round here
 *     is SILENT about the row);
 *   - `guard:222` RELAXED `>=` → `>` → `boundary` reddens ALONE (only a stamp
 *     exactly AT the clock separates the operators; `relax`'s row carries
 *     `lastSeen = NOW + 60_000`, so both operators skip it and its witness is
 *     the deletion, not the relaxation);
 *   - `guard:222` SLACK `>= now - 1000` → nothing reddens here. The constant is
 *     pinned by `guard:181 slack` in the sibling slack file (the §12 500-line
 *     split), where the `firstSeen < now` constructions, the full `guard:181`
 *     matrix, and the falsification case for the empty-interval argument that
 *     `guard:181 relax` below rests on all now live;
 *   - `guard:181` DELETED, RELAXED (`>=` → `>`) and NEVER (`if (false)`) →
 *     `boundary` reddens in each case, and it is the ONLY case in the repo
 *     that reddens for any of the three. Measured again this round against the
 *     construction two lenses named as a second `>` witness (`firstSeen = NOW -
 *     1001`, confirmation `at = NOW - 900`): it is `guard:181 between` in the
 *     sibling slack file and it stayed GREEN under `>=` → `>`, along with every
 *     other case there. So `>=` versus `>` is decided at EXACTLY ONE point —
 *     `firstSeen === now` — and that point is `boundary` alone; `slack` and
 *     `between` witness the guard's presence and the compared constant, not the
 *     operator.
 *
 * The `live` cases are not witnesses to any mutation either; they are the
 * anti-dead-code arms, the ones that keep each guard from being a `return`
 * stuffed into the top of its pass: a row stamped BEFORE the round's clock IS
 * re-opened by AC4 (`guard:222 live`) and a row filed BEFORE it IS retired by a
 * bound confirmation (`guard:181 live`).
 *
 * Also not this file's job: four sibling files (confirmed-store,
 * untouched-confirm, confirmation-join, disclosure-render) together hold the
 * neutralisation of the `guard:181` arm red across the suite. The arms here are
 * the boundary and anti-dead-code cases; the rest is not re-witnessed.
 *
 * Isolation: the shared fixture pins both the ledger and the findings store
 * into its own dir, so a round reads and writes only this test's files.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { Finding } from "../src/lens-review-types.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import { applyFindingRound } from "../src/review-findings-round.ts";
import type { LedgerEntry } from "../src/review-ledger-entry.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";
import { resetFindingsStateCache } from "../src/review-state-path.ts";
import {
  FINDING,
  HEAD_LINES,
  makeFixture,
  okFixture,
  releaseFixture,
  removeFixture,
  writeLedger,
} from "./lib/confirmation-store-fixture.ts";
import { NOW } from "./lib/window-guards-clock.ts";
import {
  HEAD_OF,
  confirmRow,
  openRowAtFirstSeen,
  readLedgerText,
  retiredRowAtLastSeen,
  runRound,
} from "./lib/window-guards-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Record a shared-setup helper's fault as a NAMED RED, and tell the caller to
 * skip the rest of its case. There is no throwing variant of this channel in the
 * file: a helper whose fault reaches a `throw` at a call site whose `try` has not
 * opened yet aborts the whole file on an unhandled exception, which is precisely
 * the defect these helpers were given a failure channel to remove — measured,
 * neutralising `retiredRowAtLastSeen`'s filing step while the call site threw
 * left the run with 2 output lines and the other two `guard:222` cases never
 * executed. An assertion plus a `break` out of the case's labelled block gives
 * the red, sets the exit code, and lets every other case in the file still run,
 * so a broken fixture can report a failure without silencing its witnesses.
 * Returns true when the setup is usable. */
function assertSetup(
  setup: { row?: StoredFinding; ledger?: LedgerEntry[]; problem: string },
  label: string,
): setup is { row: StoredFinding; ledger: LedgerEntry[]; problem: string } {
  const ok = setup.problem === "" && setup.row !== undefined;
  assert(ok, `${label}: the shared setup built the fixture (${setup.problem || "ok"})`);
  return ok;
}

/** The environment as this file found it, captured at load, before any case ran.
 * The LAST block's teardown asserts against this alongside the values its own
 * block saved, which is what makes it a process-level invariant — "the file
 * exits with the env it entered" — rather than a comparison of `process.env`
 * against the same two locals that block had just installed. The snapshot is
 * read by that assertion, so it is not a print-only variable dressed as a check;
 * deleting it reddens that arm, and a value the entry did not have cannot be
 * written back into the predicate without reddening it too. */
const ENV_AT_ENTRY = {
  PI_ENSEMBLE_REVIEW_LEDGER_FILE: process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE,
  PI_AGENT_DIR: process.env.PI_AGENT_DIR,
};
// ---------------------------------------------------------------------------
// guard:222 — `if (r.lastSeen >= now) return;` in the AC4 re-observation pass
// ---------------------------------------------------------------------------

guard_case: {
  // The boundary: the retired row's `lastSeen` EQUALS the round's clock and the
  // round is SILENT about the row. Silence is the only shape that witnesses this
  // guard — a round that re-reports the row takes it through the matched pass,
  // which stamps the lapse notice whether or not the AC4 pass ran (measured:
  // both mutations left a re-reporting case green). With the guard in place the
  // AC4 pass skips the row and the round reports NOTHING about it.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:222 boundary", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:222 boundary: the review identity resolved");
    // The ledger the round reads, WRITTEN here rather than probed. A prior
    // version asserted `entries.length === 0` on a file `makeFixture` never
    // creates: the `existsSync ? … : ""` short-circuit passed the assertion on
    // an absent file — vacuous, and unchanged had the fixture shipped a seeded
    // ledger. So the file is created empty first and the assertion reads the
    // parsed entries of a file the test knows exists.
    writeLedger(f.ledgerFile, []);
    const ledgerText = readFileSync(f.ledgerFile, "utf8");
    assert(
      JSON.parse(ledgerText).entries.length === 0,
      `guard:222 boundary: the fixture's ledger exists and holds no rows before the first round (${ledgerText.slice(0, 40)})`,
    );
    const setup = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW);
    // A setup fault is a NAMED RED and then a SKIP — never a throw. `require`
    // would abort the file on an unhandled exception, which is the exact defect
    // this helper exists to remove: measured, neutralising the helper's seed
    // under `require` left the run with 2 lines and the other two `guard:222`
    // cases never executed. `assert` records the red, `exit = 1`, and the case
    // reports its problem and moves on, so every case still runs and the file
    // still cannot go green on a fixture that never built.
    if (!assertSetup(setup, "guard:222 boundary")) break guard_case;
    const { row, ledger } = setup;
    readLedgerText(f.ledgerFile);
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
    releaseFixture(f);
    removeFixture(f);
  }
  break guard_case;
}

guard_case: {
  // The relaxation witness: the retired row's `lastSeen` is STRICTLY LATER than
  // the round's clock — a stamp no store-driven round can produce, which is why
  // the row's own stamp is injected (see `retiredRowAtLastSeen`). `>=` still
  // skips the pass; `>` runs it, re-opens the row and pushes a lapse notice.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:222 relax", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:222 relax: the review identity resolved");
    const setup = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW + 60_000);
    if (!assertSetup(setup, "guard:222 relax")) break guard_case;
    const { row, ledger } = setup;
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
    releaseFixture(f);
    removeFixture(f);
  }
  break guard_case;
}

guard_case: {
  // The anti-dead-code arm: a row stamped STRICTLY BEFORE the round's clock is
  // the row AC4 exists for and the guard must NOT skip it. Without this arm a
  // blanket `return;` at the top of the pass satisfied both witnesses above —
  // measured: the blanket-return mutant reddens here and nowhere else.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:222 live", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:222 live: the review identity resolved");
    const setup = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW - 60_000);
    if (!assertSetup(setup, "guard:222 live")) break guard_case;
    const { row, ledger } = setup;
    const mine = [row];
    const out = runRound(mine, [], ledger, pid!, f.headSha);
    // Three observables, all read from the array the ROUND mutated (`mine` is
    // written in place — see applyFindingRound's doc) rather than from the
    // snapshot `retiredRowAtLastSeen` handed back, so they judge the product of
    // the pass and not of the setup.
    //   - `out.lapsed` — the NOTICE exists and names this row;
    //   - `status === "open"` — the reopen happened (`reopen()`,
    //     review-findings-round.ts); a mutant that pushed the notice without
    //     reopening reddens here and nowhere else;
    //   - `confirmedBy === undefined` — the provenance moved into the notice,
    //     the AC4 pass's own write (the schema refuses provenance on an open
    //     row), so it is this pass's work and not the row's.
    const after = mine[0]!;
    assert(
      out.lapsed?.some((l) => l.rowId === row.id) === true &&
        after.status === "open" &&
        after.confirmedBy === undefined,
      `guard:222 live: a row stamped BEFORE the round's clock IS re-opened by AC4 and reported (lapsed=${JSON.stringify(out.lapsed)}, status=${after.status}, confirmedBy=${String(after.confirmedBy)})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
  break guard_case;
}

// ---------------------------------------------------------------------------
// guard:181 — `if (r.firstSeen >= now) return undefined;` in `confirmedFor`
// ---------------------------------------------------------------------------

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
      // No `as LedgerEntry[]`: the object literal is checked against the entry
      // type, so a field the ledger's own reader would drop is a compile error
      // here rather than a fixture that silently stops being a candidate.
      ledger: [confirmRow(patchId, headSha, row.id, at)],
      patchId,
      headSha,
    },
    // #2040 — no lens children in this fixture: see `runRound`.
    evidence: new Map(),
    now: NOW,
  });

guard_case: {
  // The boundary: the row was FILED at the round's clock (`firstSeen === now`).
  // `>=` refuses the confirmation; relaxing to `>` lets the row retire on a
  // confirmation stamped at its own filing instant — a row this round filed is
  // never evidence a LATER review fixed it.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:181 boundary", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 boundary: the review identity resolved");
    const setup = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW);
    if (!assertSetup(setup, "guard:181 boundary")) break guard_case;
    const row = setup.row;
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
    releaseFixture(f);
    removeFixture(f);
  }
  break guard_case;
}

guard_case: {
  // The relaxation witness: the row's `firstSeen` is STRICTLY LATER than the
  // round's clock. `>=` still refuses; `>` admits the confirmation and the row
  // retires — which is the shape this guard exists to refuse.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:181 relax", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 relax: the review identity resolved");
    const setup = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW + 60_000);
    if (!assertSetup(setup, "guard:181 relax")) break guard_case;
    const row = setup.row;
    assert(
      row.firstSeen === NOW + 60_000,
      `guard:181 relax: the row's stamp is STRICTLY AFTER the round's clock (${row.firstSeen} > ${NOW})`,
    );
    // PRECONDITION, stated as the assertion it is so the decorative claim
    // cannot come back. A confirmation below the row's own `firstSeen` is
    // dropped by review-confirmation.ts's `entry.at < seen.firstSeen` BEFORE
    // this round's guard is reached, so it stays green under `>=` → `>` for a
    // reason that has nothing to do with the operator: the candidate never gets
    // far enough to be judged. The prior version of this case asserted exactly
    // that (stamp `NOW + 30_000` against `firstSeen = NOW + 60_000`), and the
    // discriminating construction it was mistaken for now lives in
    // `test-review-findings-window-guards-slack.ts`. With `firstSeen > now` the
    // join's window is empty, so no stamp here can witness the operator.
    const tooEarly = reReportWithConfirmation(row, pid!, f.headSha, NOW + 30_000);
    assert(
      tooEarly.resolved.length === 0,
      `guard:181 relax (precondition, NOT a witness): a confirmation below the row's own firstSeen is dropped by the join's lower bound regardless of the round's guard (resolved=${JSON.stringify(tooEarly.resolved)})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
  break guard_case;
}

guard_case: {
  // Anti-dead-code arm: a row filed STRICTLY BEFORE the round's clock IS
  // the row AC1 exists for, and the guard must not skip it.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:181 live", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 live: the review identity resolved");
    const setup = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW - 60_000);
    if (!assertSetup(setup, "guard:181 live")) break guard_case;
    const row = setup.row;
    const out = reReportWithConfirmation(row, pid!, f.headSha, NOW - 30_000);
    assert(
      out.resolved.some((r) => r.rowId === row.id && r.reason === "confirmed") &&
        out.decisions.some((d) => d.action === "matched" && d.rowId === row.id),
      `guard:181 live: a row filed BEFORE the round's clock IS retired by a bound confirmation (resolved=${JSON.stringify(out.resolved)}, decisions=${JSON.stringify(out.decisions)})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
  break guard_case;
}

process.exit(exit);
