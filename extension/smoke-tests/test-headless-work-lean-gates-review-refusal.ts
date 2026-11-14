#!/usr/bin/env bun
/**
 * The `review` arm's refusals: the two places the projection refuses to publish a
 * partial truth, and the all-or-nothing rule both of them obey.
 *
 * `test-headless-work-lean-gates.ts` pins what the review entry PUBLISHES — one tally per
 * round keyed by the four severities, each wave's full head, the step's own clock. These
 * ask the opposite question: what a malformed record does to that entry, and why one bad
 * value takes the whole field rather than the entry that carried it.
 *
 * The rule is the same on both halves and it is a decision, not an oversight:
 *
 *   - **one malformed wave head refuses every wave.** An entry naming a head the host
 *     cannot check out is a wrong answer wearing a right one's clothes, and a host that
 *     read `waves: []` beside a full `rounds` could at least ask which.
 *   - **one malformed round nulls every round,** including the well-formed ones beside it.
 *     A tally that named two of a run's three rounds is not a shorter truth: a host that
 *     sums `rounds` divides the run's findings by the rounds it was shown and concludes the
 *     missing round found nothing — and the missing round is the one it would otherwise go
 *     and re-judge. Dropping the bad round instead would be the field answering one question
 *     two ways, which is what the waves arm already refuses to do.
 *
 * Both arms are asserted at the seam the refusal lives at (`leanGates`, the projection).
 * A malformed record cannot survive the loader — `reviewRecordProblem` refuses it on the
 * way in, and `test-lean-state-outcome-gates.ts` pins that half — so a log built through
 * the engine's own write path never reaches the projection carrying these bytes at all.
 * What only this seam can prove is what a projection prints for a log that arrived
 * unjudged, which is the case the filter exists for.
 *
 * Split from `test-headless-work-lean-gates.ts` for the §12 size cap, along the seam the
 * two questions draw: that file reads a sound record, this one reads a broken one.
 */

import { leanGates } from "../src/headless/work-lean-gates.ts";
import type { Outcome } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { driveLean } from "./lib/lean-result-fixture.ts";
import {
  ROUND_1,
  ROUND_2,
  WAVES,
  gatesLog,
  gatesOf,
} from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

/** The review step of one log, its `review` record replaced by `record`. */
function logWithReview(record: unknown) {
  return gatesLog({ review: "fixed" }).map((s) =>
    s.state === "review"
      ? {
          ...s,
          outcome: { ...(s.outcome as object), review: record } as Outcome,
        }
      : s,
  );
}

/** The projection's own answer for one record, with the redaction seam left open: these
 * cases are about the refusals, and an empty seam is the code path a missing call is
 * equivalent to — so any value that survives it is one the record really carried. */
function reviewOf(record: unknown) {
  return leanGates(logWithReview(record) as never, (x) => x).review;
}

// ─── (1) the waves arm: one unsound head, and no wave is published ─────────────
{
  const waves = [{ wave: "fix", head: "nope" }];
  // Through the document, because a refusal that only the helper makes is not a contract.
  const badHead = await driveLean(
    "handed-back",
    10,
    logWithReview({
      rounds: [ROUND_1, ROUND_2].map((r) => ({ ...r })),
      waves,
    }),
  );
  assert(
    gatesOf(badHead.issue).review === null,
    `review: a wave head that is not a full oid is refused at the projection, not printed (${JSON.stringify(gatesOf(badHead.issue).review?.waves)})`,
  );
  // The sound half of the same record still publishes, so the refusal above is the waves
  // rule and not the whole entry refusing for an unrelated reason.
  const soundWaves = reviewOf({
    rounds: [ROUND_1, ROUND_2].map((r) => ({ ...r })),
    waves: WAVES.map((w) => ({ wave: w.wave, head: w.head })),
  });
  assert(
    JSON.stringify(soundWaves?.waves) === JSON.stringify(WAVES),
    `review: a record whose heads are all sound publishes every wave (${JSON.stringify(soundWaves?.waves)})`,
  );
  // A wave whose PASS is not one of the two published names is refused for the same
  // reason as a bad head: half an identity is not an identity.
  assert(
    reviewOf({
      rounds: [ROUND_1],
      waves: [{ wave: "re-review", head: "c".repeat(40) }],
    }) === null,
    "review: a wave naming a pass the vocabulary does not have refuses the whole entry too",
  );
}

// ─── (2) the rounds arm: one malformed tally, and no round is published ─────────
{
  const bad = reviewOf({
    rounds: [{ ...ROUND_1 }, { ...ROUND_2, HIGH: -1 }, { ...ROUND_1 }],
    waves: WAVES.map((w) => ({ wave: w.wave, head: w.head })),
  });
  assert(
    bad?.rounds === null,
    `review: one malformed round nulls the whole tally — the two well-formed rounds beside it are NOT published as a complete count (${JSON.stringify(bad?.rounds)})`,
  );
  // …and the null is the rounds rule on its own, not the whole object refusing: the same
  // log's sound waves still publish, so the two arms fail independently of each other.
  assert(
    JSON.stringify(bad?.waves) === JSON.stringify(WAVES),
    `review: the waves arm still published, so the null above is the rounds rule and not the entry refusing (${JSON.stringify(bad?.waves)})`,
  );
  // Each remaining way a round can be wrong takes the tally the same way, and none of
  // them may degrade to "publish the rounds that happened to be sound".
  for (const [name, round] of [
    ["a count that is not an integer", { ...ROUND_1, MEDIUM: 1.5 }],
    ["a missing severity", { CRITICAL: 1, HIGH: 2, MEDIUM: 3 }],
    ["a fifth severity beside the four", { ...ROUND_1, BLOCKER: 2 }],
    ["a null entry", null],
  ] as const) {
    const refused = reviewOf({
      rounds: [{ ...ROUND_1 }, round, { ...ROUND_2 }],
      waves: WAVES.map((w) => ({ wave: w.wave, head: w.head })),
    });
    assert(
      refused?.rounds === null,
      `review: ${name} nulls the tally with its neighbours, rather than publishing the two sound rounds as the run's whole account (${JSON.stringify(refused?.rounds)})`,
    );
  }
  // The arm the null rule reserves for "the record answered nothing": a step that judged
  // no round at all is a null tally, and one that judged a sound round publishes it. The
  // two must not be reachable by the same code path, or a refusal would be indistinguishable
  // from a run that had nothing to report.
  const empty = reviewOf({ rounds: [], waves: [] });
  assert(
    empty?.rounds === null && empty?.waves === null,
    `review: a step that recorded nothing is null/null, the record's own absence and not a refusal (${JSON.stringify([empty?.rounds, empty?.waves])})`,
  );
  const sound = reviewOf({
    rounds: [{ ...ROUND_1 }],
    waves: WAVES.map((w) => ({ wave: w.wave, head: w.head })),
  });
  assert(
    JSON.stringify(sound?.rounds) === JSON.stringify([ROUND_1]),
    `review: a sound record publishes its rounds verbatim, so the nulls above are refusals and not a filter that keeps nothing (${JSON.stringify(sound?.rounds)})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
