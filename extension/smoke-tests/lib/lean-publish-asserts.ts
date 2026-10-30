/**
 * lib/lean-publish-asserts — the one helper publish cases assert with.
 *
 * Split out of `lean-publish-fixture.ts` for the §12 size cap. It is not part
 * of building the tree or running the step: it reads origin, which the fixture
 * has no reason to know about.
 */

import { git } from "./lean-verify-fixture.ts";

/** What origin's branch actually points at, or "" when the ref does not exist. */
export function originHead(origin: string, branch: string): string {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return "";
  }
}
