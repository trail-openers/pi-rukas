#!/usr/bin/env bun
/**
 * #1934 — witnesses for the TWO round-clock guards in `confirmedFor`'s pass and
 * the AC4 re-observation pass (`review-findings-round.ts`).
 *
 * WHY THIS FILE EXISTS. Both guards were measured as un-witnessed: deleting
 * `if (r.lastSeen >= now) return;` (the AC4 re-observation guard, the pass the `guard:222` cases below drive) left
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
 * WHAT IS WITNESSED, and what is not — measured per mutation, not asserted.
 * Every line below was produced by rewriting the ONE comparison in a scratch
 * copy of `src/review-findings-round.ts` (a complete repo-root worktree under
 * /tmp, the product tree untouched) and running this file. A mutation is called
 * a witness only for the cases that actually reddened; the mutant was also
 * checked to differ from shipped in the code line and nowhere else (blob hash
 * + one-line diff), because a mutant whose strings differ only by an escape
 * byte reports a green it did not earn.
 *
 *   - `guard:222` DELETED            → `guard:222 boundary` AND `guard:222 relax`
 *     both redden (the AC4 pass runs, re-opens the retired row and stamps a lapse
 *     notice it must not have — the notice is the only observable, which is why
 *     the round here is SILENT about the row);
 *   - `guard:222` RELAXED `>=` → `>` → `guard:222 boundary` reddens ALONE (only a
 *     stamp exactly AT the clock separates the operators; `relax`'s row carries
 *     `lastSeen = NOW + 60_000`, so both operators skip it and its witness is
 *     the deletion, not the relaxation);
 *   - `guard:222` SLACK `>= now` → `>= now - 1000` → nothing reddens (see the
 *     constant paragraph below);
 *   - `guard:181` DELETED            → `guard:181 boundary` reddens (the row filed
 *     AT the round's clock retires on a confirmation stamped at its own filing);
 *   - `guard:181` RELAXED `>=` → `>` → `guard:181 boundary` reddens;
 *   - `guard:181` SLACK `>= now` → `>= now - 100` → `guard:181 slack` reddens —
 *     the case that pins the compared CONSTANT, not just its operator.
 *
 * `guard:181 relax` (a row whose `firstSeen` is strictly LATER than the round's
 * clock) is NOT a witness to the operator, and the argument is structural
 * rather than measured, which is what makes it falsifiable: with
 * `firstSeen > now` the join's window `[firstSeen, now]` is EMPTY, so no stamp
 * reaches this guard at all — every `at` is either `< firstSeen` (dropped by
 * review-confirmation.ts's lower bound) or `> now` (dropped by the round's own
 * upper bound). `guard:181 future` below is the falsification test for that
 * claim: it drives both boundary-adjacent stamps and asserts both are refused.
 * The prior round deleted this arm on exactly this reasoning and the adversarial
 * gate agreed; two lenses then claimed a discriminating case existed. Both were
 * describing a DIFFERENT construction — `firstSeen` strictly BEFORE the clock
 * with the stamp landing between the bounds — which is `guard:181 between` and
 * `guard:181 slack` below, built and measured rather than adjudicated. `relax`
 * stays as the PRECONDITION it is: it pins the join's lower bound, and it is
 * excluded from the witness count.
 *
 * What no earlier version of this file pinned: a shift of the compared
 * constant — `>= now - 1000` stayed green across the suite. `guard:181 slack`
 * (a row 11ms outside the guard's margin) is what reddens under such a shift.
 *
 * The `live` cases are not witnesses to any mutation either; they are the
 * anti-dead-code arms, the ones that keep each guard from being a `return`
 * stuffed into the top of its pass: a row stamped BEFORE the round's clock IS
 * re-opened by AC4 (`guard:222 live`) and a row filed BEFORE it IS retired by a
 * bound confirmation (`guard:181 live`).
 *
 * Also not this file's job: the `guard:181` arm is witnessed by four sibling
 * files (confirmed-store, untouched-confirm, confirmation-join,
 * disclosure-render), which together hold the neutralisation of that guard red
 * across the suite. The arms here are the two boundary cases plus the two
 * anti-dead-code arms; the rest belongs to the siblings and is not re-witnessed.
 *
 * Isolation comes from the shared fixture (`lib/confirmation-store-fixture.ts`):
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pins both the ledger and the findings store
 * into the fixture dir, so a round reads and writes only this test's files.
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
  recordFindingRunOutcome,
  releaseFixture,
  removeFixture,
  rowsOf,
  seed,
  writeLedger,
} from "./lib/confirmation-store-fixture.ts";
import { NOW } from "./lib/window-guards-clock.ts";
import {
  HEAD_OF,
  confirmRow,
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

/** The environment as this file found it — the final assertion compares against this. */
/** The environment as this file found it. The LAST block compares the teardown
 * against the value the host-teardown block installed — NOT against this
 * snapshot, which the same block would then be asserting its own writes back. */
