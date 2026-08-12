#!/usr/bin/env bun
/**
 * The PR the driver merges must be the PR the driver opened.
 *
 * On the LLM-ops fallback path the PR number comes from `parsePrNumber` reading
 * the ops child's reply text (`work-driver-commit.ts:274`), and that number is
 * what `gh pr merge` eventually acts on — the one irreversible act in the
 * cycle. The verification was:
 *
 *     await execFn(`gh pr view ${prToCheck} --json state`)   // result DISCARDED
 *
 * It asked `--json state` and then threw the answer away, checking only that
 * the command did not fail. So the gate proved one thing: *a* PR with that
 * number exists somewhere in the repo. It did not check that the PR is open, or
 * that it has anything to do with this cycle.
 *
 * A hallucinated number that happens to be a real PR passes. A stale number
 * from a previous cycle passes. A CLOSED or already-MERGED PR passes. In a busy
 * repo the numbers around a real PR are all live PRs, so a plausible mistake is
 * a valid one.
 *
 * The branch is the trustworthy identifier: it is computed by the driver
 * (`branchSlug`), not supplied by a model, and `gh pr create --head` opens the
 * PR against exactly it. `verifyStepOutcome` already resolves by
 * `gh pr list --head` — but only as a repair when the marker is MISSING. When
 * the marker is present it was believed. This binds the two together.
 */

import { judgePrIdentity } from "../src/work-driver-verify.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BRANCH = "feature/issue-664-agenda-generator";

// ---------------------------------------------------------------- accepted

{
  const ok = judgePrIdentity(BRANCH, { state: "OPEN", headRefName: BRANCH });
  assert(ok.ok, "the cycle's own open PR is accepted");
  assert(ok.failure === undefined, "...with nothing to report");
}

// ---------------------------------------------------------------- refused

{
  const wrongBranch = judgePrIdentity(BRANCH, {
    state: "OPEN",
    headRefName: "feature/issue-999-something-else",
  });
  assert(
    !wrongBranch.ok,
    "canary: a PR whose head is a DIFFERENT branch is refused — it merely existed before, and existing was the whole test",
  );
  assert(
    (wrongBranch.failure ?? "").includes("feature/issue-999-something-else"),
    "...and the failure names the branch it actually points at",
  );
  assert(
    (wrongBranch.failure ?? "").includes(BRANCH),
    "...alongside the branch it should have pointed at",
  );
}

{
  for (const state of ["CLOSED", "MERGED"]) {
    const stale = judgePrIdentity(BRANCH, { state, headRefName: BRANCH });
    assert(
      !stale.ok,
      `canary: a ${state} PR is refused even on the right branch — merging it is a no-op the cycle would report as success`,
    );
    assert((stale.failure ?? "").includes(state), `...and the failure names the ${state} state`);
  }
}

// ------------------------------------------- unreadable is refused, not passed

{
  // This is a merge gate, and merging is irreversible, so it fails CLOSED —
  // unlike the review threshold, where absent doctrine is the normal case.
  assert(
    !judgePrIdentity(BRANCH, undefined).ok,
    "canary: an unreadable `gh pr view` refuses — the gate guards an irreversible act",
  );
  assert(!judgePrIdentity(BRANCH, {}).ok, "a reply missing both fields refuses");
  assert(
    !judgePrIdentity(BRANCH, { state: "OPEN" }).ok,
    "a reply with no headRefName refuses — that is the field that binds it to this cycle",
  );
}

{
  // And with no branch recorded there is nothing to bind to, so it cannot
  // silently pass either.
  assert(
    !judgePrIdentity(undefined, { state: "OPEN", headRefName: BRANCH }).ok,
    "with no branch on the cycle the identity cannot be established, so it refuses",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
