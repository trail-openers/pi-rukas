#!/usr/bin/env bun
/**
 * #1176 — an EMPTY automatic delta carries the recorded verdict forward when
 * the branch's patch-id is unchanged (a `merge origin/main` or a no-op
 * commit), so the merge guard sees a ledger entry for the new head. A
 * changed patch-id reviews in full. Real git repos via the auto-delta
 * fixture; lens children are stubbed. The fixture isolates the ledger with the
 * PI_ENSEMBLE_REVIEW_LEDGER_FILE env override, so no run touches the real .git.
 *
 * Covers:
 *   - equal patch-id → entry recorded for HEAD with the carried verdict,
 *     passed, round and hasCritical (no round advance, never APPROVED)
 *   - a CRITICAL (non-passed) prior carries as blocking
 *   - the round-cap guard accepts the carried entry under the same rules
 *   - an undecidable patch-id (unresolvable base) fails closed to a full review
 */

import { execp } from "../src/exec.ts";
import { cleanup, mergeMainFixture, writeLedger } from "./lib/auto-delta-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { runLensReview } = await import("../src/lens-review.ts");
const { renderSummary } = await import("../src/lens-review-format.ts");
const { decideEmptyDelta } = await import("../src/lens-review-auto-delta.ts");
const { branchPatchId, latestEntry, readLedgerAt } = await import("../src/review-ledger.ts");
const { evaluateRoundCapMerge, lensResidualsMarker } = await import(
  "../src/merge-guard-round-cap.ts"
);

const branch = "feature/work";
const THROWING_LENS = async () => {
  throw new Error("lensChildFn must not run on a carried verdict");
};

/** Fixture: the branch was last reviewed at c2 with `entry`'s verdict; HEAD is
 * the merge of main (an empty automatic delta). The recorded patch-id is the
 * one the branch had when c2 was reviewed (base c0), which the merge preserves. */
async function carryFixture(entry: {
  detail: string;
  round: number;
  hasCritical: boolean;
  passed: boolean;
}) {
  const r = await mergeMainFixture();
  const patchId = (await branchPatchId(execp, r.dir, r.c2, r.c0)) as string;
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId,
      passed: entry.passed,
      at: 1000,
      detail: entry.detail,
      hasCritical: entry.hasCritical,
      headSha: r.c2,
      round: entry.round,
    },
  ]);
  return { r, patchId };
}

async function reviewAndAwaitLedger(
  dir: string,
  lensChildFn: typeof THROWING_LENS | ((...a: never[]) => Promise<never>),
) {
  const pending: Promise<unknown>[] = [];
  const s = await runLensReview({
    base: "main",
    head: "feature/work",
    cwd: dir,
    branch,
    lensChildFn: lensChildFn as never,
    onLedgerWrite: (p) => pending.push(p),
  });
  await Promise.all(pending);
  return s;
}

// (A) ISSUES_FOUND at round 2 → carried, round not advanced, blocking kept
{
  const { r, patchId } = await carryFixture({
    detail: "ISSUES_FOUND",
    round: 2,
    hasCritical: false,
    passed: false,
  });
  try {
    const s = await reviewAndAwaitLedger(r.dir, THROWING_LENS);
    assert(s.noReview === true, "equal patch-id → no-review outcome (no lens fan-out)");
    assert(
      s.carriedFrom?.verdict === "ISSUES_FOUND" && s.carriedFrom.round === 2,
      "summary carries the recorded verdict and round (ISSUES_FOUND, round 2)",
    );
    const text = renderSummary(s, 4);
    assert(text.startsWith("NO NEW CHANGES"), "render says NO NEW CHANGES, not a fresh review");
    assert(!/APPROVED/.test(text), "render never shows APPROVED for a carried ISSUES_FOUND");
    const latest = latestEntry(readLedgerAt(r.ledgerFile), branch, "lens");
    assert(latest?.headSha === r.merge, "ledger gains an entry for the current head (merge)");
    assert(latest?.detail === "ISSUES_FOUND", "carried entry keeps the ISSUES_FOUND verdict");
    assert(latest?.round === 2, "carried entry keeps round 2 (a carry adds no round)");
    assert(latest?.hasCritical === false, "carried entry keeps hasCritical false");
    assert(latest?.passed === false, "carried entry keeps passed false");
    assert(latest?.patchId === patchId, "carried entry keeps the recorded patch-id");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (B) CRITICAL prior → carried as blocking (hasCritical true, passed false)
{
  const { r } = await carryFixture({
    detail: "CRITICAL_ISSUES_FOUND",
    round: 1,
    hasCritical: true,
    passed: false,
  });
  try {
    const s = await reviewAndAwaitLedger(r.dir, THROWING_LENS);
    assert(
      s.carriedFrom?.verdict === "CRITICAL_ISSUES_FOUND",
      "CRITICAL prior is carried, not approved",
    );
    const latest = latestEntry(readLedgerAt(r.ledgerFile), branch, "lens");
    assert(
      latest?.hasCritical === true && latest?.passed === false,
      "carried CRITICAL entry stays blocking (hasCritical true, passed false)",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (C) APPROVED prior → carried as passed
{
  const { r } = await carryFixture({
    detail: "APPROVED",
    round: 1,
    hasCritical: false,
    passed: true,
  });
  try {
    await reviewAndAwaitLedger(r.dir, THROWING_LENS);
    const latest = latestEntry(readLedgerAt(r.ledgerFile), branch, "lens");
    assert(
      latest?.passed === true && latest?.headSha === r.merge,
      "APPROVED prior → passed entry for HEAD",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (D) the round-cap guard accepts the carried entry under the same rules
{
  const { r, patchId } = await carryFixture({
    detail: "ISSUES_FOUND",
    round: 3,
    hasCritical: false,
    passed: false,
  });
  try {
    await reviewAndAwaitLedger(r.dir, THROWING_LENS);
    const entries = readLedgerAt(r.ledgerFile);
    const d = evaluateRoundCapMerge(
      entries,
      branch,
      patchId,
      [lensResidualsMarker(branch, patchId)],
      r.merge,
    );
    assert(
      d.applies && d.allowed,
      "guard accepts the carried ISSUES_FOUND entry (round 3, marker, head match)",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (E) a changed patch-id → full review, no carry, no entry for the carry
{
  const { r } = await carryFixture({
    detail: "APPROVED",
    round: 1,
    hasCritical: false,
    passed: true,
  });
  // Overwrite the recorded patch-id with one the branch does not have.
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "not-the-branch-patch",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2,
      round: 1,
    },
  ]);
  let calls = 0;
  try {
    const s = await reviewAndAwaitLedger(r.dir, (async () => {
      calls += 1;
      return {
        lens: "SECURITY",
        ok: true,
        ms: 0,
        startMs: Date.now(),
        findings: [],
        attempts: 1,
        blocked: false,
      };
    }) as never);
    assert(s.noReview !== true && s.carriedFrom === undefined, "changed patch-id → not carried");
    assert(calls > 0, "changed patch-id → lens children run (full review)");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (F) fail closed: an unresolvable base cannot prove the patch-id → full
{
  const { r } = await carryFixture({
    detail: "APPROVED",
    round: 1,
    hasCritical: false,
    passed: true,
  });
  try {
    const e = await decideEmptyDelta({
      cwd: r.dir,
      branch,
      head: r.merge,
      base: "no-such-remote/main",
    });
    assert(e.kind === "full", "undecidable patch-id (unresolvable base) → full review, not carry");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
