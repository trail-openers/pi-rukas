/**
 * The shared constants of the #2667 review panel.
 *
 * A leaf: the panel driver and its two helper modules all read these, so no helper has to
 * import the driver to state a fact the driver already states. One value per concept, so a ref,
 * a state key and a record all name the same branch and the same issue.
 */

import { execp } from "../../src/exec.ts";
import { netGitEnv } from "../../src/work-driver-net-git.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { Budget } from "../../src/lean/config.ts";
import { stepGitEnv } from "./lean-review-fixtures.ts";

/** The executor every git read and push of the rig runs on: the real one, isolated view. */
export const exec = ((cmd, opts) =>
  execp(cmd, { ...(opts ?? {}), env: { ...stepGitEnv(), ...netGitEnv() } })) as typeof execp;

/** The issue every row drives, so a ref, a key and a record all name one value. */
export const ISSUE = 2667;
/** The run's branch; `specifyBranch` prints a non-empty branch verbatim. */
export const BRANCH = `lean/issue-${String(ISSUE)}`;
/** One minute, the unit the step clock's levers are stated in. */
export const MIN = 60_000;
/** The frozen test the walk records, so the handback has a `Frozen acceptance tests:` block. */
export const FROZEN_REL = "tests/AC1.test.ts";
/** The PR address every row scripts for its `publish` step. */
export const PR_URL = "https://forge.invalid/o/r/pull/2667";
/** The clock every row runs at: a step clock frozen at zero spends nothing. */
export const NOW = 1_700_000_000_000;

/** A `budgets.review` with only the lever the row needs armed. */
export function cfgWith(budget: Partial<Budget>) {
  const cfg = defaultConfig();
  cfg.budgets.review = { turns: 400, tokens: 60_000_000, minutes: 30, ...budget };
  return cfg;
}
