#!/usr/bin/env bun
/**
 * #2428 AC1 — `verify` runs the project's own pre-existing tests at head and at the base commit and
 * records a per-test roster, and a run whose roster cannot be built HANDS BACK rather than going
 * green.
 *
 * Before this, the step's only evidence that the project's tests ran was the configured tier's exit
 * code, and a project whose tiers never touched its real suite could certify a green having run none
 * of it. Three shapes have to be distinguishable, and today they are not:
 *
 *  - the roster built, with per-test names from the runner's report on BOTH sides
 *  - no roster because the project never said where its tests live (`testDir`+`testGlob` absent)
 *  - no roster because the runner produced no readable report (a suite that collected nothing)
 *
 * The last two are the same answer the step owes either way: a hand-back that names the roster, and
 * never a green. The record is asserted rather than the reason string alone, because a roster the
 * harness invented would print as nicely as one the gate read.
 */
import { rmSync } from "node:fs";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { NO_REPORT_SENTINEL } from "./lib/lean-verify-roster.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC1-project-roster-handback.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const PRE_EXISTING = ["tests/test-a.sh", "tests/test-b.sh"];
const NAMES = ["tests/test-a.sh::first", "tests/test-a.sh::second", "tests/test-b.sh::only"];

{
  // The roster's on arm: the project's tests really ran, in both trees, and what they produced is
  // in the record. `rosterRuns` is the count of the step's OWN suite invocations, so a record that
  // appeared without two runs behind it is the defect, not a passing case.
  const r = await runVerify({
    issue: 2428,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: PRE_EXISTING, headPassed: NAMES, basePassed: NAMES },
  });
  assert(
    r.outcome?.kind === "green",
    `(built) a roster both runs agree on is green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 120)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(roster !== undefined, "(built) the green carries a projectRoster");
  assert(
    r.rosterRuns === 2,
    `(built) the project's suite ran at head AND at the base (runs: ${String(r.rosterRuns)})`,
  );
  assert(
    JSON.stringify(roster?.passed) === JSON.stringify(NAMES),
    `(built) the record holds the head run's per-test names verbatim (${JSON.stringify(roster?.passed)})`,
  );
  assert(
    JSON.stringify(roster?.files) === JSON.stringify(PRE_EXISTING),
    `(built) the record names the pre-existing files it covers (${JSON.stringify(roster?.files)})`,
  );
  assert(
    roster?.baseSha === r.baseSha,
    `(built) the record says which commit the base run ran at (${String(roster?.baseSha)} vs ${String(r.baseSha)})`,
  );
  assert(
    roster?.total === NAMES.length && roster?.baseTotal === NAMES.length,
    `(built) the totals are the runs' own counts (head ${String(roster?.total)}, base ${String(roster?.baseTotal)})`,
  );
}

{
  // No roster because the project never said where its tests live. The step must hand back naming
  // the roster; a green here is a merge on tests nobody ran.
  const r = await runVerify({
    issue: 2429,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: PRE_EXISTING, headPassed: NAMES, basePassed: NAMES },
    noTestLocation: true,
  });
  assert(
    r.threw !== undefined && /roster/i.test(r.threw.message),
    `(no location) the run hands back rather than grading green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(r.outcome === undefined, "(no location) no outcome is recorded — the run decided nothing");
  assert(
    /testDir/.test(r.threw?.message ?? "") && /testGlob/.test(r.threw?.message ?? ""),
    `(no location) the hand-back names the config the project never set (${(r.threw?.message ?? "").slice(0, 140)})`,
  );
  assert(
    r.rosterRuns === 0,
    `(no location) no suite ran, so no roster could be invented (runs: ${String(r.rosterRuns)})`,
  );
}

{
  // The runner ran and exited 0 having written no report: a suite that collected nothing. That is
  // not a suite that passed, and it must not read as one.
  const r = await runVerify({
    issue: 2430,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: PRE_EXISTING, headPassed: [NO_REPORT_SENTINEL], basePassed: NAMES },
  });
  assert(
    r.threw !== undefined && /roster/i.test(r.threw.message),
    `(no report) a head run that wrote no report hands back (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    /report/i.test(r.threw?.message ?? ""),
    `(no report) the hand-back says the report is what is missing (${(r.threw?.message ?? "").slice(0, 140)})`,
  );
}

{
  // The same refusal on the BASE side: the base run is where "pre-existing" is decided, and a base
  // with no report is a base nobody can compare against.
  const r = await runVerify({
    issue: 2431,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: PRE_EXISTING, headPassed: NAMES, basePassed: [NO_REPORT_SENTINEL] },
  });
  assert(
    r.threw !== undefined && /base/i.test(r.threw?.message ?? ""),
    `(base no report) the base's missing report also hands back (${(r.threw?.message ?? r.outcome?.reason ?? "").slice(0, 140)})`,
  );
}

{
  // The base commit carries no file matching the pair. Nothing about the WORK was observed, so this
  // is a hand-back rather than a red, and it must not be billed as a build round.
  const r = await runVerify({
    issue: 2432,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [] },
  });
  assert(
    r.threw !== undefined || r.outcome?.kind !== "green",
    `(nothing to run) an empty enumeration is never a green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  const said = `${r.threw?.message ?? ""}${r.outcome?.reason ?? ""}`;
  assert(
    /no test file|no project suite|no project suite|no test file matched/i.test(said),
    `(nothing to run) the reason says the project's tests could not be found (${said.slice(0, 140)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