const ENV_AT_ENTRY = {
  PI_ENSEMBLE_REVIEW_LEDGER_FILE: process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE,
  PI_AGENT_DIR: process.env.PI_AGENT_DIR,
};
/** One round through the real store, with every clock value a literal. */

// ---------------------------------------------------------------------------
// guard:222 — `if (r.lastSeen >= now) return;` in the AC4 re-observation pass
// ---------------------------------------------------------------------------

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
    // The ledger the round will read, written HERE rather than probed. A prior
    // version asserted `entries.length === 0` on a file `makeFixture` never
    // creates: `existsSync` answered false, the `||` short-circuited to "", and
    // the assertion passed on an absent file — vacuous, and it would have passed
    // unchanged had the fixture shipped a pre-seeded ledger. So the file is
    // created empty first and the assertion reads the PARSED entries of a file
    // the test knows exists, which is also the file `retiredRowAtLastSeen` then
    // overwrites with the confirmation this round joins against.
    writeLedger(f.ledgerFile, []);
    const ledgerText = readFileSync(f.ledgerFile, "utf8");
    assert(
      JSON.parse(ledgerText).entries.length === 0,
      `guard:222 boundary: the fixture's ledger exists and holds no rows before the first round (${ledgerText.slice(0, 40)})`,
    );
    const { row, ledger } = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW);
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
    releaseFixture(f);
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
    const mine = [row];
    const out = runRound(mine, [], ledger, pid!, f.headSha);
    // Three observables, not one, and all three read from the array the ROUND
    // mutated (`mine` is written in place — see applyFindingRound's doc) rather
    // than from the snapshot `retiredRowAtLastSeen` handed back. The element
    // `mine` holds after the call IS the post-round row, so the state
    // assertions judge the product of the pass and not of the setup.
    //   - `out.lapsed` — the NOTICE exists and names this row;
    //   - `status === "open"` — the reopen happened (`reopen()`,
    //     review-findings-round.ts); a mutant that pushed the notice without
    //     reopening reddens here and nowhere else;
    //   - `confirmedBy === undefined` — the provenance moved into the notice,
    //     which is the AC4 pass's own write (the file's schema refuses
    //     provenance on an open row), so it is this pass's work, not the row's.
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
  return { ...row, firstSeen };
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
    releaseFixture(f);
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
    // The confirmation must sit INSIDE the join's window. `entry.at` below
    // `firstSeen` is dropped by review-confirmation.ts:201
    // (`entry.at < seen.firstSeen || entry.at > seen.lastSeen`) BEFORE this
    // round's `firstSeen >= now` guard is ever reached, so a stamp below the
    // lower bound makes the case a tautology: it stays green under `>=` → `>`
    // because the candidate never gets far enough to be judged. That is what the
    // previous version of this case did (stamp `NOW + 30_000` against
    // `firstSeen = NOW + 60_000` — adversarial review, reproduced by arithmetic
    // and by re-running with an in-window stamp). It is DELETED rather than kept:
    // no stamp can make the case discriminate, because with `firstSeen > now` the
    // only reason a join can refuse this row is its own bound. What is asserted
    // here is therefore the PRECONDITION, stated as the assertion it is, so the
    // decorative claim cannot come back.
    const tooEarly = reReportWithConfirmation(row, pid!, f.headSha, NOW + 30_000);
    assert(
      tooEarly.resolved.length === 0,
      `guard:181 relax (precondition, NOT a witness): a confirmation below the row's own firstSeen is dropped by the join's lower bound regardless of the round's guard (resolved=${JSON.stringify(tooEarly.resolved)})`,
    );
  } finally {
    releaseFixture(f);
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
    releaseFixture(f);
    removeFixture(f);
  }
}

