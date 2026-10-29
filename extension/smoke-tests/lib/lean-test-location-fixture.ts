/**
 * lib/lean-test-location-fixture — the shared fixture and assertions for the
 * two files that pin the configured test location (`verify.testDir` +
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

import { chmodSync } from "node:fs";
import path from "node:path";
import type { PiSpec } from "../../src/lean/spec.ts";
import { put } from "./lean-build-fixture.ts";

let exit = 0;

/**
 * Records a pass/fail and returns the verdict, so BOTH files report through one
 * helper and both exit non-zero on any failure. A second `assert` in a second
 * file is the shape that lets one half of a feature's suite go quiet.
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

/** The process exit code the two files share. */
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
 * A challenge edge case the runner can execute.
 *
 * The fixture's `put` writes 0o644 and the runner these cases use is
 * `sh {file}`, so a non-executable script is an INFRA throw ("the runner could
 * not be started") rather than the red or green the case is asserting — the bit
 * is set here so every case fails or passes for the reason it means to.
 */
export function executable(wt: string, rel: string, content: string): void {
  put(wt, rel, content);
  chmodSync(path.join(wt, rel), 0o755);
}
