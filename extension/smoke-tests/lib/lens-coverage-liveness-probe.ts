/**
 * The witnesses for the fan-out's LIVENESS conjunct — the flag that, per
 * `lens-review-fanout.ts`'s own comment, is "the fan-out's only witness that a
 * lane ran at all", and which `coverageClaimEarned` ANDs.
 *
 * The witnesses live in `lib/` rather than inline in
 * `test-lens-fanout-batch-release.ts` for one reason: that file pins the deck
 * batch's RELEASE (which rows and which ticker handle a round leaves behind),
 * while these pin the coverage CLAIM a round earns. Different question, and the
 * claim-side file was already the larger of the two. Splitting along that seam
 * keeps each file about one thing — and never by shrinking a witness: every
 * assertion here was written whole, and the ticker arms that a reviewer called
 * "byte-duplicates" were measured to be live witnesses (see below).
 *
 * WHY A DIRECT CALL AND AN END-TO-END ROUND ARE BOTH HERE
 *
 * `coverageClaimEarned(expectedFiles, claimedEvidence, allLanesProducedEvidence)`
 * is a three-way conjunction, and the two arms below judge different things:
 *
 *   - the DIRECT arms pass the flag in as an argument, so they pin the
 *     conjunction's SHAPE: hold the denominator and the citation constant and
 *     move only the flag, and the claim must move with it.
 *   - the END-TO-END case computes the flag from the children, which is the only
 *     way to see the mutation that matters. Hard-wiring
 *     `allLanesProducedEvidence = true` at its definition site reddens NOTHING
 *     among the direct arms — they judge the argument, not the expression. The
 *     end-to-end case reddens on it, and the shipped/mutant pair is `false → true`
 *     on `findingClaimedFile`.
 *
 * THE MUTANT IS A BLOB A REVIEWER CAN FETCH. Shipped is
 * `16a748e9579ba7238e52cc96e52da4906bb8feac` (= `git rev-parse
 * HEAD:extension/src/lens-review-fanout.ts`); the mutant is
 * `3b1b78683c9e6e1993316a68fc57f60d591f30c5`, which is that file with the
 * two-line initialiser replaced by `const allLanesProducedEvidence = true;`.
 * An earlier revision of this header cited `6b086460…`, and that object does
 * not exist in the repository — `git cat-file -t 6b086460` is a fatal — so the
 * half of the pair that carried the proof was unverifiable, which is the same
 * defect as a fabricated red. Both blobs above were produced and re-measured in
 * the round that wrote this: patching the working file to the mutant blob, run
 * `test-lens-fanout-batch-release` (1 red, the `findingClaimedFile` canary, and
 * nothing else), then `test-lens-vacuous-every`, `test-lens-coverage-denominator`
 * and `test-lens-coverage-routing` (0 reds each), then restore; `git hash-object`
 * matched `16a748e9…` after the restore.
 *
 * So neither kind replaces the other: drop the conjunct from the AND and the
 * direct FALSE arms redden; force the flag true at its definition and only the
 * round redden. Both were observed, and both are asserted here.
 */

import { coverageClaimEarned, runLensFanOut } from "../../src/lens-review-fanout.ts";
import * as dispatchDeck from "../../src/dispatch-deck.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";
import type { Finding, LensRunResult } from "../../src/lens-review-types.ts";

/** A two-file diff, so one lane citing `src/a.ts` leaves `src/b.ts` unaccounted
 * and the denominator cannot be empty by accident. */
