/**
 * lean/ready-setup — can this REPOSITORY run lean at all? Asked first at `ready`.
 *
 * A setup fault is the repository's, never the ticket's, so it is judged before the issue body is
 * read and before any model call, and its verdict is the `setup` kind: the machine ends the run
 * `handed-back` (exit 10) without a reporting step, so nothing is posted on an issue that is not at
 * fault. A host keys its fallback to another driver on that one kind (`failure.kind: "setup"`), which
 * is why every cause here is one a person fixes in the repository and no issue cause is.
 *
 * The causes: `.pi/work.json` cannot be read or parsed at the base (`LeanConfigError`); it is absent
 * or sets no `verify.test`, the per-file runner every acceptance test is proved red through; or the
 * roster cannot get a report from it (`rosterStartProblem`). Any other throw from the read is not a
 * setup answer and propagates: the engine hands back on it as the crash it is.
 */

import { LeanConfigError, type WorkConfig } from "./config.ts";
import { oneLine } from "./text-fence.ts";
import { rosterStartProblem } from "./verify-roster-command.ts";

/** The rule for a base whose config names no per-file runner, absent file included. */
export const NO_TEST_RUNNER_RULE =
  "verify.test is unset at the run's base (no .pi/work.json, or one without verify.test): lean proves every acceptance test red through the project's per-file runner";

/** The run's config at its base, or the rule naming why the repository cannot run lean. */
export async function readySetup(
  load: () => Promise<WorkConfig>,
): Promise<{ config: WorkConfig } | { rule: string }> {
  let config: WorkConfig;
  try {
    config = await load();
  } catch (err) {
    if (!(err instanceof LeanConfigError)) throw err;
    return { rule: `.pi/work.json at the run's base is unusable: ${oneLine(err.message, 200)}` };
  }
  if (config.verify.test === undefined) return { rule: NO_TEST_RUNNER_RULE };
  const roster = rosterStartProblem(config.verify);
  return roster === undefined ? { config } : { rule: roster };
}
