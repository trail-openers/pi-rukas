#!/usr/bin/env bun
/**
 * #2223 — an incomplete lens round must not make its head look reviewed.
 *
 * THE FIELD SHAPE (the red-first case): a round in which every lens is blocked
 * — the skills dir is missing, or every spawn dies on a quota error — records
 * `REVIEW_INCOMPLETE` with a REAL `headSha` (#1039 resolves the head before any
 * early exit). The next dispatch, with no new commit, read that SHA as "this
 * branch was last reviewed here", resolved an empty automatic delta, and
 * answered "NO REVIEW — no changes since the last lens review" with no verdict
 * at all. Only `full: true` recovered. A round that ran no lens cannot be
 * evidence that the head was reviewed (AGENTS.md §7: silence is never a pass).
 *
 * The arms, in the order the issue's binding Resolutions name them:
 *
 *  (L8) all six lenses blocked, then a re-dispatch at the same head with no new
 *       commit: the fan-out runs and a verdict is rendered.
 *  (L2) `resolveDeltaSince` skips a `REVIEW_INCOMPLETE` row, and the skip is
 *       checked BEFORE the same-head `noReview` arm — the order is the fix.
 *  (L1) the incomplete round still writes exactly one row, carrying the last
 *       COMPLETED row's `headSha` forward, and stays `latestEntry`'s answer.
 *  (L3) a partially complete round is incomplete, so it is no delta base.
 *  (L4) `reviewedHeadFromEntries` reads that carried-forward head, so a head
 *       whose lenses never ran is never the merged-head proof.
 *  (L5) N consecutive all-blocked rounds still count: `incompleteRuns` grows
 *       with each and `evaluateRoundBudget` reports the streak and refuses at
 *       the cap.
 *  (L6) the writer and the delta-base reader key on the SAME ledger key.
 *  (L7) the merge guard never credits an incomplete round.
 *
 * Offline: real temp repos, stubbed lens children, per-case ledger isolation,
 * no spawn, no token. The harness is `lib/lens-incomplete-round-fixture.ts`.
 */

import {
  lensRoundFixture,
  headOf,
  roundIdentity,
  seedLensRow,
} from "./lib/lens-incomplete-round-fixture.ts";
import { setupSpawnGuard } from "./test-helpers.ts";
import { decideEmptyDelta, resolveDeltaSince } from "../src/lens-review-auto-delta.ts";
import { lensIncompleteForcesFull } from "../src/lens-review-incomplete-switch.ts";
import { evaluateRoundBudget, readRecordedLens } from "../src/lens-round-cap.ts";
import { evaluateRoundCapMerge, lensResidualsMarker } from "../src/merge-guard-round-cap.ts";
import { reviewedHeadFromEntries } from "../src/work-driver-merged-identity.ts";
import { bumpLensRound } from "../src/review-ledger-round.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import { latestEntry, lensPassed, readLedgerAt } from "../src/review-ledger.ts";
import { resolveBudgetKey } from "../src/lens-budget-key.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (L8) the field shape: all lenses blocked, then a re-dispatch with no new
//     commit must render a verdict with the fan-out invoked ───────────────────
{
  const f = await lensRoundFixture({ name: "field" });
  try {
    const first = await f.drive("all");
    assert(
      first.summary.verdict === "REVIEW_INCOMPLETE",
      `(L8) round 1 is REVIEW_INCOMPLETE (${first.summary.verdict})`,
    );
    assert(first.calls > 0, `(L8) round 1 paid its fan-out (${String(first.calls)} lens calls)`);
    // The row this round writes carries the previous COMPLETED head (#2223), which
    // is ABSENT here: the branch has never completed one. Reading the row is what
    // keeps the two arms below unfalsifiable — a round that reached no verdict and
    // wrote nothing would otherwise look like a fan-out that simply returned clean.
    const recorded = f.rows().find((e) => e.detail === "REVIEW_INCOMPLETE");
    assert(recorded !== undefined, "(L8) the blocked round recorded its row");
    assert(
      recorded?.headSha === undefined,
      `(L8) …and it records no reviewed head, because no lens ran one (${String(recorded?.headSha)?.slice(0, 12)})`,
    );
    const again = await f.drive("none");
    assert(
      again.calls > 0,
      `(L8) the re-dispatch at the SAME head with no new commit invokes the lens fan-out (${String(again.calls)} calls)`,
    );
    assert(
      again.summary.noReview !== true,
      `(L8) and it is not the no-review outcome (noReview=${String(again.summary.noReview)}, note ${String(again.summary.note)?.slice(0, 40)})`,
    );
  } finally {
    f.cleanup();
  }
}

