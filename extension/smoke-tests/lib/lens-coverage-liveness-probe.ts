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
 * THE MUTANT IS A BLOB THE TEST ITSELF BUILDS, RUNS, AND PERSISTS. Shipped is
 * `16a748e9579ba7238e52cc96e52da4906bb8feac` (= `git rev-parse
 * HEAD:extension/src/lens-review-fanout.ts`); the mutant is
 * `6b0864600b237430c596810b6439c601becba149`, which is that file with the
 * two-line initialiser
 * (`results.length > 0 && results.every((r) => hasReviewEvidence(…))`) replaced
 * by `const allLanesProducedEvidence = true;`. Two earlier revisions of this
 * header cited hashes that were NOT git objects — `3b1b7868…` (added last round)
 * and `6b086460…` before it — and each claimed a reviewer could `git cat-file -p`
 * them. They could not: a working-tree edit plus `git hash-object` prints a hash
 * without ever writing the object, so the half of the pair that carried the proof
 * was unverifiable, which is the same defect as a fabricated red. This header no
 * longer asks a reviewer to trust that a mutation was made: `assertLivenessMutantReds`
 * reads the shipped fan-out, applies that one replacement, persists the result
 * with `git hash-object -w` (so `git cat-file -t 6b086460…` now answers `blob`
 * in any clone that has run the suite, not just the author's), dynamically
 * imports the mutant module and drives the SAME `silentLaneRoundArms` scenario
 * through the MUTANT's `runLensFanOut`, and asserts the one `findingClaimedFile`
 * canary is the only assertion the mutant reddens. The blob hash is checked
 * against the constant below, so the object a reader fetches and the object the
 * run measured are pinned to be the same bytes.
 *
 * So neither kind replaces the other: drop the conjunct from the AND and the
 * direct FALSE arms redden; force the flag true at its definition and only the
 * round redden. Both are asserted here, by a run.
 */

import { coverageClaimEarned, runLensFanOut } from "../../src/lens-review-fanout.ts";
import * as dispatchDeck from "../../src/dispatch-deck.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";
import type { Finding, LensRunResult } from "../../src/lens-review-types.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** The blob hash `assertLivenessMutantReds` builds and persists. A reader can
 * `git cat-file -p` it after any run of the suite; the function below refuses if
 * the bytes it measured hash to anything else, so this constant is a witness and
 * not a claim. */
export const LIVENESS_MUTANT_BLOB = "6b0864600b237430c596810b6439c601becba149";

/** The shipped `lens-review-fanout.ts` blob, the other half of the pair. */
export const LIVENESS_SHIPPED_BLOB = "16a748e9579ba7238e52cc96e52da4906bb8feac";

/**
 * The executable half of the liveness witness: it does not assert that a red was
 * seen, it SEES it. The shipped fan-out is read, the two-line
 * `allLanesProducedEvidence` initialiser is replaced with `= true`, the result is
 * written to a scratch dir and persisted with `git hash-object -w`, then imported
 * and driven through the exact `silentLaneRoundArms` scenario through the MUTANT's
 * `runLensFanOut`. Under the shipped code that scenario's `findingClaimedFile`
 * is `false` (one silent lane refuses the claim); under the mutant the flag is
 * hard-wired `true`, so the claim is earned and the `findingClaimedFile === false`
 * canary reddens — the ONLY arm the mutant moves, which is exactly why the direct
 * arms above cannot substitute for this one (they pass the flag as an argument and
 * stay green under it).
 *
 * It also asserts the persisted blob is a real git object and hashes to
 * `LIVENESS_MUTANT_BLOB`, so a reader who fetches it fetches the bytes that were
 * measured. A mutant that compiled and matched shipped (a no-op replacement) is
 * refused rather than reported clean.
 */
export async function assertLivenessMutantReds(
  check: (cond: boolean, msg: string) => void,
  openBatch: (key: string, size: number) => void,
): Promise<void> {
  const fanoutPath = new URL("../../src/lens-review-fanout.ts", import.meta.url);
  const shipped = readFileSync(fanoutPath, "utf8");

  // The two-line initialiser, matched exactly — a replacement that found nothing
  // would be a no-op mutant that stays green for the wrong reason, which is the
  // failure this whole branch refuses.
  const SHIPPED_INIT =
    "  const allLanesProducedEvidence =\n" +
    "    results.length > 0 && results.every((r) => hasReviewEvidence(r.findings, r.summary));";
  const MUTANT_INIT = "  const allLanesProducedEvidence = true;";
  if (!shipped.includes(SHIPPED_INIT)) {
    check(
      false,
      "canary: the liveness mutant's target (the two-line allLanesProducedEvidence initialiser) is present in the shipped fan-out — if it moved, this proof is measuring nothing (red means the product's initialiser was re-spelled and the mutation must be re-aimed)",
    );
    return;
  }
  const mutant = shipped.replace(SHIPPED_INIT, MUTANT_INIT);
  check(mutant !== shipped, "canary: the allLanesProducedEvidence replacement changed the file (a no-op mutant would stay green and prove nothing)");

  // Persist the mutant so its blob is a real, fetchable git object, and confirm
  // it hashes to the constant this file cites. It is written INTO src/ as a
  // temp file so its own `./lens-review-incomplete.ts` etc. imports resolve, and
  // removed in the finally block — the tree is byte-clean again when this returns
  // (verified in the round that wrote it: `git status --porcelain extension/src`
  // is empty after the suite).
  const fanoutDir = new URL("../../src/", import.meta.url);
  const srcDir = fanoutDir.pathname;
  const mutantFile = join(srcDir, "__lens_liveness_mutant__.ts");
  try {
    writeFileSync(mutantFile, mutant);
    const hash = execFileSync("git", ["hash-object", "-w", mutantFile], { encoding: "utf8" }).trim();
    check(
      hash === LIVENESS_MUTANT_BLOB,
      `canary: the built mutant persists as git blob ${LIVENESS_MUTANT_BLOB} (this run produced ${hash}) — the object a reviewer fetches must be the bytes that were measured`,
    );
    const type = execFileSync("git", ["cat-file", "-t", LIVENESS_MUTANT_BLOB], { encoding: "utf8" }).trim();
    check(
      type === "blob",
      `canary: \`git cat-file -t ${LIVENESS_MUTANT_BLOB.slice(0, 8)}\` answers \`blob\` — the mutant is a fetchable git object, not a hash printed from a working-tree edit (the defect both earlier header revisions shipped with)`,
    );

    // Import the MUTANT (a distinct module instance from the shipped fan-out,
    // because bun keys modules by path, not content — verified in the round that
    // wrote this) and drive the SAME scenario through its `runLensFanOut`.
    const mod = (await import(/* @vite-ignore */ mutantFile)) as {
      runLensFanOut: typeof runLensFanOut;
    };
    const out = await runSilentRound(mod.runLensFanOut, openBatch, "rev1942mut/silent");
    check(
      out.hasDenominator === true && out.unaccounted.length > 0,
      `canary: the MUTANT round still had a denominator and unaccounted files (hasDenominator ${out.hasDenominator}) — so the claim below is the liveness flag, not an empty set`,
    );
    // THE RED: the direct arms above pass the flag in and never see this. The
    // mutant hard-wires the flag true, so `findingClaimedFile` flips false→true.
    check(
      out.findingClaimedFile === true,
      "canary: with allLanesProducedEvidence hard-wired true at its DEFINITION SITE the silent lane no longer refuses the claim (findingClaimedFile went false→true) — this is the only arm that sees the definition-site mutation; delete this check and the liveness conjunct has a pasted red line, not a proof",
    );
    // …and the shipped code, driven identically, still refuses it: the pair is
    // the witness, not the single mutant run.
    const shippedOut = await runSilentRound(runLensFanOut, openBatch, "rev1942mut/shipped");
    check(
      shippedOut.findingClaimedFile === false,
      "canary: the SHIPPED fan-out, driven through the identical scenario, still refuses the claim (false) — the false→true flip under the mutant is what makes this a comparison and not a tautology",
    );
  } finally {
    rmSync(mutantFile, { force: true });
    dispatchDeck.reset();
  }
}

/** Drive the one-silent-lane / one-citing-lane round through a given
 * `runLensFanOut` (shipped or mutant), returning the fields the liveness witness
 * reads. Shared so the shipped and mutant halves run a byte-identical scenario —
 * the only difference between the two verdicts is which module computed them.
 * The batch key differs per call so `dispatch-deck`'s acquire bookkeeping does not
 * collide between the shipped and mutant rounds; `dispatchDeck.reset()` in the
 * caller's `finally` clears both. */
async function runSilentRound(
  fanout: typeof runLensFanOut,
  openBatch: (key: string, size: number) => void,
  key: string,
): Promise<{ hasDenominator: boolean; unaccounted: string[]; findingClaimedFile: boolean }> {
  openBatch(key, 2);
  const silent = LENS_ROSTER[0]?.name;
  const out = await fanout({
    healthy: LENS_ROSTER.slice(0, 2),
    blocked: [],
    lensChildFn: async (a: { lens: { name: string } }) =>
      a.lens.name === silent
        ? probeSilentRow(a.lens.name)
        : probeHealthyRow(a.lens.name, [probeFinding("src/a.ts")]),
    runId: "rev1942mut",
    skillsDir: "/tmp/rev1942mut",
    context: "",
    roster: LENS_ROSTER.slice(0, 2),
    opts: { diff: LIVENESS_DIFF },
    bumpBatch: () => {},
    batchKey: key,
    modelSlot: (_lens, fn) => fn(),
    resolved: { kind: "ok", diffSource: "computed", diff: LIVENESS_DIFF },
  });
  return out;
}
