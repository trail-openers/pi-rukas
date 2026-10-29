/**
 * lean/challenge-dispatch — the one adversary the challenge step pays for, and
 * the throw a dead child deserves.
 *
 * Same shape as `build-dispatch.ts`: a single `developer` fenced to the run's
 * worktree, given the reporter companion that lets it declare what it wrote, and
 * a child that died mid-stream is infrastructure. It is never reported as `none`
 * — `none` is the verdict "I looked and the builder closed every case I could
 * find", and a child that never ran looked at nothing. Reading a dead dispatch as
 * that verdict would let an outage certify an implementation, which is the exact
 * claim the round exists to make expensive.
 *
 * The prompt is assembled in `challenge-prompt.ts`; this module owns only the
 * seam and the failure taxonomy.
 */

import path from "node:path";
import { statReporterPath } from "../reporter-preflight.ts";
import type { DispatchResult } from "../types.ts";
import { challengePrompt } from "./challenge-prompt.ts";
import type { ChallengeDispatch } from "./challenge-types.ts";
import type { TestLocation } from "./config.ts";
import type { PiSpec } from "./spec.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./submit-tests-reporter.ts";

/** An adversary we could not run. The engine turns this into handed-back 10. */
export class ChallengeInfraError extends Error {
  override readonly name = "ChallengeInfraError";
}

/** The prompt's inputs, gathered by `challenge.ts` from the step log and the forge. */
export interface ChallengeDispatchOpts {
  issue: number;
  spec: PiSpec;
  /** The frozen acceptance tests the child is shown and told not to touch. */
  frozenPaths: string[];
  wt: string;
  repoRoot: string;
  /** The project's `verify.test` runner template, if configured. */
  testRunner?: string;
  /** The project's `verify.testDir` + `verify.testGlob`, if configured. */
  testLocation?: TestLocation;
  /** Preflight for the reporter companion; `statReporterPath` in production. */
  statReporter?: (p: string) => Promise<unknown>;
}

/** Dispatch one adversary, and turn a non-OK child into the throw it deserves. */
export async function dispatchAdversary(
  dispatch: ChallengeDispatch,
  opts: ChallengeDispatchOpts,
): Promise<unknown[]> {
  await (opts.statReporter ?? statReporterPath)(SUBMIT_TESTS_REPORTER_PATH);
  const prompt = challengePrompt({
    issue: opts.issue,
    spec: opts.spec,
    frozenPaths: opts.frozenPaths,
    worktree: opts.wt,
    ...(opts.testRunner === undefined ? {} : { testRunner: opts.testRunner }),
    ...(opts.testLocation === undefined ? {} : { testLocation: opts.testLocation }),
  });
  const result = await dispatch(
    { role: "developer", prompt, cwd: opts.wt },
    {
      writeFence: {
        root: opts.wt,
        repo: opts.repoRoot,
        // `<repoRoot>/tmp/lean-<issue>`: the worktree's parent is `.worktrees`,
        // so one `..` from it is the repo root — the scratch dir the scratch
        // hygiene convention names, inside the run's own clone.
        scratch: path.join(path.dirname(opts.wt), "..", "tmp", `lean-${opts.issue}`),
      },
      extraArgs: ["--no-skills", "--extension", SUBMIT_TESTS_REPORTER_PATH],
    },
  );
  if (!result.ok || result.killCause !== undefined || result.errorStop !== undefined) {
    const why =
      result.killCause ??
      result.errorStop?.message ??
      result.errorStop?.reason ??
      `exit ${String(result.exitCode)}`;
    throw new ChallengeInfraError(`challenge dispatch failed: ${String(why)}`);
  }
  return result.toolUses ?? [];
}
