/**
 * lib/lean-build-asserts — the git/forge readers the `lean/build` smoke tests
 * use to check what the step actually left behind.
 *
 * Split from `lib/lean-build-fixture.ts` for the 500-line gate (AGENTS.md §12),
 * along the seam that already exists there: the fixture BUILDS the repo and
 * drives the step; these READ the result. Keeping the readers here also keeps a
 * case's assertions honest — they ask git, never the fixture's own bookkeeping.
 */

import type { WorkConfig } from "../../src/lean/config.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import { RUNNER, git } from "./lean-build-fixture.ts";

/** A config carrying the project's test runner template. */
export function configWithRunner(): WorkConfig {
  return { ...defaultConfig(), verify: { fast: "true", test: RUNNER } };
}

const SPEC = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [
    { id: "AC1", text: "retries a transient failure twice before failing", verify: "test" },
    { id: "AC2", text: "documents the retry budget", verify: "manual" },
  ],
  scope: { paths: ["src/retry.ts"], out: ["docs/"] },
};

const FENCE = "```";

/** A body carrying the spec `build` re-reads from the forge. */
export const SPEC_BODY = `${FENCE}pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n${FENCE}`;

/** `git status --porcelain -uall` for a worktree, "" when clean. */
export function status(wt: string): string {
  return git(wt, "status", "--porcelain", "-uall");
}

/** The paths one commit changes, in git's order. */
export function commitPaths(wt: string, ref = "HEAD"): string[] {
  const out = git(wt, "show", "--name-only", "--format=", ref);
  return out === "" ? [] : out.split("\n");
}

/** The subject line of HEAD. */
export function subject(wt: string): string {
  return git(wt, "log", "--format=%s", "-1");
}

/** Every commit subject above `ref`. */
export function subjectsAbove(wt: string, ref: string): string[] {
  return git(wt, "log", "--format=%s", `${ref}..HEAD`)
    .split("\n")
    .filter((s) => s !== "");
}