// --- candidates for the `guard:181 relax` witness the last round deleted ----
//
// The last round deleted `guard:181 relax` on the reasoning that with
// `firstSeen > now` no confirmation stamp makes the case discriminate: the
// join's own lower bound (`entry.at < seen.firstSeen`, review-confirmation.ts)
// drops the candidate before this round's guard is reached. Three reviewers
// then disagreed about whether ANY discriminating case exists, so the question
// was settled by construction rather than by adjudication — see the header for
// which candidates redden under which mutation.

{
  // CANDIDATE A — `firstSeen` strictly BEFORE the round's clock, with the
  // confirmation stamped strictly BETWEEN the two bounds
  // (`firstSeen < at <= now`). This is the interval the two lenses described
  // and the last round never constructed: it never tested `firstSeen < now`
  // with an in-between stamp, only `firstSeen > now` with an out-of-window one.
  // `>=` accepts it (a row filed before the round may be retired); `>` also
  // accepts it, so the mutation that reddens this case is the guard's DELETION
  // paired with `boundary` — it is the arm that keeps `boundary` from being the
  // only thing standing between the guard and a blanket `return undefined`.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 between: the review identity resolved");
    const row = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW - 1001);
    const out = reReportWithConfirmation(row, pid!, f.headSha, NOW - 900);
    assert(
      out.resolved.some((r) => r.rowId === row.id && r.reason === "confirmed"),
      `guard:181 between: a row filed 1001ms BEFORE the round IS retired by a confirmation stamped between the bounds (resolved=${JSON.stringify(out.resolved)})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
}

{
  // CANDIDATE B — the `+ slack` witness, and the case that pins the compared
  // CONSTANT rather than the operator. The row is filed 11ms BEFORE the round's
  // clock, i.e. just OUTSIDE the 10ms margin the guard's `now - 10` mutant
  // would hand it. Shipped `firstSeen >= now` retires it (11ms is old enough);
  // `>= now - 10` refuses it. No other test in the repo measures a shift of
  // that constant — `>= now - 1000` was measured green across the suite before
  // this case existed. The margin is a constant this file and the mutation
  // script share: change one and the other's red is the signal to change both.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 slack: the review identity resolved");
    const row = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW - 11);
    assert(
      NOW - row.firstSeen === 11,
      `guard:181 slack: filed 11ms before the round's clock (${row.firstSeen} vs ${NOW})`,
    );
    const out = reReportWithConfirmation(row, pid!, f.headSha, NOW - 5);
    assert(
      out.resolved.some((r) => r.rowId === row.id && r.reason === "confirmed"),
      `guard:181 slack: a row 11ms outside the guard's margin IS retired, so any `+`-slack on the compared constant refuses it (resolved=${JSON.stringify(out.resolved)})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
}

{
  // CANDIDATE C — the shape the other two lenses named: `firstSeen` STRICTLY
  // AFTER the round's clock, with a confirmation stamped between the round's
  // clock and the row's stamp. The prior round's claim was that the interval
  // is empty — every `at` is either `< firstSeen` (dropped by the join's lower
  // bound) or `> now` (dropped by the round's upper bound). This case is the
  // falsification test for that claim: if a stamp existed that made `>=` and
  // `>` disagree, this case reddens under one of them.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 future: the review identity resolved");
    const row = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW + 5_000);
    const between = reReportWithConfirmation(row, pid!, f.headSha, NOW + 2_500);
    const atNow = reReportWithConfirmation(row, pid!, f.headSha, NOW);
    assert(
      between.resolved.length === 0 && atNow.resolved.length === 0,
      `guard:181 future: with firstSeen AFTER the clock, every stamp is refused — by the join below firstSeen, by the round above it (between=${JSON.stringify(between.resolved)}, atNow=${JSON.stringify(atNow.resolved)})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
}

// ---------------------------------------------------------------------------
// the fixture's env pins are restorable, not destructive (HIGH 1)
// ---------------------------------------------------------------------------

