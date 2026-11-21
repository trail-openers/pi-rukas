#!/usr/bin/env bun
/**
 * #2439 AC1/AC2/AC4/R3/R4/R6/R7 — the roster at STEP level on the shapes the flat, refusal-prone
 * enumeration could not reach: a nested test tree, a base past 200 matching files, a multi-segment
 * `testDir`, and a head run with no failing test, which runs NO base suite at all.
 *
 * The base-leg skip is the cost half of the fix. The bench's suites are recursive over large repos
 * under a 70-minute lean deadline, and the roster paid for the whole suite twice, serially, each
 * under its own 30-minute bound. When head reports zero failing tests there is nothing for the base
 * run to compare against: `newlyFailing` is `head.failed ∩ base.passed` and `unexplained` is
 * `head.failed` minus what the base saw at all, so both are empty by construction and the second
 * run buys a verdict the record cannot contain. So it is skipped, and the roster says so
 * (`baseSkipped: true`) rather than pretending a base ran.
 *
 * Three rules the cases below pin, in R3's and R4's words:
 *
 *   - the skip fires ONLY on a head run the roster accepted as having run (`ran === true`) with an
 *     empty `failed` set — a head run that handed back still hands back;
 *   - a skipped-base roster can never be returned as `red`;
 *   - head-red cases still pay BOTH suite runs, head-green cases pay one, on counters that tell the
 *     two apart. One shared counter could not: a base-skip regression and a genuine two-run roster
 *     both read as one run.
 *
 * And the base versions of the run's EDITED test files still run when the base suite is skipped —
 * that run is the only observation of bench cell 2 and has nothing to do with the comparison.
 */
import { rmSync } from "node:fs";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC9-roster-nested-and-skip.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

{
  // AC1: a nested pre-existing test is a pre-existing test. `testDir/unit/test_a.py` sits below the
  // configured directory, so the flat listing dropped it, the enumeration came back empty and the
  // step handed back with "the base commit carries no test file matching …". The run's edit to that
  // same file then has to get its BASE version run against the head code, which is what the second
  // half of this case asserts: `editedFiles` is only written for a file whose base version ran and
  // passed, so its presence is the evidence the base bytes were executed.
  const NESTED = "tests/unit/test-a.sh";
  const NAME = "tests/unit/test-a.sh::nested_passes";
  const r = await runVerify({
    issue: 2480,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [NESTED], headPassed: [NAME], basePassed: [NAME] },
    editProjectTests: { [NESTED]: "#!/bin/sh\n# rewritten by the run\nexit 0\n" },
  });
  assert(
    r.outcome?.kind === "green",
    `(nested) a testDir/unit test yields a roster and a green, not a hand-back (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    JSON.stringify(roster?.files) === JSON.stringify([NESTED]),
    `(nested) the record names the nested file as pre-existing (${JSON.stringify(roster?.files)})`,
  );
  assert(
    JSON.stringify(roster?.editedFiles) === JSON.stringify([NESTED]),
    `(nested) the nested file's BASE version was run against the head code (${JSON.stringify(roster?.editedFiles)})`,
  );
}

