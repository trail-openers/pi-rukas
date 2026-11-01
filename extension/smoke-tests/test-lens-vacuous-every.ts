#!/usr/bin/env bun
/**
 * The vacuous-`every` guard in `runLensFanOut`'s liveness test.
 *
 * `allLanesProducedEvidence` was `results.every(...)` over the HEALTHY lanes
 * only. `[].every(...)` is TRUE, so a roster with ZERO healthy lanes answered
 * the liveness question YES by nobody, and a single merged `extraFindings` row
 * then satisfied `hasFindingClaimedFile`: a round that reviewed nothing earned
 * the positive coverage claim. `computeVerdict` still returned REVIEW_INCOMPLETE
 * for the blocked rows, so the ✓ printed on the same report as the refusal —
 * and a later reader who reads the ✓ alone acts on it. The guard is
 * `results.length > 0 &&` in `lens-review-fanout.ts`.
 *
 * Split out of `test-lens-coverage-denominator.ts` by the 500-line gate. That
 * file pins the pure accounting; this one pins the one rule the accounting could
 * get wrong by asking nobody.
 *
 * Two shapes look like a zero-healthy-lane round and are not, so both are
 * avoided here (see `lib/lens-vacuous-every-fixture.ts`): an installed skills
 * dir with no `code-review-*` dir at all diverts to the empty-roster install
 * exit BEFORE the fan-out, and a `lensChildFn` stub that RETURNS blocked rows
 * fills the roster's blocked list, not `results`.
 *
 * MUTATION PROOF — measured 2026-11-XX, each by editing the named product
 * file, running this test, and restoring it byte-identically.
 *   - revert the liveness guard to the bare `results.every(...)` → REDS the
 *     "earns NO positive coverage claim" canary.
 *   - drop the `results.length > 0` gate on the ACCOUNTING list → REDS the
 *     `unaccounted` canary (both files come back accounted).
 *   - delete the `extraFindings` rows from `claimedEvidence` in
 *     `lens-review-fanout.ts` → REDS `extraFindingsOf`'s premise (`claimed`
 *     flips true→false and the assertion below fails). Before this run the
 *     field had NO positive witness at all — its only test reader was
 *     `=== false` — so this is the mutation the file used to survive.
 *   - `extraFindingsOf`'s third conjunct ("no lens row carries a finding for
 *     that file") is a copy-paste guard over an input the other conjuncts
 *     already pin; no single-input mutation falsifies it on its own. It is
 *     harmless and stays, but the helper witnesses THREE things, not the four
 *     this header used to claim.
 */

import { runLensFanOut } from "../src/lens-review-fanout.ts";
import { renderSummary } from "../src/lens-review-render.ts";
import { runLensReview } from "../src/lens-review.ts";
import {
  CHANGED_A,
  CHANGED_B,
  THREE_FILE_DIFF,
  finding,
  lens,
  mkClone,
  teardown,
} from "./lib/lens-coverage-fixture.ts";
import { blockedRosterEntry, healthyRosterEntry, passthroughModelSlot } from "./lib/lens-vacuous-every-fixture.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Did the harness rows a fan-out was handed actually reach its ACCOUNTING list?
 *
 * `LensFanOut` keeps no copy of `extraFindings` and the accounting list itself
 * is not returned, so this helper cannot read the rows back — it observes what
 * their presence CHANGES. `runLensFanOut` merges each harness row as its own
 * evidence row (`extraFindings.map(f => ({ findings: [f] }))`) into
 * `accountedEvidence`, the only list the returned `unaccounted` is derived
 * from. So in a probe round whose single healthy lane answers with PROSE ONLY
 * and names no file, a denominator file coming back accounted for can only mean
 * the harness row was merged. Four observations, all read off the returned
 * fields, so the helper can be FALSE:
 *
 *   - the round had a denominator at all;
 *   - the harness row earned the POSITIVE claim — `findingClaimedFile` is true,
 *     which is the only place in the suite that reads that field in the
 *     affirmative (its other readers assert `=== false`, so a regression that
 *     stops a `CLAIM_SCAN` witness from ever earning the ✓ used to ship
 *     silently);
 *   - the cited file is absent from `unaccounted` while the two nobody cited
 *     are present — the same accounting list, not an empty one;
 *   - no lens row carries a finding for that file (so the row that claimed it
 *     was the merged harness row, not a lane);
 *   - the lane really did speak the prose-only summary the probe is built on.
 *
 * The last two are guards over an input the others already fix and are not
 * independently falsifiable; see MUTATION PROOF at the top of the file.
 *
 * The old body was `return true`, which asserted "the round was handed harness
 * rows" while checking NOTHING — in the test that exists to catch a coverage
 * claim earned by nobody, an always-true helper is the wrong shape.
 */
