#!/usr/bin/env bun
/**
 * lean/review — the adversarial fix arm is BOUNDED (the CRITICAL #1930 shipped with).
 *
 * Split from `test-lean-review-wiring.ts` along the seam that file's own cases
 * describe: everything there drives the step to a VERDICT (both gates clean, a gate
 * with no verdict, a fix round landing), while this file drives it to a BOUND. The
 * size ratchet refused 550 lines in one file, and the seam is real rather than
 * convenient — a bound case fails for a reason a verdict case cannot produce.
 *
 * `(e3)`/`(f)` in the wiring suite drive the LENS arm to the bound. This is the
 * mirror case for the adversarial arm, and the test whose absence let the defect
 * ship.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import type { DispatchSpec } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  MAX_REVIEW_ROUNDS,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  makeRepo,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { ReviewInfraError } from "../src/lean/review.ts";

const { assert, failures } = makeAssert();

// ── (e4) THE ADVERSARIAL ARM IS BOUNDED TOO — the CRITICAL this handler shipped
// with.
//
// `(e3)`/`(f)` above drive the LENS arm to the bound, and the round guard sat with
// them, inside the lens arm. The adversarial arm's findings branch called `fixRound`
// and `continue`d without ever passing that guard, so a gate that keeps returning
// findings looped forever and every pass bought a reviewer AND a fixer. Measured on
// this same loop: **550 fix rounds in 90 seconds**, every one a paid child — the
// exact shape that made the frozen driver unmergeable, and the reason this case
// exists rather than a comment asserting the bound covers both arms.
//
// The stub is the adversarial arm's worst honest case: `loopOutcome: "rejected"`
// with findings that VARY per round. Varying them is deliberate — this arm has two
// stop conditions, `stagnantAgainstFix` (same gate, same text, a head that moved)
// and the round bound, and a stub with one fixed string trips the earlier one, so
// the case would measure the tie-breaker and never reach the bound. Varying the text
// says the gate is genuinely re-looking at a new head and only the bound can stop
// it, which is the defect's shape.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
  let advAsks = 0;
  let fixers = 0;
  let lensRounds = 0;
  // ONE `fixerThatCommits` instance for the whole case, counted on the way through
  // rather than re-created per call: its per-tree commit counter has to keep
  // advancing or two rounds write byte-identical trees.
  const alwaysCommit = fixerThatCommits("always-findings");
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () =>
        result({
          loopOutcome: "rejected",
          text: `1. unbounded read (round ${String(++advAsks)})`,
        }),
      // Never consulted on this arm — the findings branch `continue`s before the
      // lens gate runs. Counted so the case can say the loop never even reached the
      // arm that used to hold the only guard.
      lens: async () => {
        lensRounds++;
        return cleanLensRound();
      },
      dispatch: async (spec: DispatchSpec) => {
        fixers++;
        return alwaysCommit(spec);
      },
    }),
  );
  // The bound fires rather than the step reporting the head reviewed. `done` here
  // would be the worst answer available: an unreviewed head carried on to `ci`.
  assert(
    outcome === undefined,
    `(e4) an adversarial gate that never clears is never reported as reviewed (got kind ${String(outcome?.kind)})`,
  );
  assert(
    threw instanceof ReviewInfraError &&
      /reached round 4 at the step's bound of 3 rounds/.test(threw.message),
    `(e4) the ADVERSARIAL arm stops at the stated bound rather than looping — the guard is at the top of the loop body, so it covers this arm too (${threw?.message})`,
  );
  // THE MEASURED NUMBER, and the one this case exists to hold. Before the hoist the
  // same shape was unbounded (the lens arm of this loop measured 550 fix rounds in
  // 90 seconds); a regression that puts the guard back inside the lens arm takes
  // this back to hundreds, which is why it is an exact equality and not a `<=`.
  assert(
    fixers === MAX_REVIEW_ROUNDS,
    `(e4) exactly ${String(MAX_REVIEW_ROUNDS)} fix rounds were bought by the always-findings stub — the unbounded arm bought hundreds (measured 550 in 90s) and every one of them was a paid child (got ${String(fixers)})`,
  );
  assert(
    advAsks === MAX_REVIEW_ROUNDS,
    `(e4) and the same for the reviewer — ${String(MAX_REVIEW_ROUNDS)} passes, no bound-breaking extra (${String(advAsks)})`,
  );
  assert(
    lensRounds === 0,
    `(e4) and the loop never reached the lens arm at all, which is where the guard used to live and why this arm had none (${String(lensRounds)} lens rounds ran)`,
  );
  // The findings that stopped it reach the operator, so the handback says what was
  // outstanding rather than only that the loop gave up.
  assert(
    (threw as ReviewInfraError | undefined)?.message.includes("unbounded read") === true,
    `(e4) and the refusal names the findings still open, since a bound with nothing to show for it cannot be triaged (${(threw as ReviewInfraError | undefined)?.message.slice(0, 200)})`,
  );
  // The cost of those rounds is on the record even though the step threw, clipped to
  // the loader's cap — a run that bought three fixers and reported none is the
  // under-billing this suite exists to prevent.
  assert(
    (threw as ReviewInfraError | undefined)?.dispatches.some((r) => r.role === FIXER_ROLE) ===
      true,
    "(e4) and the fixers this arm bought are billed on the refusal",
  );
}

cleanupRoots();
process.exit(failures());
