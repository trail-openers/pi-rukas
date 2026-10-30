/**
 * lib/lean-publish-asserts — the two helpers publish cases assert with.
 *
 * Split out of `lean-publish-fixture.ts` for the §12 size cap. They are not part
 * of building the tree or running the step: one reads origin, the other is a
 * predicate a case's own assertions use. Neither needs the fixture's context.
 */

import { pathProblem } from "../../src/lean/specify-path.ts";
import type { Step } from "../../src/lean/state.ts";
import { git } from "./lean-verify-fixture.ts";

/** What origin's branch actually points at, or "" when the ref does not exist. */
export function originHead(origin: string, branch: string): string {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return "";
  }
}

/**
 * A path the publish body may print: a normalised git-relative path that
 * `specify-tree`'s own traversal / forbidden-directory rule accepts. The body's
 * own filter is deliberately NARROWER still — it also refuses a space or a
 * semicolon — so this helper is the looser class.
 */
export function printablePath(p: string): boolean {
  const rel = p
    .replace(/\/+/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
  return pathProblem(rel) === undefined && /^[A-Za-z0-9._/-]+$/.test(rel);
}

/**
 * Load an EXTRA criterion id -> test-file map onto the fixture's step log.
 *
 * The default log maps AC1/AC2 to two clean paths; a case that wants the body's
 * path filter exercised adds its own criterion and hands its files in here, so
 * the paths under test are the ones the step actually reads from the record.
 */
export function testsStep(issue: number, tests: Record<string, string[]>): Step {
  return {
    key: `${issue}:challenge:0`,
    state: "challenge",
    startedAt: 5,
    outcome: { kind: "new-tests", tests },
  };
}
