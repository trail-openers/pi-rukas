#!/usr/bin/env bun
/**
 * #2428 AC3 — every pre-existing test file the run EDITED has its BASE version run against the head
 * code, and a base version that passed at base and fails there makes land refuse.
 *
 * Bench cell 2 is the whole reason: the build edits an existing test's expectation, `verify` runs the
 * edited copy and passes, and the hidden run restores the original and fails. A gate that only ever
 * runs what is in the tree today certifies a green over a contract the run silently rewrote. The
 * roster is what closes it — the file's base bytes, materialised and run against the head code, with
 * the project's own `verify.test` template.
 *
 * The land half is asserted through `landEarned` rather than a comment: a roster that recorded a
 * failing base version must never be the record a merge is licensed on.
 */
import { rmSync } from "node:fs";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import type { LeanRun } from "../src/lean/state.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC3-project-roster-edited-base.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const FILE = "tests/test-a.sh";
const NAME = "tests/test-a.sh::one";

/** The base's version of the file: a runner whose exit code is the case's choice. */
function baseScript(red: boolean): string {
  return `#!/bin/sh\nexit ${red ? "1" : "0"}\n`;
}

{
  // The honest shape: the run edited a pre-existing test, its base version still passes against the
  // head code, and the record says which files were put through that. Without the record, "we ran the
  // base versions" would be narration.
  const r = await runVerify({
    issue: 2450,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], basePassed: [NAME], headPassed: [NAME] },
    editProjectTests: { [FILE]: "#!/bin/sh\n# rewritten by the run\nexit 0\n" },
  });
  assert(
    r.outcome?.kind === "green",
    `(edited green) an edited pre-existing test whose base version passes is green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 130)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    JSON.stringify(roster?.editedFiles) === JSON.stringify([FILE]),
    `(edited green) the record names the edited file whose base version was run (${JSON.stringify(roster?.editedFiles)})`,
  );
  assert(
    r.threw === undefined || !/dirty/i.test(r.threw.message),
    `(edited green) the gate's own scratch bytes are never reported as a tier leaving the tree dirty (${(r.threw?.message ?? "").slice(0, 120)})`,
  );
}

{
  // Bench cell 2 proper: the base version of the edited file FAILS against the head code. The run
  // rewrote the contract its own tests were written against, so there is nothing for a build round to
  // fix and the answer is a refusal that names the file — not a green, and not a silent pass.
  const r = await runVerify({
    issue: 2451,
    implement: true,
    config: { fast: PASS_TIER },
    // The base's copy of the file is a script that fails; the head's copy (below) is the run's edit
    // of it, which passes. Only re-running the BASE bytes against the head code can tell them apart.
    roster: { files: [FILE], basePassed: [NAME], headPassed: [NAME] },
    editProjectTests: { [FILE]: baseScript(false) },
    baseProjectTestFails: true,
  });
  const said = `${r.threw?.message ?? ""}${r.outcome?.reason ?? ""}`;
  assert(
    r.outcome?.kind === "red" || r.threw !== undefined,
    `(edited red) a base version that fails against the head code is never a green (got ${r.outcome?.kind ?? "threw"})`,
  );
  assert(
    /base version/i.test(said) && said.includes(FILE),
    `(edited red) the refusal names the file whose base version broke (${said.slice(0, 160)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    r.outcome?.kind !== "green" || roster?.editedFiles === undefined,
    "(edited red) no green ever carries an editedFiles entry for a file whose base version failed",
  );
}

{
  // The land half (#2428 AC6 shared): a green whose roster records the edited files is what land
  // reads. Ask landEarned about the two records directly, since a verify green that land then refused
  // would be a different bug from one it accepted.
  const { engineFacts } = await import("../src/lean/engine-facts.ts");
  const { createRun } = await import("../src/lean/state.ts");
  const green = await runVerify({
    issue: 2452,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], basePassed: [NAME], headPassed: [NAME] },
    editProjectTests: { [FILE]: "#!/bin/sh\nexit 0\n" },
  });
  assert(
    green.outcome?.kind === "green",
    `(land) the control green exists (${String(green.outcome?.kind)})`,
  );
  // A real log's bytes with the verify outcome swapped, because the gate reads the RECORD: a fixture
  // that invented a run shape could invent one that passes for the wrong reason.
  const runWith = (outcome: Record<string, unknown>): LeanRun =>
    ({
      ...createRun({
        issue: 2452,
        version: "test",
        models: {},
        baseSha: green.baseSha ?? "0".repeat(40),
        branch: "lean/issue-2452",
      }),
      state: "landed",
      steps: [
        {
          key: "2452:verify:0",
          state: "verify",
          startedAt: 1,
          outcome: { kind: "green", ...outcome },
        },
        { key: "2452:ci:0", state: "ci", startedAt: 2, outcome: { kind: "green" } },
      ],
    }) as unknown as LeanRun;
  const roster = green.outcome?.projectRoster as ProjectRosterRecord;
  // The positive control has to be a roster with no edited files: this run DID edit one, so its own
  // record is the refused shape and cannot also be the earned one. The rest of the fields are the
  // step's real bytes, so the passing case passes on what the gate wrote rather than on a fixture's.
  assert(
    JSON.stringify(roster.editedFiles) === JSON.stringify([FILE]),
    `(land) the control's record names the file this run edited (${JSON.stringify(roster.editedFiles)})`,
  );
  assert(
    engineFacts.landEarned(runWith({ projectRoster: { ...roster, editedFiles: undefined } })) ===
      true,
    "(land) a green carrying a roster with no failing base version earns the land",
  );
  assert(
    engineFacts.landEarned(runWith({})) === false,
    "(land) a green with NO roster is refused rather than defaulted to an empty one",
  );
  assert(
    engineFacts.landEarned(runWith({ projectRoster: { ...roster, editedFiles: [FILE] } })) ===
      false,
    "(land) a roster naming an edited file whose base version failed is refused",
  );
  assert(
    engineFacts.landEarned(runWith({ projectRoster: { ...roster, total: 0 } })) === false,
    "(land) a roster that ran nothing is refused even beside a green",
  );
  const refusal = engineFacts.landRefusal(runWith({}));
  assert(
    /roster/i.test(refusal),
    `(land) the refusal names the roster, not "verify not green" (${refusal.slice(0, 140)})`,
  );
}

{
  // A file the run ADDED is not "edited": the roster's per-test verdicts already cover it, and
  // calling an addition an edit would make every new test demand a base version that never existed.
  const r = await runVerify({
    issue: 2453,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], basePassed: [NAME], headPassed: [NAME] },
  });
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    r.outcome?.kind === "green" && roster?.editedFiles === undefined,
    `(no edit) a run that touched no pre-existing test records no editedFiles (${String(r.outcome?.kind)}; ${JSON.stringify(roster?.editedFiles)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
