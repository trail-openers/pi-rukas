#!/usr/bin/env bun
/**
 * #1537 — the round-cap merge rule's SECOND arm (nothing blocking on the row),
 * split out of test-merge-guard-round-cap.ts (the 500-line gate) so that file
 * keeps covering the other conditions.
 *
 * A row below the round cap still merges when it shows no finding at or above
 * the blocking bar: the disclosure on the PR is then the whole answer and no
 * fix wave is owed. This arm is a FAIL-CLOSED rule, so the cases below are
 * mostly about shapes the rule must refuse — and the bar it scores at comes off
 * the ROW (`blockingBar`, written by `lens-review-finish.ts`), never off
 * `PI_ENSEMBLE_REVIEW_THRESHOLD` read at merge time. The bar is a property of
 * the review that produced the row; a bar the operator moved afterwards must
 * not re-score counts the lenses never scored that way.
 *
 * The env is therefore pinned to a bar DIFFERENT from the ones these rows
 * carry: a regression that went back to reading it is caught here rather than
 * hidden by the env happening to agree.
 */

import {
  assert,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
  TARGET,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";

await setupLedgerPath();

const ADV: LedgerEntry = {
  branch: "feature/x",
  kind: "adversarial",
  patchId: "p1",
  passed: true,
  at: 1,
};
const PR_HEAD = "a".repeat(40);
const TARGET_OVERRIDE = { ...TARGET, headOid: PR_HEAD };
const MARKER_BRANCH = "feature/x";
const MARKER_PATCH = "p1";
const commentsWith = (branch: string, patch: string) =>
  JSON.stringify({
    comments: [
      { body: `residual findings\n<!-- pi-rukas:lens-residuals branch=${branch} patch=${patch} -->` },
    ],
  });

const hook = (cmd: string, entries: LedgerEntry[]) =>
  hookDecision(cmd, entries, {
    fetchedHead: PR_HEAD,
    target: TARGET_OVERRIDE,
    ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
  });

/** A round-1 row the second arm is asked about: not passed, ISSUES_FOUND, no
 * CRITICAL, the current head, and the disclosure marker on the PR. The caller
 * supplies only what the arm reads. */
const roundOne = (over: Partial<LedgerEntry>): LedgerEntry => ({
  branch: "feature/x",
  kind: "lens",
  patchId: "p1",
  passed: false,
  at: 2,
  detail: "ISSUES_FOUND",
  hasCritical: false,
  round: 1,
  headSha: PR_HEAD,
  ...over,
});

// The env says CRITICAL; every row below says something else. Where the two
// disagree and the row is refused, the refusal is proof of where the bar came from.
const PREV_ENV = process.env.PI_ENSEMBLE_REVIEW_THRESHOLD;
process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = "CRITICAL";

// A round-1 row whose counts show nothing at or above the bar needs no fix wave
// and no re-review.
{
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0 }, blockingBar: "MEDIUM" })],
  );
  assert(
    r.block === false,
    "round-cap #1537: round 1 with nothing blocking on the row → allowed without a second round",
  );
}
// A MEDIUM counted open at the row's bar is refused even though the env's bar
// would let it through.
{
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 1 }, blockingBar: "MEDIUM" })],
  );
  assert(r.block === true, "round-cap #1537: round 1 with a MEDIUM counted open → refused");
  assert(/round 1/.test(r.reason ?? ""), "…naming the round condition");
}
// Fails closed on a PARTIAL count set: a row that never recorded MEDIUM cannot
// prove nothing at the bar is open, so an absent rank is NOT read as 0.
{
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: { CRITICAL: 0, HIGH: 0 }, blockingBar: "MEDIUM" })],
  );
  assert(
    r.block === true,
    "round-cap #1537: counts missing a rank at or above the bar → refused (an absent key is not 0)",
  );
  assert(/round 1/.test(r.reason ?? ""), "…naming the round condition");
}
// A rank BELOW the bar need not be recorded — that is not a partial read.
{
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: { CRITICAL: 0, HIGH: 0 }, blockingBar: "HIGH" })],
  );
  assert(
    r.block === false,
    "round-cap #1537: a HIGH bar row may omit the sub-bar MEDIUM rank → allowed",
  );
}
// A count that is not an integer ≥ 0 is unreadable, not zero.
for (const [label, counts] of [
  ["a non-numeric count", { CRITICAL: 0, HIGH: 0, MEDIUM: "1" }],
  ["a float count", { CRITICAL: 0, HIGH: 0, MEDIUM: 1.5 }],
  ["a negative count", { CRITICAL: 0, HIGH: 0, MEDIUM: -1 }],
] as Array<[string, Partial<Record<"CRITICAL" | "HIGH" | "MEDIUM", number>>]> as Array<
  [string, Partial<Record<"CRITICAL" | "HIGH" | "MEDIUM", number>>]
>) {
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: counts, blockingBar: "MEDIUM" })],
  );
  assert(r.block === true, `round-cap #1537: ${label} → refused (never coerced into a zero)`);
  assert(/round 1/.test(r.reason ?? ""), `…naming the round condition for ${label}`);
}
// Counts with no bar recorded cannot be scored: the rule invents no bar.
{
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0 } })],
  );
  assert(
    r.block === true,
    "round-cap #1537: counts with no blockingBar on the row → refused (fails closed)",
  );
  assert(/round 1/.test(r.reason ?? ""), "…naming the round condition");
}
// A stored bar is untrusted JSON: only a name from the canonical severity list
// is a bar, and LOW is never a blocking bar, so each of these fails closed.
for (const bar of ["low", "MEDIUM".toLowerCase(), "BLOCKER", "CRITICAL LOW", 3, null, true]) {
  const r = await hook(
    "gh pr merge 12",
    [
      ADV,
      roundOne({
        blockingCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0 },
        blockingBar: bar as LedgerEntry["blockingBar"],
      }),
    ],
  );
  assert(
    r.block === true,
    `round-cap #1537: a malformed blockingBar ${JSON.stringify(bar)} → refused`,
  );
}

// #2040 — the capped row reaches this reader. `nothingBlocking` reads
// `blockingCounts`, which `lens-review-finish.ts` derives from `bySeverity`, so
// the cap has to run BEFORE the counts are computed for a round whose only HIGH
// was unproven to be mergeable on this arm. The pair below is the difference:
// the same round scored at the bar it answered to, once with the HIGH still
// counted and once with the harness's cap applied. The refusal is the witness —
// delete the cap from the merge exit and the second case is the one that stops
// being reachable, not the one that reddens.
{
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0 }, blockingBar: "HIGH" })],
  );
  assert(
    r.block === true,
    "#2040: a round still counting its HIGH at the HIGH bar → refused (the cap did not run)",
  );
}
{
  const r = await hook(
    "gh pr merge 12",
    [ADV, roundOne({ blockingCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 1 }, blockingBar: "HIGH" })],
  );
  assert(
    r.block === false,
    "#2040: the same round once the unproven HIGH is counted at MEDIUM → nothing blocks, allowed",
  );
}

if (PREV_ENV === undefined) delete process.env.PI_ENSEMBLE_REVIEW_THRESHOLD;
else process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = PREV_ENV;

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