// ── (L2) the reader: an incomplete row is not a delta base, checked before the
//     same-head noReview arm ───────────────────────────────────────────────────
{
  const f = await lensRoundFixture({ name: "reader" });
  try {
    await seedLensRow(f, { headSha: f.head, round: 1, incompleteRuns: 1, at: 1 });
    const since = await resolveDeltaSince(f.branch, f.head, f.repo);
    assert(
      since === undefined,
      `(L2) resolveDeltaSince skips the incomplete row at the head (got ${String(since)})`,
    );
    const e = await decideEmptyDelta({
      cwd: f.repo,
      branch: f.branch,
      head: f.head,
      base: "origin/dev",
    });
    assert(
      e.kind === "full",
      `(L2) and the same-head empty delta answers "full", never the pre-existing noReview (kind ${e.kind})`,
    );
  } finally {
    f.cleanup();
  }
}

// ── (L2b) the same rule on a row whose head is an ANCESTOR of the head ───────
// The non-empty-delta arm of the bug: an incomplete round at the base followed
// by a head move reviewed only base..head — the history that round never saw.
{
  const f = await lensRoundFixture({ name: "ancestor" });
  try {
    const base = headOf(f.repo, "origin/dev");
    await seedLensRow(f, { headSha: base, round: 1, incompleteRuns: 2, at: 1 });
    const since = await resolveDeltaSince(f.branch, f.head, f.repo);
    assert(
      since === undefined,
      `(L2b) an incomplete row at an ancestor is no delta base either (got ${String(since)?.slice(0, 12)})`,
    );
  } finally {
    f.cleanup();
  }
}

// ── (L2c) a COMPLETED row is still a delta base (the rule is not "never take a
//     stored head") ────────────────────────────────────────────────────────────
{
  const f = await lensRoundFixture({ name: "completed" });
  try {
    const base = headOf(f.repo, "origin/dev");
    await seedLensRow(f, {
      headSha: base,
      round: 1,
      at: 1,
      detail: "APPROVED",
      passed: true,
    });
    const since = await resolveDeltaSince(f.branch, f.head, f.repo);
    assert(
      since === base,
      `(L2c) a completed ancestor row still resolves the delta (got ${String(since)?.slice(0, 12)})`,
    );
  } finally {
    f.cleanup();
  }
}

// ── (L1) the row an incomplete round writes: exactly one, still latestEntry's
//     answer, carrying the last COMPLETED head forward ────────────────────────
{
  const f = await lensRoundFixture({ name: "carry-forward" });
  try {
    const completed = await f.drive("none");
    assert(
      completed.summary.verdict === "APPROVED",
      `(L1) the completed round approved (${completed.summary.verdict})`,
    );
    const moved = await f.advance("after-the-review");
    // `full` here is a PREMISE, not the thing under test: it forces the fan-out to
    // be reached whatever the delta base resolves, so the only way this round can
    // fail is the writer carrying the un-reviewed head onto the row. Without it,
    // a round that returns at the no-review arm never reaches the ledger write and
    // the assertion below would be reading a row this round never had the chance to
    // influence — vacuous, not red.
    const blocked = await f.drive("all", { full: true });
    assert(
      blocked.summary.verdict === "REVIEW_INCOMPLETE",
      `(L1) the next round (at ${moved.slice(0, 12)}) was blocked (${blocked.summary.verdict})`,
    );
    // One row per (branch, kind) is the ledger dedupe invariant, read from the
    // file rather than from a stub that records what it was handed.
    assert(f.rows().length === 1, `(L1) one lens row on the branch (got ${String(f.rows().length)})`);
    const latest = latestEntry(readLedgerAt(f.file), f.branch, "lens");
    assert(
      latest?.detail === "REVIEW_INCOMPLETE",
      `(L1) and the incomplete round's row is latestEntry's answer (${String(latest?.detail)})`,
    );
    // #1039 resolves the review's head BEFORE the fan-out and the row is written
    // with it, so a clean round's `headSha` IS the head it ran at. That is the
    // completed head this round must inherit — see the fixture's `drive`.
    const lastReviewed = completed.summary.deltaReview?.head ?? f.head;
    assert(
      lastReviewed !== moved,
      `(L1) the fixture really moved the head past the reviewed commit (${lastReviewed.slice(0, 12)} → ${moved.slice(0, 12)})`,
    );
    assert(
      latest?.headSha === lastReviewed,
      `(L1) and it carries the last COMPLETED head forward, not the head it ran at (${String(latest?.headSha)?.slice(0, 12)} vs ${moved.slice(0, 12)})`,
    );
    assert(
      latest?.headSha !== moved,
      "(L1) …so the head whose lenses never ran is not on the row",
    );
    assert(latest?.incompleteRuns === 1, `(L1) and it counts its one incomplete run (${String(latest?.incompleteRuns)})`);
  } finally {
    f.cleanup();
  }
}