async function extraFindingsOf(): Promise<boolean> {
  const probe = await runLensFanOut({
    // ONE healthy lane that answers with prose only, so the round is a LIVE
    // one — `runLensFanOut` gates the harness rows behind `results.length > 0`,
    // and with zero healthy lanes they never enter the accounting at all, which
    // is the very rule the canary below pins.
    healthy: [healthyRosterEntry()],
    blocked: [],
    lensChildFn: (async () => lens("SECURITY", [], "the code is fine from this lens")) as never,
    runId: "vacuous-every-witness",
    skillsDir: "unused",
    context: "",
    roster: [healthyRosterEntry()],
    opts: { diff: "" } as never,
    bumpBatch: () => {},
    batchKey: "vacuous-every-witness/batch",
    modelSlot: passthroughModelSlot as never,
    resolved: { kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF },
    extraFindings: [finding("src/a.ts")],
  });
  return (
    probe.hasDenominator &&
    // The POSITIVE witness: this is the only assertion in the suite that asks
    // whether the claim was EVER earned. Every other reader of
    // `findingClaimedFile` asks whether it was refused.
    probe.findingClaimedFile === true &&
    probe.unaccounted.join(",") === "src/b.ts,src/c.ts" &&
    probe.lensResults.every((r) => !r.findings.some((f) => f.path === "src/a.ts")) &&
    probe.lensResults.some((r) => r.summary === "the code is fine from this lens")
  );
}

// The fan-out itself — the seam that OWNS the liveness test.
{
  const blockedRoster = [blockedRosterEntry()];
  const blockedOut = await runLensFanOut({
    healthy: [],
    blocked: blockedRoster,
    // Never reached — there is no healthy entry — but a stub that returns
    // evidence keeps the arm honest: were a lane ever to run, the liveness test
    // would pass for a real reason and this arm would be testing nothing.
    lensChildFn: (async () => lens("SECURITY", [], "reviewed everything")) as never,
    runId: "vacuous-every",
    skillsDir: "unused",
    context: "",
    roster: blockedRoster,
    opts: { diff: "" } as never,
    bumpBatch: () => {},
    batchKey: "vacuous-every/batch",
    modelSlot: passthroughModelSlot as never,
    // A COMPUTED two-file diff: with no denominator the claim is refused for
    // condition (1) and the arm never reaches the liveness test at all.
    resolved: { kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF },
    // The round's ONLY evidence: one deterministic CLAIM_SCAN-shaped row citing
    // a file inside the denominator.
    extraFindings: [finding("src/a.ts")],
  });
  assert(
    blockedOut.hasDenominator && blockedOut.lensResults.every((r) => r.blocked === true),
    "premise: a real denominator and zero healthy lanes — the vacuous case, not an empty round",
  );
  assert(
    blockedOut.findingClaimedFile === false,
    "canary: a blocked-only round earns NO positive coverage claim — an empty healthy set is not liveness",
  );
  // The DISCLOSURE half of the same lie. `extraFindings` used to join the
  // accounting list unconditionally, so on a round where NO lane ran, harness
  // rows citing both denominator files left `unaccounted: []` — a report that
  // disclosed no gap at all on a review that reviewed nothing. A grep the
  // harness ran is not somebody reading the file.
  // MUTATION-PROOF: drop the `results.length > 0` guard on the accounting list
  // in `lens-review-fanout.ts` and this reddens (both files come back accounted).
  const bothCited = await runLensFanOut({
    healthy: [],
    blocked: blockedRoster,
    lensChildFn: (async () => lens("SECURITY", [], "reviewed everything")) as never,
    runId: "vacuous-every-both",
    skillsDir: "unused",
    context: "",
    roster: blockedRoster,
    opts: { diff: "" } as never,
    bumpBatch: () => {},
    batchKey: "vacuous-every-both/batch",
    modelSlot: passthroughModelSlot as never,
    resolved: { kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF },
    // BOTH denominator files cited, by harness rows and by nobody else.
    extraFindings: [finding("src/a.ts"), finding("src/b.ts")],
  });
  assert(
    bothCited.hasDenominator &&
      bothCited.lensResults.every((r) => r.blocked === true) &&
      // The harness rows really do reach the fan-out's accounting list (see
      // `extraFindingsOf`), so the `unaccounted` canary below is measuring a
      // round that WAS handed them and refused to count them.
      await extraFindingsOf(),
    "premise: a zero-healthy roster over a real denominator, with harness rows as its only evidence",
  );
  assert(
    bothCited.unaccounted.join(",") === "src/a.ts,src/b.ts,src/c.ts",
    `canary: harness rows alone disclose NO gap on a round where nobody ran — every denominator file stays unaccounted (got ${JSON.stringify(bothCited.unaccounted)})`,
  );
  // The other arm, so the guard above is not "harness rows never count": with
  // ONE healthy lane having run, the same two rows account for what they cite.
  const oneHealthy = await runLensFanOut({
    healthy: [healthyRosterEntry()],
    blocked: blockedRoster,
    lensChildFn: (async () => lens("SECURITY", [], "the code is fine from this lens")) as never,
    runId: "vacuous-every-one",
    skillsDir: "unused",
    context: "",
    roster: [healthyRosterEntry(), ...blockedRoster],
    opts: { diff: "" } as never,
    bumpBatch: () => {},
    batchKey: "vacuous-every-one/batch",
    modelSlot: passthroughModelSlot as never,
    resolved: { kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF },
    extraFindings: [finding("src/a.ts"), finding("src/b.ts")],
  });
  assert(
    oneHealthy.unaccounted.join(",") === "src/c.ts",
    `canary: with one healthy lane having RUN, the same harness rows do account for the files they cite (got ${JSON.stringify(oneHealthy.unaccounted)})`,
  );
}