{
  // AC4 / R3 / R4: the head run reported zero failures, so the base suite never ran.
  //
  // The counters are the evidence, not the record: a roster that claims a base it never ran is the
  // defect, and one shared counter cannot tell "the base was skipped" from "the base run was lost".
  // A green roster also cannot be `red`, and the record must SAY it skipped rather than leave a
  // `baseTotal` of a run nobody made.
  const FILES = ["tests/test-a.sh", "tests/test-b.sh"];
  const NAMES = ["tests/test-a.sh::first", "tests/test-b.sh::second"];
  const r = await runVerify({
    issue: 2481,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: FILES, headPassed: NAMES, basePassed: NAMES },
  });
  assert(
    r.outcome?.kind === "green",
    `(skip) a head run with no failures still lands (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    r.rosterHeadRuns === 1,
    `(skip) the head suite ran exactly once (${String(r.rosterHeadRuns)})`,
  );
  assert(
    r.rosterBaseRuns === 0,
    `(skip) and the BASE suite ran zero times (${String(r.rosterBaseRuns)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    roster?.baseSkipped === true,
    `(skip) the record marks the base leg skipped rather than inventing a base run (${JSON.stringify(roster?.baseSkipped)})`,
  );
  assert(
    roster?.baseTotal === 0 && JSON.stringify(roster?.baseFailed) === JSON.stringify([]),
    `(skip) a skipped base records a total of zero and no base failures (${String(roster?.baseTotal)}, ${JSON.stringify(roster?.baseFailed)})`,
  );
  assert(
    JSON.stringify(roster?.passed) === JSON.stringify(NAMES),
    `(skip) the head verdicts are still recorded in full (${JSON.stringify(roster?.passed)})`,
  );
  assert(
    roster?.total === NAMES.length,
    `(skip) and the head's true total survives the skip (${String(roster?.total)})`,
  );
  // A skipped-base roster is never a `red`: with `head.failed` empty, both red arms of the roster
  // (`newlyFailing`, `unexplained`) range over an empty set. Asserted against the outcome the step
  // returned rather than the reasoning above.
  assert(
    r.outcome?.kind !== "red" && r.threw === undefined,
    "(skip) a skipped-base roster is neither red nor a hand-back",
  );
}

{
  // The other side of R4: a head run that DID fail still pays both suite runs, because the base run
  // is the only thing that can tell "this run broke it" from "it was already broken". A regression
  // case is the one that reaches a base run, and it must show 1 head + 1 base.
  const FILE = "tests/test-a.sh";
  const GREEN_AT_BASE = "tests/test-a.sh::green_at_base";
  const r = await runVerify({
    issue: 2482,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      basePassed: [GREEN_AT_BASE],
      baseFailed: [],
      headPassed: [],
      headFailed: [GREEN_AT_BASE],
    },
  });
  assert(
    r.outcome?.kind === "red",
    `(head red) a base-pass then head-fail is still red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    r.rosterHeadRuns === 1 && r.rosterBaseRuns === 1,
    `(head red) and both suite runs happened: ${String(r.rosterHeadRuns)} head, ${String(r.rosterBaseRuns)} base`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(GREEN_AT_BASE),
    `(head red) the reason still names the test the builder must fix (${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
}

{
  // R3's guard rail: the skip is conditioned on a head run the roster ACCEPTED. A head run that
  // produced no report is not "zero failures" — it is an unobserved run, and the step hands back
  // exactly as it did before the skip existed. Short-circuiting here would grade a green on a suite
  // nobody watched.
  const r = await runVerify({
    issue: 2483,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: ["tests/test-a.sh"], headPassed: ["__NO_REPORT__"] },
  });
  assert(
    r.threw !== undefined && /roster/i.test(r.threw.message),
    `(unobserved head) a head run that wrote no report still hands back (${r.outcome?.kind ?? `threw: ${r.threw?.message.slice(0, 90)}`})`,
  );
  assert(
    r.rosterHeadRuns === 1 && (r.rosterBaseRuns ?? 0) === 0,
    `(unobserved head) the head ran and was refused before any base run (${String(r.rosterHeadRuns)}, ${String(r.rosterBaseRuns)})`,
  );
}

{
  // AC2 / R6: 205 matching files at the base. The record lists at most 200 and carries the true
  // count; and the file that sorts PAST entry 200 is still detected as edited and still has its base
  // version run, because edited-file detection consumes the full enumeration, not the truncated one.
  const many = Array.from({ length: 205 }, (_, i) => `tests/test-${String(i).padStart(3, "0")}.sh`);
  const LAST = many[204];
  const NAMES = many.map((f) => `${f}::passes`);
  const r = await runVerify({
    issue: 2484,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: many, headPassed: NAMES },
    editProjectTests: { [LAST]: "#!/bin/sh\n# the run edited the 205th file\nexit 0\n" },
  });
  assert(
    r.outcome?.kind === "green",
    `(past cap) 205 test files enumerate, roster and land (got ${r.outcome?.kind ?? `threw: ${r.threw?.message?.slice(0, 160)}`})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    (roster?.files.length ?? 0) === 200,
    `(past cap) the record lists exactly 200 files (${String(roster?.files.length)})`,
  );
  assert(
    roster?.fileCount === 205,
    `(past cap) and carries the true count beside them (${String(roster?.fileCount)})`,
  );
  assert(
    !(roster?.files ?? []).includes(LAST) &&
      JSON.stringify(roster?.editedFiles) === JSON.stringify([LAST]),
    `(past cap) the file past entry 200 is not in the record's list yet its BASE version was still run (${JSON.stringify(roster?.editedFiles)})`,
  );
}

{
  // R7: `testDir` itself is multi-segment — the bench's package-internal test dirs — with a matching
  // file two levels below it. Matching stays prefix-based on the normalised `testDir`.
  const r = await runVerify({
    issue: 2485,
    implement: true,
    config: { fast: PASS_TIER },
    testDir: "test/units",
    testGlob: "test-*.sh",
    roster: {
      // Nothing under `test/units` matches the default name, so the fixture's own default file is not
      // committed here — which is exactly the point of the case: the enumeration reaches the deep
      // path on its own, with no flat sibling to carry it.
      files: ["test/units/nested/deep/test-a.sh"],
      headPassed: ["test/units/nested/deep/test-a.sh::deep"],
      basePassed: ["test/units/nested/deep/test-a.sh::deep"],
    },
  });
  assert(
    r.outcome?.kind === "green",
    `(multi-segment) test/units with a file two levels below it yields a roster (got ${r.outcome?.kind ?? `threw: ${r.threw?.message?.slice(0, 160)}`})`,
  );
  assert(
    JSON.stringify(r.outcome?.projectRoster?.files) ===
      JSON.stringify(["test/units/nested/deep/test-a.sh"]),
    `(multi-segment) the deep path is recorded repo-relative (${JSON.stringify(r.outcome?.projectRoster?.files)})`,
  );
}

{
  // R3's last clause, at the step: the base suite is skipped, and the run still EDITED a pre-existing
  // file — so the base version still runs. Nothing about the skip touches that run: it is the only
  // observation of bench cell 2, and it reads the base BYTES from the object store rather than
  // running the base's suite.
  const FILE = "tests/test-a.sh";
  const NAME = "tests/test-a.sh::one";
  const r = await runVerify({
    issue: 2486,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], headPassed: [NAME], basePassed: [NAME] },
    editProjectTests: { [FILE]: "#!/bin/sh\nexit 0\n" },
  });
  assert(
    r.outcome?.kind === "green",
    `(skip + edit) an edited pre-existing test still lands on a skipped base (got ${r.outcome?.kind ?? `threw: ${r.threw?.message?.slice(0, 140)}`})`,
  );
  assert(
    r.rosterBaseRuns === 0,
    `(skip + edit) the base SUITE ran zero times (${String(r.rosterBaseRuns)})`,
  );
  assert(
    JSON.stringify(r.outcome?.projectRoster?.editedFiles) === JSON.stringify([FILE]),
    `(skip + edit) while the file's base version was run against the head code (${JSON.stringify(r.outcome?.projectRoster?.editedFiles)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
