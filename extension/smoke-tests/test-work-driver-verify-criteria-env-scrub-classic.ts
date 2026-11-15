#!/usr/bin/env bun
/**
 * #2283 — the classic command-criteria tier runs the project's runner with the driver's
 * SCRUBBED environment, the way lean's `verifyOutcome` calls it.
 *
 * `lean/verify.ts` passes `verifyChildEnv()` as `commandCriteriaOutcome`'s `env`, and
 * `runTestFile` forwards that to the spawned runner. The classic tier is the mirror of that
 * call, and a mirror that drops the argument is not a mirror: with no `env`, `runTestFile`
 * spawns with the ambient environment, so every driver knob the `/work` process holds reaches
 * the project's own test file. That is the leak `verifyChildEnv` exists to close (#1064,
 * #1557): a headless runner exports `PI_ENSEMBLE_HANDOFF_CHANNEL`, `PI_ENSEMBLE_PARALLEL_WORK`
 * and the rest, and a project suite that reads one of those names flips behaviour inside the
 * develop gate while the driver's own configuration stays put.
 *
 * The shape of the evidence is the runner's own report, not a mock's claim: the fixture's
 * `sh tests/run.sh {file}` echoes named variables to stderr, and the harness reads each
 * `REPORTED:` line back out of the drive. So an assertion says what the child saw. A knob that
 * arrives is `driver-knob-leak`; one that does not is `ABSENT` (present-but-blank) or `MISSING`
 * (no line at all, which is what a runner that never ran looks like). Those spellings are never
 * collapsed, because a scrub that DELETES the knob and one that BLANKS it are different bugs
 * and only one of them is correct.
 *
 * Two arms per name. The control name is NOT a driver knob, so the scrub must let it through:
 * without it, a tier that passed `env: {}` — scrubbing everything — would satisfy every leak
 * assertion below while no project command could read its own environment.
 */

import { runCriteria, cleanupCriteriaRun } from "./lib/verify-develop-criteria-harness.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { GREEN_CRITERION } from "./lib/verify-develop-criteria-fixture.ts";

/** A driver knob in HEADLESS_INPUTS, so `verifyChildEnv` drops it. A headless cycle holds one
 * of these; the project's runner must not. `HANDOFF_CHANNEL` is the sharpest name to pick:
 * `verifyHostEnv` deliberately KEEPS it for the driver's own host-side git calls, so a wiring
 * that reached for that helper instead of `verifyChildEnv` would leave the leak open and still
 * look like it had been fixed. */
const KNOB = "PI_ENSEMBLE_HANDOFF_CHANNEL";
/** Not in the inventory: the scrub has to leave it alone, which is what proves the child is
 * reading an environment at all rather than the empty object a `env: {}` wiring would give. */
const CONTROL = "PI_RUKAS_CRITERIA_ENV_CONTROL";

const LEAK = "driver-knob-leak";
const CONTROL_VALUE = "project-visible";

{
  const r = await runCriteria({
    criteria: [GREEN_CRITERION],
    env: { [KNOB]: LEAK, [CONTROL]: CONTROL_VALUE },
    echoEnv: [KNOB, CONTROL],
  });
  assert(
    r.mine.length === 0,
    `the arm really ran a criterion (otherwise "did not see it" is vacuous): ${r.mine.join(" | ")}`,
  );
  assert(
    r.reported[CONTROL] === CONTROL_VALUE,
    `a non-knob variable reaches the project's runner unchanged — the child has an environment at all (got ${String(r.reported[CONTROL])})`,
  );
  assert(
    r.reported[KNOB] !== LEAK,
    `a driver knob set in the DRIVER's environment is scrubbed from the criterion runner (the runner reported ${String(r.reported[KNOB])})`,
  );
  cleanupCriteriaRun(r);
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
