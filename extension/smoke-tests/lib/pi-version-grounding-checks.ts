#!/usr/bin/env bun
/**
 * The census-consistency block of `../test-pi-version-drift.ts`, moved here VERBATIM
 * (code AND comments) when the arm canary grew its pairing assertion and the gate file
 * passed the 500-line cap of AGENTS.md § 12. Moved, not compressed: every paragraph in
 * this file states a reason a check exists, and the comment-retention gate treats a lost
 * one as a loss. Intentionally NOT named test-*.ts — verify-loop.sh runs only test-*.ts
 * as tests; coverage comes through test-pi-version-drift.ts, which calls
 * `runCensusGroundingChecks` at module load.
 */
import {
  type ClaimDetector,
  type GroundingCitation,
  declaredGroundingTable,
} from "./pi-version-census.ts";
import {
  NO_CITATIONS_MARKER,
  armRelaxed,
  armUnmatched,
  censusGroundingErrors,
  maskBarrierClaims,
} from "./pi-version-grounding.ts";

/**
 * The single-citation edit each arm alone can refuse (a wrong gap is invisible to
 * the quote/marker tests, a wrong quote to the gap re-derivation).
 * BOTH corruptions keep the CLAIM COUNT unchanged on purpose: `armUnmatched`
 * short-circuits a row whose count moved and never calls the relaxed predicate, so a
 * count-moving corruption leaves the canary green with `armRelaxed` reduced to
 * `() => true` — measured, and the shipped defect this corrects. Bumping `gap`, or
 * swapping the quote's final character, moves neither count, so `pairCitations` runs
 * and `anchorsShips` must refuse on the FIELD itself while `armRelaxed` accepts.
 * Row 0's SECOND citation is the one corrupted: the first two claims of that row
 * quote the same `MIN_PI_VERSION` text, so under a relaxed arm the corrupted first
 * citation re-pairs with the other claim and no row goes unmatched — the corruption
 * has to land where the claims are distinguishable.
 */
const FIRST = (t: Record<string, Record<string, GroundingCitation[]>>) =>
  Object.values(t).flatMap(Object.values)[0]!;
const CORRUPT_FOR: Record<
  "gap" | "quote",
  (t: Record<string, Record<string, GroundingCitation[]>>) => void
> = {
  // MUTATION-ARM-CORRUPTION: `[1]` is the claim-count-preserving choice the canary
  // requires. `[0]` was the shipped one and is kept selectable from the environment
  // because it is the control this canary's own witness is judged against: bumping the
  // FIRST citation's gap moves that row's claim count, `armUnmatched` then short-circuits
  // the row, and a relaxed predicate reduced to `() => true` still reports "witnessed".
  // Setting PI_TEST_ARM_CORRUPTION=first reproduces exactly that, so the pair
  // (corruption choice, `pairedRows` assertion) is itself a checked fact.
  gap: (t) => {
    FIRST(t)[process.env.PI_TEST_ARM_CORRUPTION === "first" ? 0 : 1]!.gap += 1;
  },
  quote: (t) => {
    const c = FIRST(t)[process.env.PI_TEST_ARM_CORRUPTION === "first" ? 0 : 1]!;
    c.quoted = `${c.quoted.slice(0, -1)}\u002e`;
  },
};

/**
 * The grounding facts the census comments rely on are DERIVED here from the two
 * files' actual bytes: per cited literal the detector's CLAIM SET (`detected ==
 * declared`) plus, per occurrence, the MARKER NAME, the QUOTED TEXT and the
 * FORWARD GAP the comment claims. A fact the gate computes cannot rot - the ~26
 * lines of hand-copied line numbers, marker names and gaps this replaces were
 * wrong in three consecutive rounds because transcription drifts and nothing
 * checked it. No comment cites a line address, so none can be off by one;
 * occurrences are identified by quoted text plus marker. Both files are read WHOLE.
 *
 * `detect` is injected by the gate: the census lib cannot import the file that imports
 * it, so the one `piClaimContexts` answers for the whole gate. `read` is the gate's own
 * repo-root-relative reader, so the grounding check judges the SAME bytes the census does.
 */