{
  // An OUTER fixture records the host's real env; an inner makeFixture/release
  // pair runs inside it. If release deletes instead of restoring, the outer
  // round's next write lands in the real per-clone ledger / the developer's
  // ~/.pi state. `hostLedger` is a path OUTSIDE any fixture and outside the
  // process env, so a leaked write is observable as a file that must never
  // exist. The env is set back to `ENV_AT_ENTRY` in the finally rather than
  // through the fixture's own release: this case's fixture was created with
  // this case's pins in place, so those pins are what a correct release puts
  // back (that is the HIGH 1 property, asserted below), not the pre-entry
  // values — restoring those is the last block's job.
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "host-ledger-"));
  const hostLedger = path.join(hostDir, "ledger.json");
  const hostAgent = path.join(hostDir, "agent");
  // The host's real values, saved so this case can put them back at the end.
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = hostLedger;
  process.env.PI_AGENT_DIR = hostAgent;
  resetFindingsStateCache();
  const f = makeFixture();
  const outerLedger = f.ledgerFile;
  const outerAgent = path.join(f.root, "agent");
  try {
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === outerLedger,
      `env: makeFixture pins the ledger into the fixture (${process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE})`,
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
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === outerLedger &&
        process.env.PI_AGENT_DIR === outerAgent,
      `env: an inner release restores the OUTER fixture's pins rather than deleting them (ledger=${process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE}, agent=${String(process.env.PI_AGENT_DIR)})`,
    );
    // The outer round still works on ITS file after the inner release, and no
    // row from any fixture reached the host path.
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    const row = await seed(f.dir, f.headSha);
    assert(
      pid !== undefined && (await rowsOf(f.dir)).some((r) => r.id === row.id),
      "env: the outer fixture's store still round-trips after an inner release",
    );
    assert(
      existsSync(hostLedger) === false,
      `env: no row from any fixture reached the host ledger path (${hostLedger})`,
    );
    assert(
      existsSync(hostAgent) === false,
      `env: no fixture state reached the host agent dir (${hostAgent})`,
    );
  } finally {
    // The pins the fixture is expected to put back are `f.priorEnv` — the values
    // `makeFixture` RECORDED when it made this fixture. They are not values this
    // block assigned inside the `try`, so the comparison is against state the
    // asserted function had to move, not against a constant the same block
    // wrote. (`hostLedger` above is what the case installed BEFORE the fixture
    // existed; `f.priorEnv` is what the fixture itself captured, and a release
    // that ignored its own record and re-derived from elsewhere is caught here
    // and not by the earlier assertion.)
    releaseFixture(f);
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === f.priorEnv.ledgerFile &&
        process.env.PI_AGENT_DIR === f.priorEnv.agentDir &&
        f.priorEnv.ledgerFile === hostLedger &&
        f.priorEnv.agentDir === hostAgent,
      `env: releaseFixture writes back the values it recorded (recorded=${JSON.stringify(f.priorEnv)}) instead of deleting them (ledger=${String(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${String(process.env.PI_AGENT_DIR)})`,
    );
    // Restore the host env with the two-branch form. On bun an assignment of
    // `undefined` does NOT remove the variable — it stores the 9-character
    // string "undefined", which every consumer that reads through `?.trim()`
    // treats as a truthy path. `delete` is the only shape that unsets.
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    // And the restore is asserted, not assumed: a variable the entry found
    // unset must be absent from the env object, not present-and-"undefined".
    assert(
      (savedLedger === undefined
        ? !("PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env)
        : process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === savedLedger) &&
        (savedAgent === undefined
          ? !("PI_AGENT_DIR" in process.env)
          : process.env.PI_AGENT_DIR === savedAgent),
      `env: the host teardown restores the entry state exactly (ledger=${JSON.stringify(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${JSON.stringify(process.env.PI_AGENT_DIR)}, entry=${JSON.stringify([ENV_AT_ENTRY.PI_ENSEMBLE_REVIEW_LEDGER_FILE, ENV_AT_ENTRY.PI_AGENT_DIR])})`,
    );
    removeFixture(f);
    rmSync(hostDir, { recursive: true, force: true });
  }
}

process.exit(exit);