// ── (L3) a partially complete round is incomplete: five clean, one blocked ───
{
  const f = await lensRoundFixture({ name: "partial" });
  try {
    await f.drive("none");
    await f.advance("after-the-clean-round");
    // `full` is the premise again (see the L1 arm): the round must reach the fan-out
    // so that the row it writes — the row the delta base is read from — is this
    // round's partially complete row and not the earlier clean one.
    const partial = await f.drive("first", { full: true });
    assert(
      partial.summary.verdict === "REVIEW_INCOMPLETE",
      `(L3) a round with one blocked lens reports ${partial.summary.verdict}`,
    );
    const since = await resolveDeltaSince(f.branch, f.head, f.repo);
    assert(
      since === undefined,
      `(L3) and it is no delta base — the next round re-runs all six over the wider range (got ${String(since)})`,
    );
  } finally {
    f.cleanup();
  }
}

// ── (L1c) the counter's own rule, on the pure function the writer uses: an
//     incomplete row holds the round, grows the streak, and its head is the
//     previous COMPLETED head rather than the head it was run at ──────────────
{
  const completed: LedgerEntry = {
    branch: "feature/x",
    kind: "lens",
    patchId: "p",
    passed: true,
    at: 100,
    detail: "APPROVED",
    hasCritical: false,
    headSha: "a".repeat(40),
    round: 3,
    incompleteRuns: 0,
  };
  assert(lensIncompleteForcesFull() === true, "(L1c) the switch is on by default");
  const bumped = bumpLensRound(
    {
      ...completed,
      at: 200,
      detail: "REVIEW_INCOMPLETE",
      passed: false,
      headSha: "b".repeat(40),
    },
    [completed],
  );
  assert(bumped.round === 3, "(L1c) an incomplete round holds the round");
  assert(bumped.incompleteRuns === 1, "(L1c) and grows the incomplete streak");
  assert(
    reviewedHeadFromEntries([{ ...bumped, headSha: completed.headSha }], "feature/x") ===
      completed.headSha,
    "(L1c) and the merged-head proof reads the carried-forward head",
  );
}

// ── (L4) reviewedHeadFromEntries never credits a head whose lenses never ran ─
{
  const f = await lensRoundFixture({ name: "merged-head" });
  try {
    const completed = await f.drive("none");
    const reviewed = completed.summary.deltaReview?.head ?? f.head;
    assert(
      reviewedHeadFromEntries(f.rows(), f.branch) === reviewed,
      `(L4) a completed row names the head it reviewed (${reviewed.slice(0, 12)})`,
    );
    const moved = await f.advance("second");
    assert(moved !== reviewed, `(L4) the branch moved to ${moved.slice(0, 12)}`);
    const blocked = await f.drive("all", { full: true });
    assert(
      blocked.summary.verdict === "REVIEW_INCOMPLETE",
      `(L4) and an all-blocked round ran at it (${blocked.summary.verdict})`,
    );
    const latest = latestEntry(readLedgerAt(f.file), f.branch, "lens");
    assert(latest?.detail === "REVIEW_INCOMPLETE", "(L4) the branch's latest lens row is now incomplete");
    const proof = reviewedHeadFromEntries(f.rows(), f.branch);
    assert(
      proof !== moved,
      `(L4) and the merged-head proof is NOT the unrun head (${String(proof)?.slice(0, 12)})`,
    );
    assert(
      proof === reviewed,
      `(L4) it is the last COMPLETELY reviewed head instead (${String(proof)?.slice(0, 12)})`,
    );
  } finally {
    f.cleanup();
  }
}

