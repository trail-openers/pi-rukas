/**
 * lib/lean-request-stall-golden — the drive whose bytes `test-lean-request-stall-golden.ts`
 * compares against a capture taken from the tree before `PI_ENSEMBLE_LEAN_REQUEST_STALL` existed.
 *
 * It imports only modules and fixture options that tree already had, so the SAME file runs inside a
 * worktree of the base commit to take the capture and here to take the comparison: the expected
 * bytes never come from the code under change. Two build cells, both under the switch's off value
 * (an unknown variable to the base tree): a child that does its work and goes quiet, and a child
 * stopped by its `turns` ceiling. Each cell yields the three surfaces a host and an operator read —
 * the step's whole outcome record, the handback cause line, and the headless `failure`.
 *
 * Capture: copy this file into `extension/smoke-tests/lib/` of a worktree of the base commit and run
 * `bun -e 'import("./smoke-tests/lib/lean-request-stall-golden.ts").then(async (m) =>
 * console.log(JSON.stringify(await m.driveStallOffArm(), null, 2)))'` from its `extension/`; write
 * the output, with `capturedFrom` naming that commit, to {@link STALL_GOLDEN}.
 */

import { defaultConfig } from "../../src/lean/config.ts";
import { neededFromLog } from "../../src/lean/handback.ts";
import { assertRunFile, INITIAL_COUNTERS } from "../../src/lean/state.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import { leanIssueResult } from "../../src/headless/work-lean-result.ts";
import { emptyRunningState } from "../../src/progress.ts";
import { withEnv } from "./env-scope.ts";
import { put } from "./lean-build-artifacts.ts";
import { configWithRunner } from "./lean-build-asserts.ts";
import { runBuild } from "./lean-build-fixture.ts";

/** Where the capture lives, relative to `smoke-tests/`. */
export const STALL_GOLDEN = "fixtures/lean-state/request-stall-off-2644.json";

const MINUTE = 60_000;
const START = 1_700_000_000_000;
const TURNS = 3;

export interface StallGoldenCell {
  outcome: unknown;
  needed: string;
  failure: unknown;
}

/** The three surfaces of one build step's outcome; the two derived ones read the loaded run. */
function surfaces(issue: number, outcome: unknown): StallGoldenCell {
  const run = assertRunFile(
    {
      schema: 1,
      issue,
      version: "golden",
      models: {},
      baseSha: "0000000000000000000000000000000000000000",
      branch: `lean/issue-${String(issue)}`,
      // A host reads `failure` only off a finished run; handed-back is the state a stopped build ends in.
      state: "handed-back",
      counters: { ...INITIAL_COUNTERS },
      steps: [{ key: `${String(issue)}:build:0`, state: "build", startedAt: START, outcome }],
    },
    "golden",
  );
  return {
    // The record as the step wrote it: the loader drops a key it does not know, which would hide one.
    outcome: outcome ?? null,
    needed: neededFromLog(run.steps),
    failure: leanIssueResult(run, 30).failure ?? null,
  };
}

/** Both cells under the off value. The child writes the same file in each, so the records differ
 *  only by what stopped it. */
export async function driveStallOffArm(): Promise<Record<string, StallGoldenCell>> {
  const cells: Record<string, StallGoldenCell> = {};
  await withEnv(
    { PI_ENSEMBLE_LEAN_REQUEST_STALL: "0", PI_ENSEMBLE_DISPATCH_CAPS: "1" },
    async () => {
      const base = {
        clock: { deadlineMs: START + 70 * MINUTE, now: () => START + 20 * MINUTE },
        child: (wt: string) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      };
      const quiet = await runBuild({
        ...base,
        issue: 2644,
        config: {
          ...configWithRunner(),
          budgets: { ...defaultConfig().budgets, build: { turns: 0, tokens: 0, minutes: 0 } },
        },
        // Read only by a tree that has the lever; the base tree drops it.
        silentMs: 28 * MINUTE,
      } as Parameters<typeof runBuild>[0]);
      cells.quiet = surfaces(2644, quiet.outcome);
      const stopped = await runBuild({
        ...base,
        issue: 2645,
        config: {
          ...configWithRunner(),
          budgets: { ...defaultConfig().budgets, build: { turns: TURNS, tokens: 0, minutes: 0 } },
        },
        onProgressTick: (onProgress: BudgetOpts["onProgress"]) =>
          onProgress?.({ ...emptyRunningState("developer"), turns: TURNS + 1 }),
      });
      cells.turns = surfaces(2645, stopped.outcome);
    },
  );
  return cells;
}
