#!/usr/bin/env bun
/**
 * #2223 round 2 — the decision points the incomplete-round fix added, locked
 * against a mutant. The sibling suite (`test-lens-incomplete-full-review.ts`)
 * drives the whole lens layer and would still be green if the ONE guard in
 * `decideEmptyDelta` were deleted (the layer's own full-review opt-out and the
 * delta reader above it hide it), and green if either arm of the head-carry
 * rule in `review-ledger-round.ts` were inverted. These arms call the decision
 * points directly, so deleting a guard or flipping a branch turns exactly one
 * assertion red.
 *
 * (a) `decideEmptyDelta` at the SAME head as a `REVIEW_INCOMPLETE` row answers
 *     "full", never the pre-existing `noReview` — the arm ordered before the
 *     same-head comparison is the whole fix.
 * (b) `bumpLensRound` / `incompleteHeadSha` on all three branches: incomplete
 *     after completed carries the completed head; incomplete after incomplete
 *     carries the EARLIER carried head, never the head this round ran at;
 *     incomplete with no completed history in front carries no head at all.
 * (c) `mergeAfterRace` — the rename-race fallback — given an incomplete new
 *     entry must reach the SAME outcome the happy path produces: one lens row
 *     for the key, carrying the last completed head. The fallback had its own
 *     ordering rules and no rule at all about `headSha`, so before the shared
 *     head rule it could put an unreviewed head back in reach. The helper IS the
 *     fallback (`test-review-ledger-lock.ts` proves the rename-catch reaches it
 *     with two real contending processes); the arms here drive it directly.
 *
 * Offline: hand-built rows and pure functions, plus one real temp repo for the
 * arms that go through the writer (`appendLedgerEntry`), whose rename-race
 * fallback is driven through the accepted #1071 critical-section seam.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideEmptyDelta } from "../src/lens-review-auto-delta.ts";
import { bumpLensRound } from "../src/review-ledger-round.ts";
import {
  type LedgerEntry,
  appendLedgerEntry,
  latestEntry,
  mergeAfterRace,
  readLedgerAt,
  workingTreePatchId,
} from "../src/review-ledger.ts";
import { reviewedHeadFromEntries } from "../src/work-driver-merged-identity.ts";
import { setupSpawnGuard } from "./test-helpers.ts";
import { execp } from "../src/exec.ts";
import { setupRepo } from "./lib/review-ledger-test-helpers.ts";

setupSpawnGuard();
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const HEAD_D = "d".repeat(40);

/** A completed lens row at `headSha`, carrying the identity a carry needs. */
function completed(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    branch: "feature/x",
    kind: "lens",
    patchId: "p-completed",
    passed: true,
    at: 100,
    detail: "APPROVED",
    hasCritical: false,
    headSha: HEAD_A,
    round: 2,
    incompleteRuns: 0,
    diffSha256: "digest-completed",
    ...over,
  };
}

/** An incomplete lens row — the shape #1039 hands the writer: a REAL headSha. */
function incomplete(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    branch: "feature/x",
    kind: "lens",
    patchId: "p-incomplete",
    passed: false,
    at: 200,
    detail: "REVIEW_INCOMPLETE",
    hasCritical: false,
    headSha: HEAD_B,
    ...over,
  };
}

