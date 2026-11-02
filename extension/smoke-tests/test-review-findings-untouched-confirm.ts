#!/usr/bin/env bun
/**
 * #1934 — the UNTOUCHED-row confirmation, through the real store on a real clone.
 *
 * Split out of test-review-findings-confirmed-retire.ts for the AGENTS.md §12
 * 500-line gate (the untouched cases pushed it past the cap), and it is a real
 * seam rather than a truncation: everything here is the row the round did NOT
 * re-report, which is the case #1934 was written for and the only case whose
 * confirmation window is bounded by the ROUND's clock rather than the row's own
 * stamps.
 *
 * THE RULE THIS FILE EXISTS FOR. `confirmedFor` (review-findings-round.ts) hands
 * `confirmationsFor` a `{firstSeen, lastSeen}` window, and for an untouched row
 * the row's own `lastSeen` is a stamp an EARLIER round left behind. A genuine
 * confirmation is by definition recorded after the round that last reported the
 * row — so closing the window at that stale stamp makes `entry.at > lastSeen`
 * reject every real confirmation and the feature ships inert for untouched rows.
 * The bound is the round's clock. Both directions are asserted in one run:
 *
 *   - GREEN: an untouched row with a confirmation written after the previous
 *     round and before this one IS confirmed (this is the case that was red
 *     before the fix — it was the whole defect);
 *   - and STILL red where it must be: neither a RE-REPORTED row nor an untouched
 *     row retires on a confirmation written AFTER this round began. That is the
 *     trust boundary — a confirmation written while the lenses were reporting
 *     the finding, or after it, confirms nothing.
 *
 * Isolation comes from the shared fixture (lib/confirmation-store-fixture.ts):
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pins both the ledger and the findings store
 * into the fixture dir, so a round reads and writes only this test's files.
 */

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

import {
  makeFixture,
  okFixture,
  releaseFixture,
  removeFixture,
  rowsOf,
  rowsOk,
  seed,
  seedOk,
  setupOk,
  silentRound,
  writeLedger,
  type SeedResult,
  type SetupOutcome,
} from "./lib/confirmation-store-fixture.ts";
import { asSetup } from "./lib/confirmation-store-fixture.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";
import { execp } from "../src/exec.ts";
import path from "node:path";
import { FINDING, recordFindingRunOutcome } from "./lib/confirmation-store-fixture.ts";

/** Setup channels: a fault is a NAMED RED plus a `break` out of the case's
 * labelled block, never a `throw` that escapes a case whose `try` has not
 * opened. Bound to this file's `assert` because an imported helper module cannot
 * own a test file's exit code. See `confirmation-store-fixture.ts` for the shape
 * and for the measurement behind it (pre-channel, one neutralised setup step
 * printed 2 lines and every later case silently did not run). */
const needSeed = (s: SeedResult, label: string) => seedOk(s, label, (m) => assert(false, m));
const needRows = (
  r: { rows: StoredFinding[]; problem: string },
  label: string,
): r is { rows: StoredFinding[]; problem: "" } => rowsOk(r, label, (m) => assert(false, m));
const needRound = (o: SetupOutcome, label: string) =>
  setupOk(o, label, (m) => assert(false, m));