// ── (L5) N consecutive all-blocked rounds stay budgeted ─────────────────────
// The streak cap is the #1127 invariant: an incomplete row that stops being a
// delta base must still count, or a chronically failing lens is re-run forever.
{
  const N = 3;
  const f = await lensRoundFixture({ name: "streak" });
  try {
    for (let i = 0; i < N; i += 1) {
      if (i > 0) await f.advance(`blocked-round-${String(i)}`);
      // `full` is the premise again: without the switch a round at an
      // already-incomplete head returns at the no-review arm, writes no row, and the
      // streak below would be counted from a row this round never wrote. With it,
      // every round provably reaches the writer.
      await f.drive("all", { full: true });
    }
    assert(f.rows().length === 1, `(L5) ${String(N)} blocked rounds still leave ONE lens row (got ${String(f.rows().length)})`);
    const recorded = await readRecordedLens(f.repo, f.branch);
    assert(recorded.ok === true, "(L5) the round budget reads the branch's latest lens row");
    // Narrowed by the assertion above only in the reader's eye; the compiler needs
    // the discriminated arm spelled, and reading `.latest` on the failure arm is
    // the type error that would otherwise hide a `{ok:false}` behind `undefined`.
    const budget = evaluateRoundBudget(recorded.ok ? recorded.latest : undefined, 2);
    assert(
      budget.incompleteStreak === N,
      `(L5) and it reports the streak of ${String(N)} incomplete runs (got ${String(budget.incompleteStreak)})`,
    );
    assert(budget.streakCapped === true, "(L5) at the cap the streak refuses the next run");
    assert(budget.allowed === false, "(L5) so the round is not allowed");
  } finally {
    f.cleanup();
  }
}

// ── (L6) the writer and the delta reader resolve the SAME ledger key ─────────
// `runLensReview` hands the delta reader `budgetKey.key ?? branchResolved` while
// the writer keys on `ledger.ledgerKey ?? branchResolved`. A fixture whose two
// keys disagree proves nothing, so the arm asserts they agree first.
{
  const f = await lensRoundFixture({ name: "key" });
  try {
    await f.drive("all");
    const keyed = await resolveBudgetKey({ cwd: f.repo, head: f.branch });
    const written = f.rows()[0];
    assert(keyed.key === f.branch, `(L6) the budget key for this head is the branch (${String(keyed.key)})`);
    assert(
      written?.branch === f.branch,
      `(L6) and the writer keyed the row on the same string (${String(written?.branch)})`,
    );
    const since = await resolveDeltaSince(keyed.key, f.head, f.repo);
    assert(
      since === undefined,
      `(L6) read under that key, the incomplete row resolves no delta base (got ${String(since)})`,
    );
  } finally {
    f.cleanup();
  }
}

// ── (L7) the merge guard never credits an incomplete round ──────────────────
// The only lens row on the branch is incomplete at the PR head, at the round cap
// with the disclosure marker present: every allow-side condition is satisfied
// except the verdict, so a row that let itself be read as a completed round
// would merge.
{
  const f = await lensRoundFixture({ name: "guard" });
  try {
    const id = await roundIdentity(f.repo);
    await seedLensRow(f, {
      headSha: f.head,
      round: 5,
      incompleteRuns: 5,
      at: 1,
      patchId: id.patchId,
      diffSha256: id.diffSha256,
      blockingCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0 },
      blockingBar: "HIGH",
    });
    assert(lensPassed("REVIEW_INCOMPLETE", "LOW") === false, "(L7) an incomplete verdict never passes");
    const decision = evaluateRoundCapMerge(
      readLedgerAt(f.file),
      f.branch,
      id.patchId,
      [lensResidualsMarker(f.branch, id.patchId)],
      f.head,
    );
    assert(
      decision.allowed === false,
      `(L7) the round-cap path does not allow the merge on an incomplete row (allowed=${String(decision.allowed)})`,
    );
    assert(
      decision.failedCondition !== undefined && /REVIEW_INCOMPLETE/.test(decision.failedCondition),
      `(L7) and the refusal names the verdict it refused on (${String(decision.failedCondition)?.slice(0, 60)})`,
    );
  } finally {
    f.cleanup();
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
