#!/usr/bin/env bun
/**
 * #1934 — the three candidate constructions for the `guard:181` lower-bound
 * witness the previous round deleted, split from
 * `test-review-findings-window-guards.ts` by the AGENTS.md §12 500-line gate.
 * Same frozen clock (`lib/window-guards-clock.ts`) and same helpers, so a case
 * here witnesses the identical comparison the sibling file's `boundary` arms do.
 *
 * WHY THESE CASES EXIST RATHER THAN AN ARGUMENT. The prior round deleted
 * `guard:181 relax` reasoning that with `firstSeen > now` no stamp makes the
 * case discriminate — the join's own lower bound (`entry.at < seen.firstSeen`,
 * review-confirmation.ts) drops the candidate before this round's guard is
 * reached — and the adversarial gate, sweeping five window relations, agreed.
 * Two lenses then claimed a discriminating case does exist, and a third said
 * the deletion was correct while a slack arm remained constructible. That is
 * not resolvable by weighing who sounds confident, so each claim was BUILT:
 * the reconcilable reading is that the lenses described `firstSeen` STRICTLY
 * BEFORE the clock with the confirmation landing BETWEEN the bounds, which the
 * reviewer never tested.
 *
 * WHAT WAS MEASURED, per mutation of the one comparison
 * (`if (r.firstSeen >= now) return undefined;`) in a scratch copy of
 * `src/review-findings-round.ts`, each mutant controlled by blob hash plus a
 * one-line diff so an escape-byte no-op cannot report a green it did not earn:
 *
 *   - DELETED            → `boundary` (in the sibling file) reddens;
 *   - RELAXED `>=` → `>` → `boundary` reddens;
 *   - SLACK `>= now - 100`   → THIS file's `slack` reddens — the only case in
 *                              the repo that pins a shift of the compared
 *                              CONSTANT rather than of the operator;
 *   - SLACK `>= now - 10000` → `between` AND `slack` both redden;
 *   - NEVER (`if (false)`)   → `boundary` reddens;
 *   - RELAXED `>=` → `>`     → `boundary` reddens and NOTHING in this file
 *                              reddens. Re-measured per the lens claim that a
 *                              `between`-style case discriminates at
 *                              `at = row.firstSeen + 5_000`; the construction
 *                              was built exactly as named (`firstSeen = NOW -
 *                              1001`, `at = NOW - 900`) and stayed green.
 *
 * So a discriminating case for the GUARD does exist and is `boundary`; the
 * CONSTANT is pinned by `slack`. What the two lenses named —
 * `openRowAtFirstSeen(…, NOW - 1001)` with the confirmation at `NOW - 900`, a
 * stamp landing BETWEEN the bounds with `firstSeen < now` — was BUILT (it is
 * `between` above) and measured under every mutant of the guard, including the
 * `>=` → `>` relaxation the claim was made about: `between` is GREEN under all
 * five. Its own header's reasoning explains why and the measurement confirms
 * it — `>=` and `>` agree for any `firstSeen` strictly before the clock, so
 * that construction witnesses the guard's presence but not its operator. So
 * `guard:181 relax` in the sibling file stays labelled what it is: a
 * PRECONDITION, excluded from the witness count, which now stands at THREE
 * (`boundary` for the deletion / relaxation / never mutants, `slack` for the
 * compared constant, and `between` for the guard's presence), not four.
 */

import { execp } from "../src/exec.ts";
import {
  FINDING,
  makeFixture,
  okFixture,
  releaseFixture,
  removeFixture,
} from "./lib/confirmation-store-fixture.ts";
import { NOW } from "./lib/window-guards-clock.ts";
import {
  HEAD_OF,
  confirmRow,
  openRowAtFirstSeen,
} from "./lib/window-guards-helpers.ts";
import { applyFindingRound } from "../src/review-findings-round.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Record a setup fault as a NAMED RED, and tell the caller to skip the rest of
 * its case. Deliberately not a throw: these setup helpers run before the
 * caller's `try` is entered, so a bare `throw` aborts the whole file on an
 * unhandled exception and the run reports ZERO `✗` lines with every case green
 * — the case whose fixture failed never ran, which is how a broken setup reads
 * as a pass. An assertion plus a `break` out of the case's labelled block gives
 * the red, sets the exit code, and lets every other case still run. */
function assertSetup(
  setup: { row?: StoredFinding; problem: string },
  label: string,
): setup is { row: StoredFinding; problem: string } {
  const ok = setup.problem === "" && setup.row !== undefined;
  assert(ok, `${label}: the shared setup built the fixture (${setup.problem || "ok"})`);
  return ok;
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
    findings: [FINDING] as Finding[],
    mine: [row],
    taken: new Set([row.id]),
    headOf: HEAD_OF,
    review: "full",
    confirmations: {
      ledger: [confirmRow(patchId, headSha, row.id, at)],
      patchId,
      headSha,
    },
    // #2040 — no lens children in this fixture: see `runRound`.
    evidence: new Map(),
    now: NOW,
  });

// --- candidates for the `guard:181 relax` witness the last round deleted ----
//
// The last round deleted `guard:181 relax` on the reasoning that with
// `firstSeen > now` no confirmation stamp makes the case discriminate: the
// join's own lower bound (`entry.at < seen.firstSeen`, review-confirmation.ts)
// drops the candidate before this round's guard is reached. Three reviewers
// then disagreed about whether ANY discriminating case exists, so the question
// was settled by construction rather than by adjudication — see the header for
// which candidates redden under which mutation.

guard_case: {
  // CANDIDATE A — `firstSeen` strictly BEFORE the round's clock, with the
  // confirmation stamped strictly BETWEEN the two bounds
  // (`firstSeen < at <= now`). This is the interval the two lenses described
  // and the last round never constructed. MEASURED, per the exact values they
  // named: this case is GREEN under `>=` → `>`, so it does not witness the
  // operator as they claimed — the guard's presence, yes (it reddens under the
  // deletion via `boundary`'s sibling reasoning), its operator, no.
  // `>=` accepts it (a row filed before the round may be retired); `>` also
  // accepts it, so the mutation that reddens this case is the guard's DELETION
  // paired with `boundary` — it is the arm that keeps `boundary` from being the
  // only thing standing between the guard and a blanket `return undefined`.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:181 between", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 between: the review identity resolved");
    const setup = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW - 1001);
    if (!assertSetup(setup, "guard:181 between")) break guard_case;
    const row = setup.row;
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

guard_case: {
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
    if (!okFixture(f, "guard:181 slack", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 slack: the review identity resolved");
    const setup = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW - 11);
    if (!assertSetup(setup, "guard:181 slack")) break guard_case;
    const row = setup.row;
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

guard_case: {
  // CANDIDATE C — the shape the other two lenses named: `firstSeen` STRICTLY
  // AFTER the round's clock, with a confirmation stamped between the round's
  // clock and the row's stamp. The prior round's claim was that the interval
  // is empty — every `at` is either `< firstSeen` (dropped by the join's lower
  // bound) or `> now` (dropped by the round's upper bound). This case is the
  // falsification test for that claim: if a stamp existed that made `>=` and
  // `>` disagree, this case reddens under one of them.
  const f = makeFixture();
  try {
    if (!okFixture(f, "guard:181 future", (m) => assert(false, m))) break guard_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "guard:181 future: the review identity resolved");
    const setup = await openRowAtFirstSeen(f.dir, f.headSha, pid!, NOW + 5_000);
    if (!assertSetup(setup, "guard:181 future")) break guard_case;
    const row = setup.row;
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

process.exit(exit);
