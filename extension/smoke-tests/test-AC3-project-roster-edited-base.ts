#!/usr/bin/env bun
/**
 * #2428 AC3 / #2410 R5 — every pre-existing test file the run EDITED has its BASE version run against
 * the head code, and land refuses only when one of those base versions is NEWLY FAILING.
 *
 * Bench cell 2 is the whole reason: the build edits an existing test's expectation, `verify` runs the
 * edited copy and passes, and the hidden run restores the original and fails. A gate that only ever
 * runs what is in the tree today certifies a green over a contract the run silently rewrote. The
 * roster is what closes it — the file's base bytes, materialised and run against the head code, with
 * the project's own `verify.test` template.
 *
 * R5 is the refusal's CONDITION, and it is narrower than "the run touched a test": land refuses a
 * roster with at least one test and NO newly failing edited-file base version. An edited file whose
 * base version still passes is the honest case — the run rewrote a test and the old contract still
 * held — so it must LAND, with `editedFiles` kept as the record of what was put through that. Refusing
 * land on any non-empty `editedFiles` would refuse every legitimate test edit, which is Part B's
 * subject, not Part A's.
 *
 * The land half is asserted through `landEarned` rather than a comment, because the gate reads the
 * RECORD: a roster that recorded a failing base version must never license a merge, and one that
 * recorded only passing base versions must never be refused for the edit alone.
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
  // R5's honest shape: the run edited a pre-existing test, its base version still passes against the
  // head code, and the record says which files were put through that. Without the record, "we ran the
  // base versions" would be narration — and without this case, the gate's refusal could (and did)
  // refuse the mere fact of an edit rather than the newly failing base version R5 names.
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
  // THE REFUSAL THIS CASE EXISTS FOR (R5, AC3): the run edited a pre-existing test and its base
  // version passed against the head code, so the merge gate has to let it through. The record says
  // which files were put through that, so `editedFiles` is non-empty by design — a gate that refused
  // land on a non-empty `editedFiles` refused every legitimate test edit, and an honest run had no
  // path to `landed` at all.
  const { engineFacts: editedFacts } = await import("../src/lean/engine-facts.ts");
  const { createRun: editedCreateRun } = await import("../src/lean/state.ts");
  assert(
    Array.isArray(roster?.editedFiles) && roster.editedFiles.length > 0,
    `(edited land) the green's record really does name an edited file, so the assertion below cannot pass on an empty list (${JSON.stringify(roster?.editedFiles)})`,
  );
  assert(
    editedFacts.landEarned(
      {
        ...editedCreateRun({
          issue: 2450,
          version: "test",
          models: {},
          baseSha: r.baseSha ?? "0".repeat(40),
          branch: "lean/issue-2450",
        }),
        state: "landed",
        steps: [
          {
            key: "2450:verify:0",
            state: "verify",
            startedAt: 1,
            outcome: { kind: "green", projectRoster: roster },
          },
          { key: "2450:ci:0", state: "ci", startedAt: 2, outcome: { kind: "green" } },
        ],
      } as unknown as LeanRun,
    ) === true,
    "(edited land) an edited file whose base version PASSED against the head code earns the land (R5 refuses only a newly failing base version)",
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
  // R5's refusal, at the STEP: the run edited a pre-existing test AND a pre-existing test that the
  // base passed now fails at head. That combination cannot be a green — the roster is the arbiter for
  // project tests, so the step goes `red` naming the test — and it is the record shape land must never
  // license: an `editedFiles` entry standing beside a head failure says a base version was vouched
  // for while the same suite was failing.
  const r = await runVerify({
    issue: 2454,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      basePassed: [NAME],
      headPassed: [],
      headFailed: [NAME],
      baseFailed: [],
    },
    editProjectTests: { [FILE]: "#!/bin/sh\nexit 0\n" },
  });
  const said = `${r.threw?.message ?? ""}${r.outcome?.reason ?? ""}`;
  assert(
    r.outcome?.kind === "red",
    `(edited + newly failing) a base-passing test that head fails is red, not a green beside an edit (got ${r.outcome?.kind ?? "threw"})`,
  );
  assert(
    said.includes(NAME),
    `(edited + newly failing) the refusal names the test that was green at base (${said.slice(0, 160)})`,
  );
  assert(
    r.outcome?.projectRoster === undefined,
    "(edited + newly failing) the red carries no roster, so land has nothing to license itself on",
  );
}

{
  // The land half (#2428 AC6 shared): a green whose roster records the edited files is what land
  // reads. Ask landEarned about the records directly, since a verify green that land then refused
  // would be a different bug from one it accepted. The refused record here is INVENTED — the step
  // never writes an `editedFiles` entry beside a red base version, because it went `red` before it
  // could — and reading the record anyway is what catches a resumed log that pairs a green with a
  // roster the step would never have written.
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
  assert(
    JSON.stringify(roster.editedFiles) === JSON.stringify([FILE]),
    `(land) the control's record names the file this run edited (${JSON.stringify(roster.editedFiles)})`,
  );
  // The same record with the edited file's base version FAILING — the shape the step refuses to
  // write, and the one R5 says land must refuse. Built by hand because the step cannot reach it: the
  // gate went `red` at `runEditedBaseVersions` before any roster existed.
  const forgedFailingBase: ProjectRosterRecord = {
    ...roster,
    editedFiles: [FILE],
    failed: [...roster.failed, NAME],
    total: roster.total + 1,
    baseFailed: [...roster.baseFailed, NAME],
    baseTotal: roster.baseTotal + 1,
  };
  assert(
    JSON.stringify(forgedFailingBase.editedFiles) === JSON.stringify([FILE]),
    "(land) the forged record keeps the edited file the refusal is about",
  );
  assert(
    engineFacts.landEarned(runWith({ projectRoster: roster })) === true,
    "(land) a green whose edited file's base version passed earns the land (R5: no newly failing base version)",
  );
  assert(
    engineFacts.landEarned(
      runWith({ projectRoster: { ...roster, editedFiles: undefined } }),
    ) === true,
    "(land) a green carrying a roster with no edited files at all earns the land too",
  );
  assert(
    engineFacts.landEarned(runWith({})) === false,
    "(land) a green with NO roster is refused rather than defaulted to an empty one",
  );
  assert(
    engineFacts.landEarned(runWith({ projectRoster: forgedFailingBase })) === false,
    "(land) a roster naming an edited file whose base version failed is refused",
  );
  assert(
    /roster/i.test(engineFacts.landRefusal(runWith({ projectRoster: forgedFailingBase }))),
    "(land) the refusal for that record names the roster, not a gate that reported green",
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
