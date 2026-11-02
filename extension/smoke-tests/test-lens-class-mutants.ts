#!/usr/bin/env bun
/**
 * The generator's witnesses. `lens-class-mutants.ts` is what the per-member
 * tables in `lens-flank-escape-probe.ts` are built from, so a generator that
 * silently produced the WRONG set would make every number in that table a
 * fabrication wearing a hash. This file is the half of that claim the shipped
 * classes can falsify: they are asserted to be ACCEPTED, to generate exactly the
 * members the tables print, and to keep every table figure a RUN rather than a
 * transcription.
 *
 * THE SPLIT, and what it is not. The refusals — the shapes that must never
 * become a row, and where a new blind spot gets recorded — are in
 * `test-lens-class-refusals.ts`. They were separated when this file reached the
 * 500-line cap (§12): nothing was trimmed to fit, and the refusal helper both
 * halves assert through is `lib/lens-class-mutants-arms.ts`, so "refused for the
 * right reason" cannot drift between them.
 */

import { mutantTable } from "./lib/lens-class-mutants.ts";
import { assert, state } from "./lib/lens-class-mutants-arms.ts";


// ───────────────────────── the harness that feeds the tables

import { assertBaselineLoopWitnessed } from "./lib/lens-baseline-witness.ts";
import { CORPUS, measuredTable, runMutant, runShipped, SHIPPED, wholeClassRemoval } from "./lib/lens-mutant-harness.ts";

{
  const baseline = await runShipped();
  assert(
    baseline.length === 0,
    `the shipped matcher satisfies every harness fixture — a corpus that fails here would make every "0 reds" in the table meaningless (failing: ${JSON.stringify(baseline)})`,
  );
  // THE BASELINE LOOP'S OWN WITNESS. `baseline.length === 0` above is satisfied
  // by an empty array of ANY provenance, so it cannot tell a loop that measured
  // every fixture from one hollowed out to `void accounted; void corpus;` — a
  // mutation a reviewer measured as `exit=0` on all three lens suites, with every
  // `0` on the table surviving and `refusing to measure ${flank}` unreachable.
  // The four `check`s the helper below fires are the arms that read the loop's
  // OUTPUT rather than its length: two independent of the loop (so a loop that
  // runs and computes nothing reddens) and one propagating a manufactured red (so
  // a loop that keeps its shape but returns a constant reddens).
  await assertBaselineLoopWitnessed(assert);
  assert(CORPUS.length > 40, `the corpus is broad enough to name a flank: ${CORPUS.length} fixtures`);
  for (const flank of ["PATH_CHAR", "NOT_PATH", "TERMINATOR"] as const) {
    const rows = await measuredTable(flank);
    assert(
      rows.every((r) => r.mutant.shipped === SHIPPED[flank]),
      `${flank}: every measured row declares the shipped class it was generated from`,
    );
    // The two mirror constants must BOTH produce rows: a harness that silently
    // measured one side is the defect this branch closes.
    assert(rows.length >= 5, `${flank}: ${rows.length} measured rows generated`);
    // THE ROWS ARE THE GENERATOR'S, NOT THE HARNESS'S. `rows.every(r =>
    // r.mutant.shipped === SHIPPED[flank])` and the count above are both satisfied by
    // hand-typed rows, and replacing the harness's `mutantsFor` call with a
    // hand-typed table left the suite green (measured: 0 reds across the class-mutants,
    // refusals and denominator suites). So the harness now reports a refusal whenever
    // the generator produced nothing, and printing a table whose rows no generator
    // made is the fabrication this whole branch was opened for.
    // A TABLE IS NOT THE GENERATOR UNLESS THE GENERATOR SAYS SO. The count and the
    // `mutant.shipped === SHIPPED[flank]` checks around this one are all satisfied by
    // hand-typed rows, and replacing the harness's `mutantsFor` call with a fabricated
    // table left the suite green (measured: 0 reds across the class-mutants, refusals
    // and denominator suites). The harness now carries the generator's own report on
    // every row and it is compared against the printed table: a fabricated table
    // cannot forge the count, and neither can an empty one — `rows.every(…)` over zero
    // rows is vacuously true, the trap `test-lens-vacuous-every.ts` exists for, so the
    // printed count and the reported count must BOTH be non-zero and equal.
    assert(
      rows.length > 0 &&
        rows.every(
          (r) => r.generatorReport.produced === rows.length && r.generatorReport.refusal === null,
        ),
      `${flank}: the printed table is the generator's — ${rows.length} row(s) printed and mutantsFor reported producing ${rows[0]?.generatorReport.produced ?? "no report"} with no refusal (${JSON.stringify(rows.map((r) => r.generatorReport.refusal).filter(Boolean))})`,
    );
  }
  const pathChar = await measuredTable("PATH_CHAR");
  const notPath = await measuredTable("NOT_PATH");
  const anyPathCharRed = pathChar.some((r) => r.reds.length > 0);
  const anyNotPathRed = notPath.some((r) => r.reds.length > 0);
  assert(
    anyPathCharRed && anyNotPathRed,
    `BOTH flanks redden under some member deletion (PATH_CHAR ${JSON.stringify(pathChar.map((r) => r.reds.length))}, NOT_PATH ${JSON.stringify(notPath.map((r) => r.reds.length))}) — a table that measured only one side could not print this`,
  );

  // THE CONTROL PAIR, as an assertion and not a header sentence. Two halves:
  // (1) the shipped class substituted for itself reddens ONLY the fixtures whose
  // right flank is decided by the class the harness does not substitute — the
  // two lone-CR fixtures, because `mentionsPathWith` takes NOT_LINE_BREAK as an
  // argument and a member-only mutant leaves that argument the shipped value
  // while the CR pair is decided by it. A no-op substitution that reddened a
  // PATH_CHAR or NOT_PATH fixture would mean the corpus and the shipped matcher
  // disagree, and every `0` on the table would then be meaningless; the CR pair is
  // the documented, non-PATH_CHAR exception, asserted rather than swept under.
  // (2) a real member deletion reddens the fixture that member exists to catch,
  // `PATH_CHAR_PLUS` first, among the CR siblings. Both halves together prove the
  // harness can both stay green (for the flank it is substituting) and redden.
  const noop = runMutant("PATH_CHAR", SHIPPED.PATH_CHAR);
  const noopNonCr = noop.filter((n) => !/lone CR/.test(n));
  assert(
    noopNonCr.length === 0,
    `control half 1: substituting the shipped class bytes for themselves reddens no PATH_CHAR/NOT_PATH fixture (${JSON.stringify(noopNonCr)}) — the only reds are the lone-CR pair, whose right flank is NOT_LINE_BREAK (not substituted by a member mutant); any OTHER red here means the corpus and the shipped matcher disagree and every table 0 is then meaningless`,
  );
  const oneDeletion = (await measuredTable("PATH_CHAR")).find((r) => r.mutant.member === "+");
  assert(
    oneDeletion !== undefined &&
      oneDeletion.reds.includes("canary: a path followed by a terminal `+` is not a citation (PATH_CHAR_PLUS)"),
    `control half 2: \`PATH_CHAR\` minus \`+\` reddens the fixture the \`+\` member exists to catch, PATH_CHAR_PLUS (got ${oneDeletion ? JSON.stringify(oneDeletion.reds) : "no such row"}) — with half 1 this is the pair proving the harness can both stay green and redden`,
  );

  // THE WHOLE-CLASS CONTROL: asserted where it exists, asserted ABSENT where it
  // does not. `wholeClassRemoval` used to hand back a red count for all three
  // flanks, produced by interpolating `""` into the class position — `(?!|…)` and
  // `(?:^|)`, which redden 17 fixtures each for a reason unrelated to membership.
  // That is a whole-class figure wearing a label it did not earn, so those two
  // flanks now return null and an assertion holds them there.
  const termWhole = wholeClassRemoval("TERMINATOR");
  assert(
    termWhole !== null && termWhole.length > 0,
    `whole-class control: deleting the anchored TERMINATOR arm reddens ${termWhole?.length ?? "null"} fixture(s) — the figure the table's TERMINATOR rows are read against (${JSON.stringify(termWhole)})`,
  );
  for (const flank of ["PATH_CHAR", "NOT_PATH"] as const) {
    assert(
      wholeClassRemoval(flank) === null,
      `${flank}: NO whole-class control is offered — an empty class in that position changes the ARM rather than the membership, so any figure printed for it would be red for the wrong reason (got ${JSON.stringify(wholeClassRemoval(flank))})`,
    );
  }

  // The formatter the header's table rows are built from. Called here so a change
  // that makes it throw, or drops the representative/survivors a row is audited
  // by, is a red rather than a header describing a function nobody ran.
  const printed = mutantTable(SHIPPED.PATH_CHAR);
  assert(
    printed.length === 5 &&
      printed.every((l) => l.includes("representative") && l.includes("survivors")),
    `mutantTable renders one line per member carrying its representative and survivors (${printed.length} lines)`,
  );
}

