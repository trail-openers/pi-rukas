#!/usr/bin/env bun
/**
 * #2428 AC4 — the two bench cells that motivated Part A, as fixtures.
 *
 * Both are the same failure seen from two sides: the gate's evidence did not include the project's
 * own tests, so a run could look clean while its suite was broken.
 *
 *  **Cell 1** — a project tier exits 1 only on tests the run never runs. The tier's exit code is
 *  about a command, not a suite; the project's real tests are what an operator means by "the tests",
 *  and before Part A nothing in the step ran them. Today: a green that never touched the suite.
 *
 *  **Cell 2** — the build edits an existing test's expectation, `verify` runs the edited copy and
 *  passes, and the hidden run restores the original and fails. A gate that runs only what is in the
 *  tree certifies a green over a contract the run rewrote.
 *
 * Each cell is asserted twice: once as the gate must answer it NOW (roster on), and once as the
 * switch's off arm answers it — which is the shape that shipped before, and the reason AC5's
 * byte-identical claim matters.
 */
import { rmSync } from "node:fs";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { NO_REPORT_SENTINEL } from "./lib/lean-verify-roster.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";
import { withEnv } from "./lib/env-scope.ts";

/**
 * Run one case with the roster lever taken off, and put the environment back exactly as it was.
 *
 * `withEnv` owns the restore, including putting an absent variable back ABSENT rather than blank —
 * the distinction that decides whether the next case reads "unset" or "the empty string".
 */
async function withRosterOff<T>(body: () => Promise<T>): Promise<T> {
  let out!: T;
  await withEnv({ PI_ENSEMBLE_LEAN_PROJECT_ROSTER: "0" }, async () => {
    out = await body();
  });
  return out;
}

const SELF = "test-AC4-project-roster-bench-cells.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

{
  // ── Bench cell 1 ──────────────────────────────────────────────────────────────────────────────
  // The configured tiers say nothing about the project's real suite: `fast` passes and there is no
  // `full`. The suite exists, the base ran it, and head broke one of its tests.
  const FILE = "tests/test-project.sh";
  const OK = "tests/test-project.sh::still_green";
  const BROKEN = "tests/test-project.sh::this_run_broke_it";

  const caught = await runVerify({
    issue: 2460,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      basePassed: [OK, BROKEN],
      headPassed: [OK],
      headFailed: [BROKEN],
    },
  });
  assert(
    caught.outcome?.kind === "red",
    `(cell 1) a suite the tiers never touch is still judged: the run is red (got ${caught.outcome?.kind ?? `threw: ${caught.threw?.message}`})`,
  );
  assert(
    (caught.outcome?.reason ?? "").includes(BROKEN),
    `(cell 1) and the reason names the broken test (${(caught.outcome?.reason ?? "").slice(0, 150)})`,
  );
  assert(
    // Head failed, so the base run is owed and made: the two counters say 1 + 1 where a shared
    // count could only have said 2 and left a skipped base leg indistinguishable from a lost run.
    caught.rosterHeadRuns === 1 && caught.rosterBaseRuns === 1,
    `(cell 1) the project's suite ran once in the run's worktree and once in the base checkout, not just the run's (${String(caught.rosterHeadRuns)} head, ${String(caught.rosterBaseRuns)} base)`,
  );

  // The same tree with the roster lever taken off: no suite runs, and the step answers the way it
  // did before Part A — a green off the tiers alone. This is the shape the cell was red in, made
  // explicit, and the lever remains the operator's way to get it (#2438 R4 keeps it retained).
  const blind = await withRosterOff(() =>
    runVerify({
      issue: 2461,
      implement: true,
      config: { fast: PASS_TIER },
      roster: {
        files: [FILE],
        basePassed: [OK, BROKEN],
        headPassed: [OK],
        headFailed: [BROKEN],
      },
    }),
  );
  assert(
    blind.outcome?.kind === "green",
    `(cell 1/off) with the lever off the project's suite never runs and the tiers alone decide (got ${blind.outcome?.kind ?? `threw: ${blind.threw?.message}`})`,
  );
  assert(
    blind.rosterRuns === 0,
    `(cell 1/off) and not one project test ran — which is the hole AC4 records (${String(blind.rosterRuns)})`,
  );
  assert(
    blind.outcome?.projectRoster === undefined,
    "(cell 1/off) the off arm records no roster at all",
  );
}

{
  // ── Bench cell 2 ──────────────────────────────────────────────────────────────────────────────
  // The run rewrites an existing test; the head copy passes and the base copy fails against the head
  // code. Only re-running the BASE bytes catches it, so that is what this asserts.
  const FILE = "tests/test-a.sh";
  const NAME = "tests/test-a.sh::one";
  const edited = await runVerify({
    issue: 2462,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], basePassed: [NAME], headPassed: [NAME] },
    editProjectTests: { [FILE]: "#!/bin/sh\nexit 0\n" },
    baseProjectTestFails: true,
  });
  const said = `${edited.threw?.message ?? ""}${edited.outcome?.reason ?? ""}`;
  assert(
    edited.outcome?.kind !== "green" && edited.outcome?.kind !== undefined,
    `(cell 2) an edited test whose base version fails the head code is not green (got ${edited.outcome?.kind ?? "threw"})`,
  );
  assert(
    /base version/i.test(said) && said.includes(FILE),
    `(cell 2) the refusal names the file whose base version broke (${said.slice(0, 150)})`,
  );

  // Off: the step runs the edited copy, sees it pass, and has no idea the original ever failed.
  const blind = await withRosterOff(() =>
    runVerify({
      issue: 2463,
      implement: true,
      config: { fast: PASS_TIER },
      roster: { files: [FILE], basePassed: [NAME], headPassed: [NAME] },
      editProjectTests: { [FILE]: "#!/bin/sh\nexit 0\n" },
      baseProjectTestFails: true,
    }),
  );
  assert(
    blind.outcome?.kind === "green",
    `(cell 2/off) with the lever off the edited copy alone is what passes for the suite (got ${blind.outcome?.kind ?? `threw: ${blind.threw?.message}`})`,
  );
  assert(
    blind.outcome?.projectRoster === undefined,
    "(cell 2/off) and no roster records what was skipped",
  );
}

{
  // ── The third shape the bench could not tell apart ────────────────────────────────────────────
  // A suite that collected nothing and a suite that passed everything both exit 0. The roster makes
  // them different records, and only one of them may be a green.
  const FILE = "tests/test-a.sh";
  const nothing = await runVerify({
    issue: 2464,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], basePassed: [NO_REPORT_SENTINEL], headPassed: [NO_REPORT_SENTINEL] },
  });
  assert(
    nothing.threw !== undefined || nothing.outcome?.kind !== "green",
    `(collected nothing) an empty report is never a green (got ${nothing.outcome?.kind ?? "threw"})`,
  );
  const allPassed = await runVerify({
    issue: 2465,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], basePassed: ["t::a", "t::b"], headPassed: ["t::a", "t::b"] },
  });
  const roster = allPassed.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    allPassed.outcome?.kind === "green" && (roster?.total ?? 0) === 2,
    `(all passed) a suite that ran two tests and passed both is the green (${String(allPassed.outcome?.kind)}; total ${String(roster?.total)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