const LIVENESS_DIFF = ["src/a.ts", "src/b.ts"]
  .flatMap((f) => [`diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, "@@ -1 +1 @@", "-x", "+y"])
  .join("\n");

/** A finding on `path`, shaped like the fan-out's own structured evidence. */
export function probeFinding(path: string): Finding {
  return { lens: "SECURITY", severity: "LOW", path, line: 1, title: "x" } as unknown as Finding;
}

/** A healthy lane row that produced evidence. */
export function probeHealthyRow(lens: string, findings: Finding[] = []): LensRunResult {
  return {
    lens,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    findings,
    summary: "Reviewed the change, no issues.",
  } as unknown as LensRunResult;
}

/** A healthy lane row that produced NOTHING — no finding, no summary. This is
 * the shape `hasReviewEvidence` refuses, and therefore the shape that makes
 * `allLanesProducedEvidence` false while the lane itself stayed healthy. */
export function probeSilentRow(lens: string): LensRunResult {
  return { ...probeHealthyRow(lens), findings: [], summary: "" } as unknown as LensRunResult;
}

/** The ticker arms belonging beside a batch acquire, so the acquire's row arm
 * and its timer arm are asserted together wherever a round is set up. They are
 * NOT a duplicate of the row arm: the row lives in `batches`, the ticker in a
 * module-level handle, and `clearBatchEntry` early-returns on a missing row
 * before it reaches the ticker stop — so the two can disagree, and only the
 * ticker arm sees a timer that never started or never stopped.
 *
 * Measured 2026-11-04 in a scratch copy: replacing the `tickHandle !== undefined`
 * read in `dispatch-deck.ts`'s `isTicking()` with `return false` reddens these
 * arms while leaving every row assertion green. That is the observation that
 * makes them a witness rather than decoration — and the reason a reviewer's
 * "byte-duplicate, collapse it" was wrong and the pair was kept. */
export function acquireTickerArms(
  check: (cond: boolean, msg: string) => void,
  isTicking: () => boolean,
  label: string,
): void {
  check(
    isTicking(),
    `canary: the ${label} acquire started the deck TICKER — a separate resource from the batch row (red when the acquire is suppressed, the ticker never starts, or the tickHandle read is blinded)`,
  );
}

/** The end-to-end round behind the liveness flag: one SILENT healthy lane and
 * one citing lane driven through `runLensFanOut`, so the flag is COMPUTED from
 * the children rather than passed in. This is the only arm that can see
 * `allLanesProducedEvidence` hard-wired to `true` at its definition site — the
 * direct arms above pass the flag as an argument and measure 0 reds under that
 * mutant (shipped `16a748e9…` vs mutant `3b1b7868…`, both fetchable with
 * `git cat-file -p`; `findingClaimedFile` `false → true`, and the three sibling
 * coverage suites stay green — see this file's header for the run).
 *
 * `openBatch` is injected by the caller so the deck's acquire/release bookkeeping
 * stays with the file that owns the deck; `check` likewise stays with the
 * caller's pass/fail counter. */
export async function silentLaneRoundArms(
  check: (cond: boolean, msg: string) => void,
  openBatch: (key: string, size: number) => void,
): Promise<void> {
  const key = "rev1942g/silent-lane";
  openBatch(key, 2);
  const silent = LENS_ROSTER[0]?.name;
  const citing = LENS_ROSTER[1]?.name;
  check(
    Boolean(silent) && Boolean(citing),
    "canary: the roster has two lanes to drive (red if the roster shrank below two — the silent/citing split would be unmeasurable)",
  );
  const out = await runLensFanOut({
    healthy: LENS_ROSTER.slice(0, 2),
    blocked: [],
    lensChildFn: async (a: { lens: { name: string } }) =>
      a.lens.name === silent
        ? probeSilentRow(a.lens.name)
        : probeHealthyRow(a.lens.name, [probeFinding("src/a.ts")]),
    runId: "rev1942g",
    skillsDir: "/tmp/rev1942g",
    context: "",
    roster: LENS_ROSTER.slice(0, 2),
    opts: { diff: LIVENESS_DIFF },
    bumpBatch: () => {},
    batchKey: key,
    modelSlot: (_lens, fn) => fn(),
    resolved: { kind: "ok", diffSource: "computed", diff: LIVENESS_DIFF },
  });
  check(
    out.hasDenominator === true && out.unaccounted.length > 0,
    `canary: the silent round really had a denominator and left files unaccounted (hasDenominator ${out.hasDenominator}, unaccounted ${JSON.stringify(out.unaccounted)}) — so the refusal below is liveness, not an empty set`,
  );
  check(
    out.findingClaimedFile === false,
    "canary: one SILENT healthy lane refuses the positive coverage claim end-to-end (red when `allLanesProducedEvidence` is hard-wired true at its definition site — the direct arms cannot see that mutation)",
  );
  dispatchDeck.reset();
}

/** The direct unit arms on the predicate. `check` is injected so the caller's
 * pass/fail counter and message format stay in the test file. */
export function coverageClaimUnitArms(
  check: (cond: boolean, msg: string) => void,
): void {
  const expected = new Set(["src/a.ts", "src/b.ts"]);
  // A HEALTHY roster: a real structured citation inside the denominator, so
  // `hasFindingClaimedFile` is satisfied and the only thing left to decide the
  // claim is the liveness flag.
  const evidence = [{ findings: [probeFinding("src/a.ts")], summary: "Reviewed src/a.ts." }];
  const withLiveness = coverageClaimEarned(expected, evidence, true);
  const withoutLiveness = coverageClaimEarned(expected, evidence, false);
  check(
    withLiveness === true,
    "canary: the same roster DOES earn the claim when every healthy lane produced evidence (the TRUE arm — red if the conjunct is inverted or the citation arm is broken)",
  );
  check(
    withoutLiveness === false,
    "canary: a silent healthy lane alone refuses the claim, with the citation and denominator unchanged (the FALSE arm — red if `allLanesProducedEvidence` is dropped from the conjunction or hard-wired true)",
  );
  check(
    withLiveness !== withoutLiveness,
    `canary: the liveness flag is what separates the two arms (true→${withLiveness}, false→${withoutLiveness}; equal means the conjunct decides nothing)`,
  );
}