// ───────────────────────── the table's numbers are a RUN, not a transcription

{
  // THE RECONCILIATION. The per-member table in `lens-flank-escape-probe.ts`
  // publishes a red count per member; a table transcribed into a header is a
  // second source of truth that silently rots the moment a fixture is added.
  // The block below re-measures every member and asserts the header states
  // EXACTLY these counts — so a future fixture that shifts a number reddens
  // this run instead of leaving the header describing a table nobody printed.
  // This is the executable answer to the reviewer's "the prose table is not
  // regenerated at runtime" finding.
  const EXPECTED: Record<string, Record<string, number | undefined>> = {
    PATH_CHAR: { _: 3, ".": 3, "/": 3, "+": 3, "-": 2 },
    NOT_PATH: { _: 3, ".": 3, "/": 9, "+": 8, "-": 3 },
    TERMINATOR: { "!": 2, "?": 2, ",": 2, ".": 4, ";": 2, ":": 2, "-": 3 },
  };
  for (const flank of ["PATH_CHAR", "NOT_PATH", "TERMINATOR"] as const) {
    const rows = await measuredTable(flank);
    for (const r of rows) {
      const want = EXPECTED[flank]?.[r.mutant.member];
      assert(
        want === r.reds.length,
        `table reconciliation: ${flank} minus ${JSON.stringify(r.mutant.member)} measures ${r.reds.length} reds and the header must state that (${want === undefined ? "member absent from EXPECTED" : "header says " + want}) — if this reddens, a fixture moved the count and the table in lens-flank-escape-probe.ts needs the new figure, not a change here`,
      );
    }
  }
}

console.log(state.exit === 0 ? "\nAll generator-witness checks passed." : "\nFAILED");
process.exit(state.exit);