// ── (a) decideEmptyDelta: a REVIEW_INCOMPLETE row at the SAME head is a full
//     review, not the noReview it would otherwise return ─────────────────────
// The mutant this locks: delete the `prev?.detail === "REVIEW_INCOMPLETE"` arm
// from decideEmptyDelta. The same-head comparison below then matches and the
// function answers `noReview`, which is the field shape #2223 was filed for.
{
  const f = setupRepo();
  const dir = mkdtempSync(path.join(os.tmpdir(), "led2223-delta-"));
  const file = path.join(dir, "review-ledger.json");
  const prior = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = file;
  // The identity the layer's own carry check recomputes, so the COMPLETED
  // control below can actually reach the same-head arm rather than failing
  // closed on an identity that never matches. `setupRepo` commits one file,
  // so the working-tree identity and the committed one are the same diff.
  const wt = await workingTreePatchId(execp, f.repo, { digest: true });
  try {
    assert(
      wt.patchId !== undefined && wt.diffSha256 !== undefined,
      `(a) fixture: the repo's patch identity computed (${wt.warning ?? "ok"})`,
    );
    // One row: incomplete at THIS head, with the identity fields a carry would
    // need if the incomplete guard were not in front of them.
    const row = completed({
      detail: "REVIEW_INCOMPLETE",
      passed: false,
      headSha: HEAD_B,
      patchId: wt.patchId ?? "p",
      diffSha256: wt.diffSha256 ?? "d",
      at: 1,
    });
    const failure = await appendLedgerEntry(row, execp, f.repo);
    assert(failure === undefined, `(a) the incomplete row at the head was written (${failure})`);
    assert(
      latestEntry(readLedgerAt(file), "feature/x", "lens")?.detail === "REVIEW_INCOMPLETE",
      "(a) and the reader's latest lens row for the branch is that incomplete row",
    );
    const e = await decideEmptyDelta({
      cwd: f.repo,
      branch: "feature/x",
      head: HEAD_B,
      base: "origin/dev",
    });
    assert(
      e.kind === "full",
      `(a) an incomplete row at the SAME head answers "full", not "noReview" (kind ${e.kind})`,
    );
    assert(
      /incomplete/i.test(e.kind === "full" ? e.reason : ""),
      `(a) and the reason names the incomplete round (${String(e.kind === "full" ? e.reason : "").slice(0, 60)})`,
    );

    // The control: the same row COMPLETED at the same head does answer
    // `noReview`, so the arm above is the incomplete rule and not a blanket
    // "never answer noReview".
    const done = completed({
      headSha: HEAD_B,
      patchId: wt.patchId ?? "p",
      diffSha256: wt.diffSha256 ?? "d",
      at: 2,
    });
    const wroteDone = await appendLedgerEntry(done, execp, f.repo);
    assert(wroteDone === undefined, `(a) the completed control row was written (${wroteDone})`);
    const control = await decideEmptyDelta({
      cwd: f.repo,
      branch: "feature/x",
      head: HEAD_B,
      base: "origin/dev",
    });
    assert(
      control.kind === "noReview",
      `(a) control: a COMPLETED row at the same head still answers "noReview" (kind ${control.kind})`,
    );
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prior;
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.dirname(f.repo), { recursive: true, force: true });
  }
}

