/**
 * lean/verify-types — the two seams the verify step reaches the outside world through, and the
 * error it throws when the machine, not the code, is wrong.
 *
 * Its own module for the same reason `build-errors.ts` exists: `verify-steps.ts` runs the tiers
 * and `verify-frozen.ts` runs the frozen files, and both must be able to refuse without importing
 * the orchestrator that owns them.
 */

import type { VerifyExecFn } from "../work-driver-git.ts";
import type { ExecFn } from "../worktree.ts";

/**
 * The executor this step's git probes need. `ExecFn` carries `stdoutEncoding`, which
 * `VerifyExecFn` does not declare, and `VerifyExecFn` carries `killGroup`, which `ExecFn` does
 * not. The production executor (`execp`) satisfies both, so the step's seam is the intersection.
 */
export type VerifyExec = ExecFn & VerifyExecFn;

/** The project's verify commands and the per-file runner template, as configured. */
export interface VerifyTiers {
  fast?: string;
  full?: string;
  test?: string;
  /** See `WorkConfig["verify"]["freezeCheck"]` — `lean/freeze-check.ts` runs it. */
  freezeCheck?: string;
  /**
   * The runner's machine-readable per-test report command, for the project roster
   * (`lean/verify-roster.ts`). Executed in argv form like `verify.test`, so it carries no shell
   * metacharacter. `{dir}` names the tree the roster runs in and `{report}` the file the gate
   * reads back; with no `verify.roster` the roster derives `--junitxml={report} {dir}` onto the
   * `verify.test` command. Absent is not "no roster": it is "derive one".
   */
  roster?: string;
  /**
   * The directory the project keeps its tests in, and the basename pattern they match — the pair
   * that says WHICH files the roster considers pre-existing. Read at the run's base commit, so a
   * run cannot choose its own judges by editing the pair. `testDirs` is several roots in place of `testDir`.
   */
  testDir?: string;
  testDirs?: string[];
  testGlob?: string;
}

/** A tree, a tier or a runner this step cannot trust. The engine makes it exit 10. */
export class VerifyInfraError extends Error {
  override readonly name = "VerifyInfraError";
}

/**
 * What the project roster reads out of the config: the report command (or the `verify.test`
 * template it is derived from) and the pair that names the pre-existing test files.
 *
 * A subset of `VerifyTiers` rather than the whole, because the roster's module must be able to
 * say what it reads and a module that takes the config object reads all of it by accident.
 */
export type VerifyRosterConfig = Pick<
  VerifyTiers,
  "roster" | "test" | "testDir" | "testDirs" | "testGlob"
>;
