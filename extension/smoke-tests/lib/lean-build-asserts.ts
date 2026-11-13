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

/**
 * `SPEC_BODY` with a requirement in prose OUTSIDE the block, above and below it.
 *
 * Every existing build case's body is the bare fence, so prose-free by
 * construction: a renderer that printed nothing still passed them all. A case
 * that has to show the builder READ the issue needs text the spec object does
 * not already carry, and `parsePiSpec` reads the block from anywhere in the body,
 * so the prose can sit on either side of it.
 */
export const SPEC_BODY_WITH_PROSE = `Add retry to the meter's quota check.

${SPEC_BODY}

TAIL-ONLY: the exception message must remain exactly "quota exceeded", and the check runs before the draw.
`;

/**
 * The build step's `fetchIssueBody` dep, counting its own calls.
 *
 * The counter is the canary: the body the spec was parsed from is the body the
 * builder is shown (#2228 threads it, it does not re-fetch it), so a second call
 * means the step re-read the issue and the run pays for a `gh` round-trip twice.
 * It lives here rather than in the fixture because a `gh` read is a READ, which is
 * the seam this module owns.
 */
export function issueBodyReader(specBody: string | undefined, onFetch: () => void) {
  return async (): Promise<string> => {
    onFetch();
    return specBody ?? SPEC_BODY;
  };
}

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