// ── (b) the head an incomplete row carries, on all three branches of the rule ─
{
  // Branch 1: incomplete after a COMPLETED row → the completed row's head.
  const b1 = bumpLensRound(incomplete({ headSha: HEAD_B }), [completed({ headSha: HEAD_A })]);
  assert(
    b1.headSha === HEAD_A,
    `(b1) an incomplete row after a completed one carries the COMPLETED head (${String(b1.headSha)?.slice(0, 8)} vs ${HEAD_A.slice(0, 8)})`,
  );
  assert(b1.headSha !== HEAD_B, "(b1) …and not the head this round was pointed at");
  assert(
    reviewedHeadFromEntries([b1], "feature/x") === HEAD_A,
    "(b1) so the merged-head proof reads the completed head",
  );
  assert(b1.round === 2, `(b1) and the round still holds (${String(b1.round)})`);
  assert(
    b1.incompleteRuns === 1,
    `(b1) and the streak still grows (${String(b1.incompleteRuns)})`,
  );

  // Branch 2: the multi-round case, and the one that separates "the previous
  // row's head" from "the previous COMPLETED row's head". Two COMPLETED runs
  // (HEAD_A, then HEAD_B) and then an INCOMPLETE run that recorded no head
  // (#2223's own write). A third incomplete round must still carry HEAD_B — the
  // head of the last run that actually reviewed — and never the head it was
  // pointed at. A rule that only asked its IMMEDIATE predecessor would answer
  // "no head" here, and the merged-head proof would then have nothing to name.
  const first = bumpLensRound(incomplete({ headSha: HEAD_C, at: 150 }), [
    completed({ headSha: HEAD_A, at: 50, round: 1 }),
    completed({ headSha: HEAD_B, at: 100, round: 2 }),
  ]);
  assert(
    first.headSha === HEAD_B,
    `(b2) the first incomplete round after two completed runs carries the later completed head (${String(first.headSha)?.slice(0, 8)})`,
  );
  const b2 = bumpLensRound(incomplete({ headSha: "d".repeat(40), at: 300 }), [
    completed({ headSha: HEAD_A, at: 50, round: 1 }),
    completed({ headSha: HEAD_B, at: 100, round: 2 }),
    first,
  ]);
  assert(
    b2.headSha === HEAD_B,
    `(b2) an incomplete row after an INCOMPLETE one still carries the last completed head (${String(b2.headSha)?.slice(0, 8)}, not ${"d".repeat(8)})`,
  );
  assert(
    b2.headSha !== "d".repeat(40),
    "(b2) …never the head this round ran at, which no lens read",
  );
  assert(b2.incompleteRuns === 2, `(b2) and the streak is 2 (${String(b2.incompleteRuns)})`);
  // Not vacuous: a previous row that carries no head at all yields no head,
  // whatever head this round was pointed at. The field is dropped with `delete`
  // rather than set to `undefined` because bun's spread keeps an explicit
  // `headSha: undefined` and would leave the HEAD_A fixture value in place.
  const carriedNothing = incomplete({ headSha: HEAD_A, at: 150, round: 2, incompleteRuns: 1 });
  delete carriedNothing.headSha;
  assert(
    bumpLensRound(incomplete({ headSha: HEAD_C, at: 300 }), [carriedNothing]).headSha === undefined,
    "(b2) …and an incomplete previous row carrying no head passes no head forward",
  );

  // Branch 3: incomplete with NO completed history → no head at all (the
  // ledger's existing unknown-head shape, not an empty string).
  const b3 = bumpLensRound(incomplete({ headSha: HEAD_B }), [
    completed({ detail: "REVIEW_INCOMPLETE", passed: false, headSha: HEAD_C }),
  ]);
  assert(
    b3.headSha === undefined,
    `(b3) an incomplete row with no completed history carries NO head (got ${String(b3.headSha)?.slice(0, 8)})`,
  );
  assert(!("headSha" in b3), "(b3) …the field is absent, not set to an empty value");
  assert(
    reviewedHeadFromEntries([b3], "feature/x") === undefined,
    "(b3) so the merged-head proof has nothing to credit",
  );

  // A CARRY row (#1176) is not a review: `writeCarriedEntry` copies a completed
  // verdict onto a NEW head because `git diff since..head` came back empty, so the
  // row's `headSha` names a commit no lens ever read — the field testifies about
  // `carriedFrom`. An incomplete round must not inherit it, or the merged-head
  // proof would credit a head carried from an ancestor as the reviewed commit
  // while `resolveDeltaSince` skipped the incomplete row and never re-granted the
  // carry. Mutant: drop the `carriedFrom` filter from `incompleteHeadSha` and
  // these three assertions go red together.
  const carry = {
    ...completed({ headSha: HEAD_C, at: 120, round: 2 }),
    carriedFrom: HEAD_B,
    carryNote: "carried",
  };
  const afterCarry = bumpLensRound(incomplete({ headSha: HEAD_D, at: 300 }), [carry]);
  assert(
    afterCarry.headSha === undefined,
    `(b2) an incomplete row whose only completed-looking row is a CARRY carries no head (${String(afterCarry.headSha)?.slice(0, 8)})`,
  );
  assert(
    reviewedHeadFromEntries([afterCarry], "feature/x") === undefined,
    "(b2) …so the merged-head proof cannot credit the head that carry was written onto",
  );
  // Not over-sweeping: the genuine completed row behind the carry is still the
  // head source, so the rule is about the carry and not about the branch.
  const afterCarryAndReal = bumpLensRound(incomplete({ headSha: HEAD_D, at: 300 }), [
    completed({ headSha: HEAD_B, at: 100, round: 1 }),
    carry,
  ]);
  assert(
    afterCarryAndReal.headSha === HEAD_B,
    `(b2) …and the last GENUINELY completed head is still carried forward (${String(afterCarryAndReal.headSha)?.slice(0, 8)})`,
  );

  // The control that keeps the three arms from being "never keep a head":
  // a COMPLETED row is left exactly as written.
  const done = bumpLensRound(completed({ headSha: HEAD_C, at: 400 }), [b2]);
  assert(
    done.headSha === HEAD_C,
    `(b) control: a completed row keeps the head it reviewed (${String(done.headSha)?.slice(0, 8)})`,
  );
  assert(done.round === 3, `(b) …and advances the round past the incomplete streak (${String(done.round)})`);
  assert(done.incompleteRuns === 0, "(b) …and resets the streak");

  // Adversarial rows never touch the lens path: no head rule, no round.
  const adv = bumpLensRound(
    { branch: "feature/x", kind: "adversarial", patchId: "pa", passed: true, at: 500, headSha: HEAD_B },
    [completed()],
  );
  assert(adv.headSha === HEAD_B, "(b) an adversarial row keeps its own fields untouched");
  assert(adv.round === undefined, "(b) …and gains no lens round");
}

