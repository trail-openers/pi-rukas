export { CLOCK, HAPPY, makeAssert, scripted, seedUpTo, tempDir, ticking } from "./lean-engine-fixtures.ts";
import type { LeanRun } from "../../src/lean/state.ts";

/** The rules a `ready + fail` left on the record, for the not-ready cases. */
export const RULES = ["no pi-spec v1 block"];

/**
 * A run sitting on the `not-ready` verdict with its `ready` step already
 * complete and NO reporting step: the exact record a drive leaves behind when
 * it reached the verdict and had not yet posted. Hand-written rather than
 * driven, so a case can start here without the posting step already existing.
 */
export function seedVerdict(dir: string, issue: number): void {
  const seed: LeanRun = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "base",
    branch: `feature/issue-${issue}`,
    state: "not-ready",
    counters: {
      buildAttempts: 0,
      challengeDone: false,
      reviewDone: false,
      ciFixUsed: false,
      draft: false,
    },
    steps: [
      {
        key: `${issue}:ready:0`,
        state: "ready",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "fail", failedRules: RULES },
      },
    ],
  };
  writeState(dir, seed);
}

/** Write a whole run to the path the engine reads it from. */
export function writeState(dir: string, run: LeanRun): void {
  mkdirSync(path.dirname(leanStateFile(dir, run.issue)), { recursive: true });
  writeFileSync(leanStateFile(dir, run.issue), JSON.stringify(run, null, 2), "utf8");
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { leanStateFile } from "../../src/lean/state.ts";
