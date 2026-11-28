#!/usr/bin/env bun
/**
 * The head run of a repair round is bounded and scrubbed like every other runner the round starts (#2668).
 *
 * The judge's base run passes `limits: { env: verifyChildEnv(), timeoutMs }`. The head run — the same
 * `runTestFile`, on the same throwaway checkout, one step later — passed no limits at all: it ran on the
 * driver's own environment and on the default two-minute ceiling. One project command that never returns
 * therefore held a whole /work cycle by its own timeout, and any knob the driver exports reached the
 * project's tests from the one step whose whole point is that it runs the project's own command.
 *
 * The runner script here is a REAL `sh` script in the fixture repo, and it hangs only for the file the head
 * run is given — the judge's base run has to answer quickly and red, or the round never reaches the head.
 * Production code throughout: the real `runRepairRound`, a real repo and worktree, a real runner. Only the
 * model is faked.
 */

import { defaultConfig } from "../src/lean/config.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { HANGING_REL, KNOB_VALUE, driveRound, headRow } from "./lib/lean-oracle-repair-round.ts";

const { assert, failures } = makeAssert();

const r = await driveRound(2777, {}, { headRunBudgetMs: 400 });

assert(
  headRow(r.rows) !== undefined,
  `(1) the round reached the head run (${JSON.stringify(r.rows)})`,
);
assert(
  r.ms < 30_000,
  `(2) the head run was bounded: the round returned in ${String(r.ms)}ms instead of holding the cycle for the runner's own 30s sleep (verdict: ${r.kind}, ${r.why})`,
);
// The runner goes red for a file it was handed while a driver knob sits in its environment, and green when the
// round scrubbed it. Two halves, both read from the round's own record rather than from a token the runner
// would have to invent: nothing may PRINT the knob, and the head run may not be the leak that answers a
// contract green. A run that leaked reads red here — the project's own command, run on the driver's knobs,
// is not evidence the contract holds.
assert(
  !r.rows.some((row) => row.includes(KNOB_VALUE)),
  `(3a) no runner printed the driver knob's value (${JSON.stringify(r.rows)})`,
);
// The record the harness's exec kept of the argument the PRODUCT passed: a run handed no child env is a run
// handed the driver's own environment, which is the defect this test exists for.
const projectRuns = r.envs.filter((e) => e.file.endsWith(".test.sh"));
assert(
  projectRuns.length > 0 && projectRuns.every((e) => e.given === "scrubbed"),
  `(3b) every run of the project's own command was handed a scrubbed child env (${JSON.stringify(projectRuns)})`,
);
assert(
  r.kind === "repaired" && r.why === "not refused (repaired)",
  `(4) a head the round could not read is recorded as not passing, not as a hang (verdict ${r.kind})`,
);

if (failures() > 0) process.exitCode = 1;
else console.log("lean oracle repair head bound: OK");
void defaultConfig;
