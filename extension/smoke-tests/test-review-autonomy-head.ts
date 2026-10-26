/**
 * #1533 — the merge autonomy question the head pin answers, kept apart from the
 * #1144 scenarios in test-review-autonomy.ts (which share a findings-store
 * fixture and a per-branch round counter; this case needs neither).
 *
 * A review that said yes said yes to a COMMIT. The two calls below differ in
 * exactly one variable — the patch identity the head carries at merge time — so
 * a refusal that disappears when the head is put back can only have been the
 * drift. That is what makes the assertion non-vacuous: a scenario that only
 * ever tested the drifted head would pass against a guard that blocks everything.
 */

import type { LedgerEntry } from "../src/review-ledger.ts";
import {
  hookDecision,
  setupLedgerPath,
  teardownLedger,
  TARGET,
} from "./merge-guard-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string, extra?: string): void {
  if (!cond) {
    console.log(`✗ ${msg}${extra ? ` (${extra})` : ""}`);
    exit = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

/** The patch identity recorded as REVIEWED, distinct from any the fixtures write
 * by default, so "the head carries something else" is an explicit choice. */
const REVIEWED_PATCH_ID = "d".repeat(40);
/** The head OID both calls use: the PR's head is NOT the variable here. */
const HEAD = "b".repeat(40);

const reviewedRow: LedgerEntry = {
  branch: TARGET.headBranch,
  kind: "adversarial",
  patchId: REVIEWED_PATCH_ID,
  passed: true,
  at: 1,
  detail: "completed",
};
const lensRow: LedgerEntry = {
  branch: TARGET.headBranch,
  kind: "lens",
  patchId: REVIEWED_PATCH_ID,
  passed: true,
  detail: "APPROVED",
  hasCritical: false,
  round: 1,
  at: 2,
};
/** The disclosure both calls carry, so a difference in verdict is never about
 * findings having gone undisclosed. */
const disclosed = JSON.stringify({
  comments: [
    {
      body: `residuals\n<!-- pi-rukas:lens-residuals branch=${TARGET.headBranch} patch=${REVIEWED_PATCH_ID} -->`,
    },
  ],
});
const env = {
  ghComments: disclosed,
  fetchedHead: HEAD,
  target: { ...TARGET, headOid: HEAD },
};

await setupLedgerPath();

const drifted = await hookDecision("gh pr merge 12", [reviewedRow, lensRow], {
  ...env,
  // The head's CURRENT patch identity, deliberately not the reviewed one: what
  // a push landing after the review looks like to the gate.
  patchId: "c".repeat(40),
});
assert(
  drifted.block === true,
  `#1533: a merge is refused when the head is not the reviewed one`,
  drifted.reason,
);
assert(
  /head|patch|sha/i.test(drifted.reason ?? ""),
  `#1533: the refusal names the head, not a missing disclosure`,
  drifted.reason,
);

const notDrifted = await hookDecision("gh pr merge 12", [reviewedRow, lensRow], {
  ...env,
  patchId: REVIEWED_PATCH_ID,
});
assert(
  notDrifted.block === false,
  "#1533: with the head back to the reviewed patch the same rows merge",
  notDrifted.reason,
);

teardownLedger();

console.log(`\nexit ${exit}`);
process.exit(exit);
