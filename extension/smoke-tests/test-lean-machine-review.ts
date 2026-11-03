#!/usr/bin/env bun
/**
 * lean/machine — the `review` step's two kinds, on their own.
 *
 * Split from `test-lean-machine.ts` for the 500-line gate (AGENTS.md §12), and
 * worth the split on its own merits: `review` is the only state with two passing
 * kinds whose difference is a fact about ORIGIN rather than about the run, so the
 * claims here are pair-claims that read badly inside the single-transition
 * neighbourhood of the main table test.
 *
 * A review that ran a fix round has PUSHED: `review-git.ts`'s `integrate` moves
 * origin onto the fixer's commits. The newest `verify` then describes a commit
 * that is no longer the head, and `ci` refuses exactly that (its `verifiedHead`
 * read and `assertDiskAtVerifiedHead`), so routing that run to `ci` ends it in a
 * throw and its fix commits are never verified. The step says which of the two
 * happened with its KIND — `fixed` re-verifies, `done` ships — and the fact comes
 * from the durable log (`fixedFromLog` in `review-log.ts`), not a counter: the
 * log is what a resumed attempt can read, and a counter in the snapshot would be
 * a second copy of a fact the step log already records.
 *
 * Every assertion here is a PAIR or a counter check, because a single positive
 * assertion is what lets a table that always went one way look green.
 */

import { next, outcomeKindsFor } from "../src/lean/machine.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState } from "../src/lean/state.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function run(state: LeanState, over: Partial<LeanRun> = {}): LeanRun {
  return {
    schema: 1,
    issue: 1,
    version: "test",
    models: {},
    baseSha: "sha",
    branch: "b",
    state,
    counters: { ...INITIAL_COUNTERS },
    steps: [],
    ...over,
  };
}

// The two edges out of the step, as the pair they are: a table that always went
// to `verify` would pass a single positive assertion — and the `done` arm is the
// one every clean run takes, so it is the arm a regression here silently parks.
{
  const moved = next(run("review"), { kind: "fixed" });
  const still = next(run("review"), { kind: "done" });
  assert(
    moved.state === "verify",
    `review fixed → verify, so the pushed fix commits are certified before CI (got ${moved.state})`,
  );
  assert(
    still.state === "ci",
    `review done still → ci, the edge that ships every clean run (got ${still.state})`,
  );
  // A green verify on that re-verification publishes, and the SECOND publish
  // must go to `ci` and not back for another six-lens pass: the run would
  // otherwise loop review forever. `reviewDone` is set on BOTH arms out of
  // review, so the pair is what proves it — an edit that set it only on the
  // unmoved arm would route this publish back to `review`.
  const publishedAgain = next(
    run("publish", { counters: { ...INITIAL_COUNTERS, reviewDone: true } }),
    { kind: "ok" },
  );
  assert(
    publishedAgain.state === "ci",
    `and the run that re-verified goes publish → ci, not back through review again (got ${publishedAgain.state})`,
  );
  assert(
    moved.counters.reviewDone === true && still.counters.reviewDone === true,
    "both review arms spend the review round, so neither can re-rehearse the six lenses",
  );
  // `fixed` must be a PLAIN move: a re-verification is not a build round, and a
  // run that spent its build attempts before the review would otherwise find this
  // green verify routed to a draft (or a handback) instead of to publish.
  assert(
    moved.counters.buildAttempts === 0,
    `review fixed spends NO build attempt (got ${String(moved.counters.buildAttempts)})`,
  );
}

// The step's two kinds are the ONLY way out of it. What a handler returns is
// both gates clearing, with or without a fix round; everything else — a gate that
// could not run, findings still open at the bound, a fix round that broke the
// frozen contract, a child the budget stopped — is a throw the engine turns into a
// handback. A third kind would be a route for an unreviewed head to reach `ci`, so
// the table having exactly these two is the thing asserted.
assert(
  JSON.stringify(outcomeKindsFor("review")) === JSON.stringify(["done", "fixed"]),
  `review has exactly the two kinds a pass can carry, "done" and "fixed" (got ${JSON.stringify(outcomeKindsFor("review"))})`,
);

process.exit(exit);
