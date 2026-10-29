/**
 * lib/lean-test-location-fixture — the shared fixture and assertions for the
 * files that pin the configured test location (`verify.testDir` +
 * `verify.testGlob`).
 *
 * The seam is the kind of knowledge each file judges, not an arbitrary halving.
 * `test-lean-test-location.ts` judges the RULES: pure functions and the
 * boundary, where an expectation is a string comparison.
 * `test-lean-test-location-steps.ts` judges the STEPS: real temp git repos, a
 * frozen commit, the reason a run reports. The shared parts are the config the
 * rules read and the assertion helper, so a case in either file cannot quietly
 * disagree with the other about what `extension/smoke-tests` + `test-*.ts`
 * means, which is the only way two files about one feature drift apart.
 */

import { type WorkConfig, defaultConfig } from "../../src/lean/config.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import { RUNNER } from "./lean-build-fixture.ts";

let exit = 0;

/**
 * Records a pass/fail and returns the verdict, so EVERY file reports through one
 * helper and exits non-zero on any failure. A second `assert` in a second file
 * is the shape that lets one half of a feature's suite go quiet.
 */
export function assert(cond: boolean, msg: string): boolean {
  if (cond) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}`);
  exit = 1;
  return false;
}

/** The process exit code the files sharing this helper report through. */
export function testLocationExit(): number {
  return exit;
}

/**
 * The location every rule case reads: this repo's own folder and convention,
 * because the config the driver ships (#1883) is the one whose rules are pinned.
 */
export const LOC = { testDir: "extension/smoke-tests", testGlob: "test-*.ts" };

/** A worktree path for prompt assertions; no case touches this directory. */
export const WT = "/tmp/lean-test-dir/.worktrees/lean-1883";

/** A spec with one `verify: "test"` criterion and one manual one. */
export const SPEC: PiSpec = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [
    { id: "AC1", text: "retries a transient failure", verify: "test" },
    { id: "AC2", text: "documents the budget", verify: "manual" },
  ],
};

/**
 * A config that names the folder the project keeps its tests in, so a case can
 * drive the `verify.testDir` / `verify.testGlob` prompts and boundary.
 *
 * The ONE copy: both lean fixture modules re-export it, so a case in a specify
 * file and a case in a challenge file cannot disagree about what
 * `extension/smoke-tests` + `test-*.ts` means. `runner` is the last argument
 * rather than a `verify` object because every caller wants the fixture's own
 * runner and none wants to rebuild the rest of the block.
 */
export function configWithLocation(
  testDir: string,
  testGlob: string,
  runner: string = RUNNER,
): WorkConfig {
  return { ...defaultConfig(), verify: { fast: "true", test: runner, testDir, testGlob } };
}
