#!/usr/bin/env bun
/**
 * #807 — the classifier's Case-2 root-cause match must compare the
 * EXTRACTED assertions (the #798 regression), and the develop-seam
 * flake-retry precondition must distinguish a per-worktree FLAKE from a
 * per-worktree DEFECT.
 */

import {
  classifyConsolidatedVerifyFailure,
  extractSpecificAssertion,
  NO_SPECIFIC_ASSERTION,
} from "../src/work-driver-consolidation-classify.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The #798 regression shape: a timing-flaky test (test-cancel.ts) failed in a
// worktree with the IDENTICAL `✗` line that failed on the consolidated tree.
// Both tails carry the smoke-loop `FAILED:` marker (which the old code
// selected and compared marker-vs-marker, hiding the shared assertion).
const sharedAssertion = "✗ aborted child returned within 10s (took 496954ms)";
const consolidatedTail = `FAILED: smoke-tests/test-cancel.ts
${sharedAssertion}`;
const perWorktreeTail = `FAILED: smoke-tests/test-cancel.ts
${sharedAssertion}`;

// --- Case 1 (the #798 regression): identical ✗ assertion on both sides,
// N=2. Must classify per-workstream-defect, NOT consolidation-created.
{
  const v = classifyConsolidatedVerifyFailure(
    2,
    ["ws1", "ws2"],
    consolidatedTail,
    { ws2: perWorktreeTail },
  );
  assert(v.classification === "per-workstream-defect", `case 1 (#798 regression): same ✗ assertion both sides → per-workstream-defect (got: ${v.classification})`);
  assert(v.workstreamIds.length === 1 && v.workstreamIds[0] === "ws2", `case 1: names the single failing workstream (got: ${v.workstreamIds})`);
  assert(v.assertion === sharedAssertion, `case 1: the reported assertion is the shared ✗ line (got: ${v.assertion})`);
}

// --- Case 2: per-worktree assertion DIFFERS from the consolidated one →
// consolidation-created (a genuine combination defect; the retry must not fire).
{
  const diffPer = `FAILED: smoke-tests/test-other.ts
✗ other test failed: expected 1 got 2`;
  const v = classifyConsolidatedVerifyFailure(2, ["ws1", "ws2"], consolidatedTail, {
    ws2: diffPer,
  });
  assert(v.classification === "consolidation-created", `case 2 (different assertion): a per-worktree defect with a DIFFERENT assertion → consolidation-created (got: ${v.classification})`);
}

// --- Case 3: N=1 invariant still holds — a single workstream sharing the
// assertion is per-workstream-defect (re-run), never consolidation-created.
{
  const v = classifyConsolidatedVerifyFailure(1, ["ws1"], consolidatedTail, {
    ws1: perWorktreeTail,
  });
  assert(v.classification === "per-workstream-defect", `case 3 (N=1): same assertion, N=1 → per-workstream-defect, never consolidation-created (got: ${v.classification})`);
}

// --- Case 4: N=1, NO shared assertion → needs-human-decision (not
// consolidation-created, not per-workstream-defect).
{
  const unrelated = `FAILED: smoke-tests/test-x.ts
✗ unrelated assertion failed`;
  const v = classifyConsolidatedVerifyFailure(1, ["ws1"], consolidatedTail, { ws1: unrelated });
  assert(v.classification === "needs-human-decision", `case 4 (N=1, no match): no shared assertion → needs-human-decision (got: ${v.classification})`);
}

// --- Case 5: an honest absence (no assertion on either side) must NOT be
// treated as a match (the sentinel never matches a real assertion).
{
  const bareMarker = "FAILED: smoke-tests/test-mystery.ts"; // no ✗ line
  const v = classifyConsolidatedVerifyFailure(2, ["ws1", "ws2"], bareMarker, {
    ws2: "FAILED: smoke-tests/test-mystery.ts",
  });
  assert(v.assertion === NO_SPECIFIC_ASSERTION, `case 5 (no assertion): the consolidated tail reports absence (got: ${v.assertion})`);
  assert(v.classification === "consolidation-created", `case 5 (no assertion): absence ≠ match → falls through to consolidation-created (got: ${v.classification})`);
}

// --- The develop-seam retry precondition (reproduced here exactly as in
// work-driver-verify-verify-cmd.ts). It fires when the ONLY per-worktree
// failure shares the consolidated assertion (#798 shape), and is blocked when
// the per-worktree failure has a DIFFERENT assertion (a genuine defect).
function retryPrecondition(
  perWorktreeVerifyFailures: string[],
  perWorktreeFailuresByWs: Record<string, string>,
  worktreeCount: number,
): boolean {
  return (
    (perWorktreeVerifyFailures.length === 0 ||
      (perWorktreeVerifyFailures.length === 1 && Object.keys(perWorktreeFailuresByWs).length === 1)) &&
    worktreeCount > 1
  );
}

// --- Case 6: per-worktree FLAKE (one failure, same assertion) → retry fires.
{
  const per = [perWorktreeTail];
  const byWs = { ws2: perWorktreeTail };
  const pre = retryPrecondition(per, byWs, 2);
  const shared =
    extractSpecificAssertion(perWorktreeTail) === extractSpecificAssertion(consolidatedTail);
  assert(pre, "case 6 (flake, same assertion): the retry precondition FIRES for a single shared flake");
  assert(shared, "case 6: the shared-assertion check confirms both sides extract the identical ✗ line");
}

// --- Case 7: per-worktree DEFECT (one failure, DIFFERENT assertion) → the
// precondition still fires (it is purely about "one unstable test vs two
// defects"), but the shared-assertion guard must BLOCK the retry for a
// genuine defect. This is the guard that keeps a real consolidation-created
// defect from being retried into a false pass.
{
  const per = [`FAILED: smoke-tests/test-other.ts\n✗ other: expected 1 got 2`];
  const byWs = { ws2: per[0] };
  const pre = retryPrecondition(per, byWs, 2);
  const shared =
    extractSpecificAssertion(per[0]) === extractSpecificAssertion(consolidatedTail);
  assert(pre, "case 7 (defect, different assertion): the length precondition is satisfied (one failure, N>1)");
  assert(!shared, "case 7: the shared-assertion guard is FALSE → the retry must be suppressed for a genuine defect");
}

// --- Case 8: two per-worktree failures → the length precondition BLOCKS the
// retry (two independent failures are never one flake).
{
  const pre = retryPrecondition(["f1", "f2"], { ws1: "f1", ws2: "f2" }, 2);
  assert(!pre, "case 8 (two per-worktree failures): the retry precondition is BLOCKED");
}

// --- Case 9: N=1 (single worktree) → the precondition BLOCKS the retry
// (N=1 is a no-op consolidation).
{
  const pre = retryPrecondition([], {}, 1);
  assert(!pre, "case 9 (N=1): the retry precondition is BLOCKED for a no-op consolidation");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
