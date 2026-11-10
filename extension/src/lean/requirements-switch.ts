/**
 * lean/requirements-switch — the one reader of the requirement-coverage switch.
 *
 * `PI_ENSEMBLE_LEAN_REQUIREMENTS=1` turns the specify step's requirement
 * elicitation, its deterministic coverage check, and the builder's requirement
 * section on. Any other value, and unset, is off: the prompts, the pipeline and
 * the verdicts are byte-identical to the release the bench compares against,
 * which is what lets campaign 6 run lean with and without the lever on the same
 * commit.
 *
 * Deliberately a process-env variable and not a `.pi/work.json` field: the
 * bench switches it per run against foreign repositories it does not commit to,
 * and a base-commit config read would need a commit in the target repo per
 * campaign. Read per call, like every other knob in this family, so a host that
 * exports it mid-process is heard — and read through the `env` argument a test
 * passes, so a case cannot change the process environment under a run in flight.
 *
 * Its own file because `config.ts` is the project's `.pi/work.json` reader and
 * this reads nothing from the project.
 */

/** Only the exact `"1"` turns the lever on; everything else (including `"true"`) is off. */
export function requirementsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PI_ENSEMBLE_LEAN_REQUIREMENTS === "1";
}
