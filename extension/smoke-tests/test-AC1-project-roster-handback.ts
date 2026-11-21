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
  // in the record. The two sides are counted APART (`rosterHeadRuns` / `rosterBaseRuns`) because a
  // shared count cannot tell a skipped base leg from a base run that never happened (#2439 R4) — and
  // a record that appeared without both runs behind it is the defect, not a passing case.
  const r = await runVerify({
    issue: 2428,
    implement: true,
    config: { fast: PASS_TIER },
    // One name fails at BOTH commits: the baseline comparison is then a live run rather than the
    // skipped leg a clean head buys (#2439 R3), so this case keeps judging what it was written to
    // judge. A name the base failed too is not charged, so the run is still green.
    roster: {
      files: PRE_EXISTING,
      headPassed: NAMES,
      basePassed: NAMES,
      headFailed: [`${PRE_EXISTING[0]}::broken_before_this_run`],
      baseFailed: [`${PRE_EXISTING[0]}::broken_before_this_run`],
    },
  });
  assert(
    r.outcome?.kind === "green",
    `(built) a roster both runs agree on is green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 120)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(roster !== undefined, "(built) the green carries a projectRoster");
  assert(
    r.rosterHeadRuns === 1 && r.rosterBaseRuns === 1,
    `(built) the project's suite ran at head AND at the base (${String(r.rosterHeadRuns)} head, ${String(r.rosterBaseRuns)} base)`,
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
    roster?.total === NAMES.length + 1 && roster?.baseTotal === NAMES.length + 1,
    `(built) the totals are the runs' own counts, failures included (head ${String(roster?.total)}, base ${String(roster?.baseTotal)})`,
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
    roster: {
      files: PRE_EXISTING,
      headPassed: NAMES,
      basePassed: [NO_REPORT_SENTINEL],
      // A clean head would SKIP the base leg, and the case asks what a base with no report does to
      // a roster — so the head has to have failed something the gate still owes a base run for.
      headFailed: [`${PRE_EXISTING[0]}::broken_before_this_run`],
    },
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

{
  // The base checkout never received the project's dependencies. Swallowed, that failure leaves a
  // base tree whose suite cannot even import, so every head failure matches a base failure and the
  // whole-line excuse reads them as "already broken at base" — a green graded on a base that never
  // ran. The roster's authority is that its base run OBSERVED the real suite, so this hands back and
  // names the base tree's dependencies as what is missing.
  const r = await runVerify({
    issue: 2432,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: PRE_EXISTING,
      headPassed: NAMES,
      basePassed: NAMES,
      baseMissingDeps: ["node_modules"],
      // As above: an unprovisioned base is only asked about on a run that owes a base suite.
      headFailed: [`${PRE_EXISTING[0]}::green_at_base`],
      basePassed: NAMES,
    },
  });
  const said = `${r.threw?.message ?? ""}${r.outcome?.reason ?? ""}`;
  assert(
    r.threw !== undefined,
    `(no deps) an unprovisioned base checkout hands back rather than grading green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    /dependenc/i.test(said),
    `(no deps) the hand-back names the base tree's dependencies as what is missing (${said.slice(0, 200)})`,
  );
  assert(
    r.outcome === undefined,
    "(no deps) no outcome is recorded — a base nobody provisioned decided nothing",
  );
  assert(
    r.rosterHeadRuns === 1 && r.rosterBaseRuns === 0,
    `(no deps) the head ran and the base never completed (${String(r.rosterHeadRuns)} head, ${String(r.rosterBaseRuns)} base)`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