untouched_case: {
  // HIGH 2 — the UNTOUCHED-row arm. A row this round did NOT re-report is the
  // case #1934 was written for (a fix in another file, the lenses silent about
  // it), and the confirmation that retires it is by definition written AFTER
  // the round that last reported it. The window `confirmedFor` hands the join
  // for such a row must therefore close at the ROUND'S clock, not at the stale
  // `lastSeen` an earlier round stamped: with the stale bound, `entry.at >
  // seen.lastSeen` rejects every genuine confirmation and the feature is inert
  // for untouched rows.
  const f = makeFixture();
  try {
    // Round 1 reports the finding, so the row's `firstSeen`/`lastSeen` are both
    // in the PAST by the time the round under test runs.
    if (!okFixture(f, "untouched", (m) => assert(false, m))) break untouched_case;
    const seeded = await seed(f.dir, f.headSha);
    if (!needSeed(seeded, "untouched: seed")) break untouched_case;
    const row = seeded.row;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, "untouched: the review identity resolved");
    // The confirmation is recorded BETWEEN the two rounds: after the round that
    // last reported the row, before the round under test. That interval is the
    // only place a real confirmation can exist for an untouched row.
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
    const read1 = await rowsOf(f.dir);
    if (!needRows(read1, "untouched: baseline read")) break untouched_case;
    const reReported = read1.rows.find((r) => r.id === row.id);
    assert(
      reReported?.status === "open" && reReported.lastSeen <= Date.now(),
      `untouched baseline: the seeded row is open with a stale lastSeen (${reReported?.status}/${reReported?.lastSeen})`,
    );
    // Round 2: a complete full round that does NOT report the finding at all —
    // the row is untouched — with the confirmation consulted.
    const out = await silentRound(f.dir, f.headSha, pid!, Date.now() + 10_000);
    // The channel is CALLED at each use, not captured once into a boolean. The
    // narrowing a type predicate produces belongs to the CALL, so `const ok =
    // needRound(out, …)` left the compiler on both arms of the union below and
    // the disclosure read beside it would not have type-checked.
    assert(needRound(out, "untouched: silent round"), `untouched: the round recorded (${out.problem || "ok"})`);
    if (!needRound(out, "untouched: silent round")) break untouched_case;
    // First point where the compiler knows `out` is the recorded arm, so
    // `out.resolved` below is read through the guard rather than beside it.
    const recorded = out;
    const read2 = await rowsOf(f.dir);
    if (!needRows(read2, "untouched: read after retire")) break untouched_case;
    const after = read2.rows.find((r) => r.id === row.id);
    assert(
      after?.status === "resolved" && after.resolvedReason === "confirmed",
      `untouched: a confirmation written after the last report retires the row the round did NOT touch (${after?.status}/${after?.resolvedReason})`,
    );
    assert(
      typeof after?.confirmedBy === "string" && after.confirmedBy.includes(`#${row.id}`),
      `untouched: the retirement names the confirmation it stood on (${JSON.stringify(after?.confirmedBy)})`,
    );
    // The disclosure this retirement must produce — asserted here rather than
    // only in the render sibling, because this is the path that produced no
    // notice at all while the row was retired.
    assert(
      (recorded ? out.resolved : []).some(
        (r) => r.rowId === row.id && r.reason === "confirmed" && r.confirmedBy !== undefined,
      ),
      `untouched: the resolved notice carries its provenance (${JSON.stringify(recorded ? out.resolved : null)})`,
    );
    // --- and the trust boundary in the SAME run: a row this round RE-REPORTED
    // must not retire on a confirmation written while the round was running.
    // Snapshot the OUTER pins at the moment the inner fixture is created. The
    // assertion in f2's finally compares against THIS, not against a value
    // re-read at release time: the record the fixture kept is the contract, and
    // a value re-read later would let an unrelated release anywhere in the file
    // decide the outcome.
    const outerPins = {
      ledger: process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE,
      agent: process.env.PI_AGENT_DIR,
    };

    const f2 = makeFixture();

    try {
      assert(
        process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === f2.ledgerFile,
        `nested fixture: the inner makeFixture re-pins the ledger to its own dir (${process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE})`,
      );
      const seeded2 = await seed(f2.dir, f2.headSha);
      if (!needSeed(seeded2, "re-reported: seed")) break untouched_case;
      const row2 = seeded2.row;
      const pid2 = (await workingTreePatchId(execp, f2.dir)).patchId;
      assert(pid2 !== undefined, "re-reported: the review identity resolved");
      const roundNow = Date.now() + 10_000;
      writeLedger(f2.ledgerFile, [
        {
          branch: "feature/work",
          kind: "adversarial",
          patchId: pid2!,
          passed: true,
          // Recorded AFTER this round began: evidence written while (or after)
          // the lenses were reporting the finding. Confirms nothing.
          at: roundNow + 5_000,
          headSha: f2.headSha,
          rowId: row2.id,
          round: 2,
        },
      ]);
      const during = asSetup(
        await recordFindingRunOutcome({
          cwd: f2.dir,
          branch: "feature/work",
          headSha: f2.headSha,
          findings: [FINDING],
          review: "full",
          confirmFixes: true,
          patchId: pid2!,
          now: roundNow,
        }),
        "re-reported",
      );
      assert(needRound(during, "re-reported: round"), `re-reported: the round recorded (${during.problem || "ok"})`);
      if (!needRound(during, "re-reported: round")) break untouched_case;

      const readF2 = await rowsOf(f2.dir);
      if (!needRows(readF2, "re-reported: read")) break untouched_case;
      const stillOpen = readF2.rows.find((r) => r.id === row2.id);
      assert(
        stillOpen?.status === "open" && stillOpen.resolvedReason === undefined,
        `trust boundary: a re-reported row does NOT retire on a confirmation written during the round (${stillOpen?.status}/${stillOpen?.resolvedReason})`,
      );
    } finally {
      // NESTING HAZARD, asserted rather than assumed. This fixture is created
      // INSIDE f's pins, so what f2 recorded as `priorEnv` IS f's pins, and
      // releasing f2 must write them back. The release runs HERE, in this
      // finally, so the assertion judges the release itself; the expectation is
      // the snapshot taken just before f2 was created, which is what makes this
      // red against a release that deletes instead of restoring
      // (`got=undefined`) and green under a restorable one.
      // The release happens HERE, in the finally, so the assertion judges the
      // release and not the state before it.
      releaseFixture(f2);
      assert(
        process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === outerPins.ledger &&
          process.env.PI_AGENT_DIR === outerPins.agent,
        `nested fixture: releasing the inner fixture restores the OUTER pins, not nothing (want=${String(outerPins.ledger)}, got=${String(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)})`,
      );
      removeFixture(f2);
    }
    // A bound confirmation that must NOT be consulted: an UNTOUCHED row whose
    // confirmation is recorded after this round began. Before HIGH 2's fix the
    // window closed at the row's stale `lastSeen` and this refused for the wrong
    // reason; with `now` as the bound it is `confirmedFor`'s own re-report test
    // that refuses. Either way the answer is open — a confirmation written during
    // the round never retires anything.
    const f3 = makeFixture();
    try {
      if (!okFixture(f3, "untouched-trust", (m) => assert(false, m))) break untouched_case;
      const seeded3 = await seed(f3.dir, f3.headSha);
      if (!needSeed(seeded3, "untouched-trust: seed")) break untouched_case;
      const row3 = seeded3.row;
      const pid3 = (await workingTreePatchId(execp, f3.dir)).patchId;
      assert(pid3 !== undefined, "untouched-trust: the review identity resolved");
      const when = Date.now() + 10_000;
      writeLedger(f3.ledgerFile, [
        {
          branch: "feature/work",
          kind: "adversarial",
          patchId: pid3!,
          passed: true,
          at: when + 5_000,
          headSha: f3.headSha,
          rowId: row3.id,
          round: 2,
        },
      ]);
      // The round is silent about the row — untouched — and the confirmation
      // post-dates the round. Silence is not evidence and a late confirmation is
      // not evidence; the row carries.
      const late = await silentRound(f3.dir, f3.headSha, pid3!, when);
      assert(needRound(late, "untouched-trust: round"), `untouched-trust: the round recorded (${late.problem || "ok"})`);
      if (!needRound(late, "untouched-trust: round")) break untouched_case;
      const readF3 = await rowsOf(f3.dir);
      if (!needRows(readF3, "untouched-trust: read")) break untouched_case;
      const openStill = readF3.rows.find((r) => r.id === row3.id);
      assert(
        openStill?.status === "open" && openStill.resolvedReason === undefined,
        `trust boundary: an UNTOUCHED row does NOT retire on a confirmation written after the round began (${openStill?.status}/${openStill?.resolvedReason})`,
      );
    } finally {
      removeFixture(f3);
    }
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
  break untouched_case;
}

process.exit(exit);