// ── (c) the rename-race fallback reaches the happy path's outcome ───────────
// Both shapes of the fallback's input are pinned: the pure helper with whatever
// rows a re-read can surface. The invariant is one sentence: after the merge,
// ONE lens row for the key, and its head is the last COMPLETED head.
//
// The helper is the whole fallback: `appendLedgerEntry`'s rename-catch re-reads
// the file and calls it, and `test-review-ledger-lock.ts` is the suite that
// proves the catch is reached at all (two real child processes contending on one
// ledger). Re-driving the catch from here would need the writer's lock handed
// over mid-critical-section, and an arm that has to arrange the lock to run is a
// test of the lock, not of the merge.
{
  // (c1) The re-read file holds the completed row (the winner's rename landed
  // it) and we are writing the incomplete round.
  const rows = mergeAfterRace([completed({ headSha: HEAD_A, at: 100 })], incomplete({ headSha: HEAD_B }));
  const lens = rows.filter((e) => e.branch === "feature/x" && e.kind === "lens");
  assert(
    lens.length === 1,
    `(c1) the race fallback leaves ONE lens row for the key (got ${String(lens.length)} — the completed row the next reader would credit)`,
  );
  assert(
    lens[0]?.detail === "REVIEW_INCOMPLETE",
    `(c1) …the incomplete row, which is what this write recorded (${String(lens[0]?.detail)})`,
  );
  assert(
    lens[0]?.headSha === HEAD_A,
    `(c1) and it carries the last COMPLETED head, not the unreviewed one (${String(lens[0]?.headSha)?.slice(0, 8)})`,
  );
  assert(
    reviewedHeadFromEntries(rows, "feature/x") === HEAD_A,
    "(c1) so the merged-head proof cannot name a head no lens read",
  );

  // (c2) The re-read file holds a STALE INCOMPLETE row (the #1069 shape: a
  // loser's row survived an earlier race) whose head is a value that no
  // COMPLETED run ever recorded. Our new incomplete row must not resurrect it,
  // and must not put its own head on the surviving row either.
  const stale = incomplete({ headSha: "d".repeat(40), at: 150, round: 2, incompleteRuns: 1 });
  const rows2 = mergeAfterRace([stale], incomplete({ headSha: HEAD_B, at: 250 }));
  const lens2 = rows2.filter((e) => e.branch === "feature/x" && e.kind === "lens");
  assert(
    lens2.length === 1,
    `(c2) two incomplete rows still collapse to one lens row for the key (got ${String(lens2.length)})`,
  );
  assert(
    lens2[0]?.headSha === undefined,
    `(c2) and neither unreviewed head survives on it (got ${String(lens2[0]?.headSha)?.slice(0, 8)})`,
  );
  assert(
    reviewedHeadFromEntries(rows2, "feature/x") === undefined,
    "(c2) so the merged-head proof refuses rather than crediting a head",
  );
  assert(
    lens2[0]?.incompleteRuns === 2,
    `(c2) and the streak continues off the stale row rather than restarting (${String(lens2[0]?.incompleteRuns)})`,
  );

  // (c3) A race whose re-read file holds ONLY an incomplete row (no completed
  // row at all) — the fallback must not read the head off that row either.
  const onlyIncomplete = incomplete({ headSha: HEAD_A, at: 50, round: 1, incompleteRuns: 1 });
  const rows3 = mergeAfterRace([onlyIncomplete], completed({ headSha: HEAD_C, at: 60 }));
  assert(
    rows3.length === 1 && rows3[0]?.headSha === HEAD_C && rows3[0]?.detail === "APPROVED",
    `(c3) a completed write after a stale incomplete row keeps the head IT reviewed (${String(rows3[0]?.headSha)?.slice(0, 8)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
