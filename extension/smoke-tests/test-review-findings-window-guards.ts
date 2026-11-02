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
 *     `boundary` reddens in each case.
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
  assertUnset,
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

/** The environment as this file found it. The LAST block compares its teardown
 * against the value the host-teardown block installed — NOT against this
 * snapshot, which that block would then be asserting its own writes back. */
const ENV_AT_ENTRY = {
  PI_ENSEMBLE_REVIEW_LEDGER_FILE: process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE,
  PI_AGENT_DIR: process.env.PI_AGENT_DIR,
};
// ---------------------------------------------------------------------------
// guard:222 — `if (r.lastSeen >= now) return;` in the AC4 re-observation pass
// ---------------------------------------------------------------------------

{
  // The boundary: the retired row's `lastSeen` EQUALS the round's clock and the
  // round is SILENT about the row. Silence is the only shape that witnesses this
  // guard — a round that re-reports the row takes it through the matched pass,
  // which stamps the lapse notice whether or not the AC4 pass ran (measured:
  // both mutations left a re-reporting case green). With the guard in place the
  // AC4 pass skips the row and the round reports NOTHING about it.
  const f = makeFixture();
  try {
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
  // The anti-dead-code arm: a row stamped STRICTLY BEFORE the round's clock is
  // the row AC4 exists for and the guard must NOT skip it. Without this arm a
  // blanket `return;` at the top of the pass satisfied both witnesses above —
  // measured: the blanket-return mutant reddens here and nowhere else.
  const f = makeFixture();
  try {
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:222 live: the review identity resolved");
    const { row, ledger } = await retiredRowAtLastSeen(f.dir, f.headSha, pid!, NOW - 60_000);
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
}

// ---------------------------------------------------------------------------
// guard:181 — `if (r.firstSeen >= now) return undefined;` in `confirmedFor`
// ---------------------------------------------------------------------------

/** File an OPEN row through the real store at the caller's clock, then hand back
 * its stored bytes with `firstSeen` set to the caller's exact value.
 *
 * Same reason as `retiredRowAtLastSeen`: the store stamps `firstSeen` with the
 * filing round's `now`, so a store-driven row can never sit STRICTLY AFTER a
 * later round's clock — and `>=` versus `>` is only decided by a case that
 * does. The row is real (real id, hashes, filed by a real round); only its
 * filing stamp is moved. */
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
      // No `as LedgerEntry[]`: the object literal is checked against the entry
      // type, so a field the ledger's own reader would drop is a compile error
      // here rather than a fixture that silently stops being a candidate.
      ledger: [confirmRow(patchId, headSha, row.id, at)],
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
}

{
  // Anti-dead-code arm: a row filed STRICTLY BEFORE the round's clock IS
  // the row AC1 exists for, and the guard must not skip it.
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

{
  // The fixture's "was unset" branches, witnessed on the SHARED function. Both
  // pins are removed before `makeFixture`, so `priorEnv` holds two `undefined`s
  // and `releaseFixture` must reach its two `delete` branches. The assertion is
  // `!(NAME in process.env)` — NOT `=== undefined` — because on bun assigning
  // `undefined` leaves the key present holding the literal string "undefined",
  // which any consumer reading through `?.trim()` treats as a truthy path.
  // Biome's autofix for `delete x` produces exactly that assignment; measured,
  // all four confirmation tests stayed green under it while this case reddens —
  // which is why the property is asserted on `releaseFixture` itself.
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  delete process.env.PI_AGENT_DIR;
  resetFindingsStateCache();
  const f = makeFixture();
  try {
    assert(
      f.priorEnv.ledgerFile === undefined && f.priorEnv.agentDir === undefined,
      `release: the fixture recorded both pins as unset (${JSON.stringify(f.priorEnv)})`,
    );
    assert(
      "PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env &&
        "PI_AGENT_DIR" in process.env,
      "release: makeFixture installed both pins as own keys",
    );
  } finally {
    releaseFixture(f);
    const problems = assertUnset(f, "release");
    assert(
      problems.length === 0 &&
        !("PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env) &&
        !("PI_AGENT_DIR" in process.env),
      `release: a fixture whose pin was UNSET deletes it rather than storing "undefined" (${JSON.stringify([process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE, process.env.PI_AGENT_DIR])}, problems=${JSON.stringify(problems)})`,
    );
    removeFixture(f);
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
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