// The same round one level up, through the real review entry point, so the stamp
// the RENDERER reads is the one under test and not only the fan-out's.
{
  const c = mkClone({ skills: "unusable" });
  try {
    let write: Promise<unknown> = Promise.resolve();
    const summary = await runLensReview({
      cwd: c.repo,
      branch: "feat/x",
      head: c.head,
      base: c.base,
      full: true,
      // All six installed skills fail to parse, so the roster is six NAMED
      // blocked lanes and `runLensFanOut`'s `results` is `[]`.
      lensChildFn: (async (args: { lens: { name: string } }) =>
        lens(args.lens.name, [], "reviewed everything, nothing to report")) as never,
      // The round's only evidence, exactly as the caller merges CLAIM_SCAN rows.
      extraFindings: [finding(CHANGED_A)],
      onLedgerWrite: (w: Promise<unknown>) => {
        write = w;
      },
    });
    await write;
    assert(
      // Every denominator file stays unaccounted on a zero-healthy round: the
      // merged harness row counts for NOTHING until a lane has actually run
      // (`results.length > 0` gates both lists in `lens-review-fanout.ts`).
      // This used to read `=== CHANGED_B` — the row accounted for its file while
      // nobody reviewed — and that expectation is what this assertion now pins
      // the other way.
      summary.unaccountedFiles?.join(",") === [CHANGED_A, CHANGED_B].join(","),
      `premise: a real two-file denominator whose only evidence is a merged harness row, disclosed as a gap for BOTH files (got ${JSON.stringify(summary.unaccountedFiles)})`,
    );
    assert(
      summary.verdict === "REVIEW_INCOMPLETE" &&
        summary.lenses.length > 0 &&
        summary.lenses.every((r) => r.blocked === true),
      "premise: every lane blocked, and the round is refused at the verdict level",
    );
    assert(
      !renderSummary(summary, 3).includes("✓ COVERAGE"),
      "canary: the ✓ COVERAGE line does not print on a blocked-only round's report",
    );
  } finally {
    teardown(c);
  }
}

process.exit(exit);