export function runCensusGroundingChecks(
  assert: (cond: boolean, msg: string) => void,
  read: (rel: string) => string,
  detect: ClaimDetector,
): void {
  const gateRel = "extension/smoke-tests/test-pi-version-drift.ts";
  const censusRel = "extension/smoke-tests/lib/pi-version-census.ts";
  const textByFile: Record<string, string> = {
    [gateRel]: read(gateRel),
    [censusRel]: read(censusRel),
  };
  const expected = declaredGroundingTable(gateRel, censusRel);
  const literalCount = Object.values(expected).reduce(
    (n, byLit) => n + Object.keys(byLit).length,
    0,
  );
  const citationCount = Object.values(expected).reduce(
    (n, byLit) => n + Object.values(byLit).reduce((m, list) => m + list.length, 0),
    0,
  );
  // A coverage floor (analogue of `declared >= 10` on the site census): both
  // canaries below count against a number DERIVED from this table, so a deleted row
  // shrinks its own coverage — the table passing by shrinking is the failure mode.
  assert(
    literalCount >= 3 && citationCount >= 9,
    `census grounding: ${literalCount} literals / ${citationCount} citations checked — at least the three (file, literal) rows and the citations this gate documents; a row deleted here must redden rather than narrow the check`,
  );
  const groundingErrors = censusGroundingErrors(textByFile, expected, detect);
  assert(
    groundingErrors.length === 0,
    `census grounding: the detector's claims match the cited markers, quotes and gaps${groundingErrors.length ? " — " + groundingErrors.join(" | ") : " (no hand-transcribed figure is stale)"}`,
  );
  // A gate never observed to fail is not a gate: a detector that finds no claims
  // must redden every literal checked — counting COMPARISONS, not rows declared (see
  // NO_CITATIONS_MARKER for why guard refusals cannot count toward it).
  const failClosed = censusGroundingErrors(textByFile, expected, () => []);
  const failClosedReal = failClosed.filter((s) => !s.includes(NO_CITATIONS_MARKER)).length;
  assert(
    failClosedReal === literalCount,
    `canary: census grounding fails CLOSED — a detector that finds no claims reddens every literal checked (got ${failClosedReal} detector-vs-citation errors, expected one per checked literal; ${failClosed.length - failClosedReal} were vacuity refusals, which prove nothing)`,
  );
  // Same standard on the other half. `citesMarker`'s whole-name test is UNWITNESSED
  // (canary deleted, not grown): its citation's quote and gap are both derived FROM
  // that marker, so a wrong-family citation gets refused by the gap arm regardless —
  // nothing left for it to catch. UNCOVERED: substring-matching that test survives.
  for (const arm of ["gap", "quote"] as const) {
    // MUTATION-EXPECTED-ROWS: perturbs ONE arm's expected row count so the
    // `pairedRows` half of the canary below is shown to bite rather than decorate
    // — without it, dropping the assertion would be unobservable. A clone, so the
    // grounding checks above keep seeing the real table.
    const armTable = structuredClone(expected);
    if (process.env.PI_TEST_EXPECTED_ROWS_OFF_BY_ONE === "1" && arm === "gap") {
      (armTable[censusRel] as Record<string, GroundingCitation[]>)["1.4.0"] = [];
    }
    // MUTATION-ARM-ALWAYS-TRUE: the relaxed predicate reduced to `() => true`, every
    // relaxation at once — the mutation that exposed the shipped defect. With the FIRST
    // citation corrupted (PI_TEST_ARM_CORRUPTION=first: a claim-count move, so
    // `armUnmatched` short-circuits the row and neither predicate is called) this run is
    // GREEN and both canaries still print "witnessed", which is the bug; with the shipped
    // claim-count-preserving corruption it is RED. The hit counter is what keeps a
    // mutation that never executed from being read as evidence either way.
    const mutated = process.env.PI_TEST_ARM_ALWAYS_TRUE === "1";
    let relaxedHits = 0;
    const relaxed: ArmMutation = mutated ? () => ((relaxedHits += 1), true) : armRelaxed(arm);
    const w = armUnmatched(textByFile, armTable, detect, CORRUPT_FOR[arm], relaxed);
    const expectedRows = Object.values(armTable).reduce(
      (n, byLit) => n + Object.keys(byLit).length,
      0,
    );
    assert(
      w.shipped >= 1 && w.relaxed === 0 && w.pairedRows === expectedRows,
      `canary: census grounding arm \`${arm}\` is witnessed — shipped rejected the corrupted citation (${w.shipped} unmatched), neutering this one arm let it pair again (${w.relaxed}), and the relaxed predicate was actually invoked (${w.pairedRows}/${expectedRows} rows reached pairing); both 0 = the corruption does not exercise this arm, both >=1 = the arm refuses nothing, pairedRows below the row count = the corruption moved the claim count so the count check fired while the relaxed half never ran`,
    );
    // The always-true mutation of `armRelaxed` is what tells a real witness from a
    // tautology, so when it is switched on the gate asserts the branch really ran:
    // a run that never reached the relaxed arm must not count as evidence either way.
    if (process.env.PI_TEST_ARM_ALWAYS_TRUE === "1") {
      const hits = relaxedHits;
      assert(
        hits >= 1,
        `canary: PI_TEST_ARM_ALWAYS_TRUE mutation actually executed (armRelaxed hit ${hits} time(s), expected at least one) — a mutation that never ran proves nothing either way`,
      );
    }
    // MUTATION-NEUTER-ARM: with one REFUSING arm of `anchorsShips` switched off, the
    // OTHER arm's canary must redden (its corrupted citation pairs under a predicate
    // that no longer checks the field it was meant to check). Proves the witness is a
    // real refusal, not a copy of `anchorsShips` wired to the same predicate.
    if (process.env.PI_TEST_NEUTER_ARM && process.env.PI_TEST_NEUTER_ARM !== arm) {
      assert(
        w.relaxed > 0,
        `canary: neutering the \`${process.env.PI_TEST_NEUTER_ARM}\` arm of anchorsShips reddens this one (relaxed=${w.relaxed}, expected >0) — a witness that stays green with a refusing arm switched off was never watching that arm`,
      );
    }
  }
  // The mask barrier, witnessed rather than assumed: `maskGroundingTable` blanks each
  // declaration with spaces of identical length so the detector cannot read the very
  // claims the table describes. Blanking to `-1` (no mask) and blanking with "x" were
  // both measured to leave the gate green — the barrier held only because the real
  // declarations happen to hold no in-window `1.x` literal.
  const maskBar = maskBarrierClaims(textByFile[gateRel] as string, "1.4.2", detect);
  assert(
    maskBar.masked === 0 && maskBar.unmasked === 1 && maskBar.filler === 0,
    `canary: the mask barrier is witnessed — the synthesised 1.4.2 claim that lives only in a declaration is invisible to the shipped mask (masked=${maskBar.masked}, expected 0) and VISIBLE when the mask does not blank (unmasked=${maskBar.unmasked}, expected 1); both 0 means the claim was never there to hide, masked=1 means the mask is not what hides it. filler=${maskBar.filler} is the non-whitespace fill and its 0 is the finding: blanking with "x" removes the marker text too, so it behaves like a space here — what that mutation really breaks is the identical-length contract, asserted as an invariant inside maskBarrierClaims`,
  );
}
