#!/usr/bin/env bun
/**
 * The vacuous-`every` guard in `runLensFanOut`'s liveness test.
 *
 * `allLanesProducedEvidence` was `results.every(...)` over the HEALTHY lanes
 * only. `[].every(...)` is TRUE, so a roster with ZERO healthy lanes answered
 * the liveness question YES by nobody, and a single merged `extraFindings` row
 * then satisfied `hasFindingClaimedFile`: a round that reviewed nothing earned
 * the positive coverage claim. `computeVerdict` still returned REVIEW_INCOMPLETE
 * for the blocked rows, so the ✓ printed on the same report as the refusal —
 * and a later reader who reads the ✓ alone acts on it. The guard is
 * `results.length > 0 &&` in `lens-review-fanout.ts`.
 *
 * Split out of `test-lens-coverage-denominator.ts` by the 500-line gate. That
 * file pins the pure accounting; this one pins the one rule the accounting could
 * get wrong by asking nobody.
 *
 * Two shapes look like a zero-healthy-lane round and are not, so both are
 * avoided here (see `lib/lens-vacuous-every-fixture.ts`): an installed skills
 * dir with no `code-review-*` dir at all diverts to the empty-roster install
 * exit BEFORE the fan-out, and a `lensChildFn` stub that RETURNS blocked rows
 * fills the roster's blocked list, not `results`.
 *
 * MUTATION-PROOF: revert the guard to the bare `results.every(...)` and the
 * "earns NO positive coverage claim" assertion reddens (verified: 1 red, and
 * byte-identical on restore). Each `premise:` assertion is the other half — it
 * reddens if the round stops being a zero-healthy-lane round over a real
 * denominator, which is what would make the canary assert nothing.
 */

import { runLensFanOut } from "../src/lens-review-fanout.ts";
import { renderSummary } from "../src/lens-review-render.ts";
import { runLensReview } from "../src/lens-review.ts";
import {
  CHANGED_A,
  CHANGED_B,
  THREE_FILE_DIFF,
  finding,
  lens,
  mkClone,
  teardown,
} from "./lib/lens-coverage-fixture.ts";
import { blockedRosterEntry, passthroughModelSlot } from "./lib/lens-vacuous-every-fixture.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The fan-out itself — the seam that OWNS the liveness test.
{
  const blockedRoster = [blockedRosterEntry()];
  const blockedOut = await runLensFanOut({
    healthy: [],
    blocked: blockedRoster,
    // Never reached — there is no healthy entry — but a stub that returns
    // evidence keeps the arm honest: were a lane ever to run, the liveness test
    // would pass for a real reason and this arm would be testing nothing.
    lensChildFn: (async () => lens("SECURITY", [], "reviewed everything")) as never,
    runId: "vacuous-every",
    skillsDir: "unused",
    context: "",
    roster: blockedRoster,
    opts: { diff: "" } as never,
    bumpBatch: () => {},
    batchKey: "vacuous-every/batch",
    modelSlot: passthroughModelSlot as never,
    // A COMPUTED two-file diff: with no denominator the claim is refused for
    // condition (1) and the arm never reaches the liveness test at all.
    resolved: { kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF },
    // The round's ONLY evidence: one deterministic CLAIM_SCAN-shaped row citing
    // a file inside the denominator.
    extraFindings: [finding("src/a.ts")],
  });
  assert(
    blockedOut.hasDenominator && blockedOut.lensResults.every((r) => r.blocked === true),
    "premise: a real denominator and zero healthy lanes — the vacuous case, not an empty round",
  );
  assert(
    blockedOut.findingClaimedFile === false,
    "canary: a blocked-only round earns NO positive coverage claim — an empty healthy set is not liveness",
  );
}

// The same round one level up, through the real review entry point, so the stamp
// the RENDERER reads is the one under test and not only the fan-out's.
{
  const c = mkClone({ skills: "unusable" });
  try {
    let write: Promise<unknown> = Promise.resolve();
    const summary = await runLensReview({
      cwd: c.repo,
      branch: "feat/x",
      head: c.head,
      base: c.base,
      full: true,
      // All six installed skills fail to parse, so the roster is six NAMED
      // blocked lanes and `runLensFanOut`'s `results` is `[]`.
      lensChildFn: (async (args: { lens: { name: string } }) =>
        lens(args.lens.name, [], "reviewed everything, nothing to report")) as never,
      // The round's only evidence, exactly as the caller merges CLAIM_SCAN rows.
      extraFindings: [finding(CHANGED_A)],
      onLedgerWrite: (w: Promise<unknown>) => {
        write = w;
      },
    });
    await write;
    assert(
      summary.unaccountedFiles?.join(",") === CHANGED_B,
      `premise: a real two-file denominator with only the merged finding as evidence (got ${JSON.stringify(summary.unaccountedFiles)})`,
    );
    assert(
      summary.verdict === "REVIEW_INCOMPLETE" &&
        summary.lenses.length > 0 &&
        summary.lenses.every((r) => r.blocked === true),
      "premise: every lane blocked, and the round is refused at the verdict level",
    );
    assert(
      !renderSummary(summary, 3).includes("✓ COVERAGE"),
      "canary: the ✓ COVERAGE line does not print on a blocked-only round's report",
    );
  } finally {
    teardown(c);
  }
}

process.exit(exit);
