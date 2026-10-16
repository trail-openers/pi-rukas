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

import { chmodSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { cleanup, mergeMainFixture, writeLedger } from "./lib/auto-delta-fixture.ts";

// The lens roster reads the installed skills dir (~/.pi/agent/skills), which CI
// does not have. With no roster, runLensReview blocks before any lens child
// runs, so the "lens children run" assertions would fail there. Point it at the
// repo's own skill/ dir (the offline stand-in, as test-auto-delta-sha-head.ts does).
process.env.PI_ENSEMBLE_SKILLS_DIR = path.resolve(import.meta.dirname, "..", "..", "skill");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { runLensReview } = await import("../src/lens-review.ts");
const { renderSummary } = await import("../src/lens-review-render.ts");
const { decideEmptyDelta } = await import("../src/lens-review-auto-delta.ts");
import type { LedgerEntry } from "../src/review-ledger.ts";

const { latestEntry, readLedgerAt, workingTreePatchId } = await import("../src/review-ledger.ts");
const { writeLensLedgerEntry } = await import("../src/lens-ledger.ts");
const { evaluateRoundCapMerge, lensResidualsMarker } = await import(
  "../src/merge-guard-round-cap.ts"
);

const branch = "feature/work";
const THROWING_LENS = async () => {
  throw new Error("lensChildFn must not run on a carried verdict");
};

/** A real bare `origin` with origin/HEAD → main, so the writer resolves <remote>/<mainline>
 * the way it does in production (a `.` remote leaves origin/HEAD unset). */
async function addOrigin(dir: string): Promise<void> {
  const bare = path.join(path.dirname(dir), "origin.git");
  await execp(
    `git clone -q --bare ${dir} ${bare} && git remote add origin ${bare} && git fetch -q origin && git remote set-head origin main`,
    { cwd: dir, shell: "/bin/bash" },
  );
}

/** The identity the REAL writer (workingTreePatchId) computes at `sha`. */
async function identityAt(dir: string, sha: string) {
  await execp(`git checkout -q ${sha}`, { cwd: dir });
  const w = await workingTreePatchId(execp, dir, { digest: true });
  await execp(`git checkout -q ${branch}`, { cwd: dir });
  if (!w.patchId || !w.diffSha256) throw new Error(`writer produced no identity at ${sha}`);
  return { patchId: w.patchId, diffSha256: w.diffSha256 };
}

/** Fixture: the branch was last reviewed at c2 with `entry`'s verdict; HEAD is
 * the merge of main (an empty automatic delta). The recorded identity is the one
 * the writer computes at c2 (base c0), which the merge preserves. */
async function carryFixture(entry: {
  detail: string;
  round: number;
  hasCritical: boolean;
  passed: boolean;
}) {
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  const { patchId, diffSha256 } = await identityAt(r.dir, r.c2);
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId,
      diffSha256,
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
    assert(
      /not re-reviewed by this branch's lenses/.test(text),
      "summary states the merged-in mainline tree was not re-reviewed",
    );
    const latest = latestEntry(readLedgerAt(r.ledgerFile), branch, "lens");
    assert(latest?.headSha === r.merge, "ledger gains an entry for the current head (merge)");
    assert(latest?.detail === "ISSUES_FOUND", "carried entry keeps the ISSUES_FOUND verdict");
    assert(latest?.round === 2, "carried entry keeps round 2 (a carry adds no round)");
    assert(latest?.hasCritical === false, "carried entry keeps hasCritical false");
    assert(latest?.passed === false, "carried entry keeps passed false");
    assert(latest?.patchId === patchId, "carried entry keeps the recorded patch-id");
    assert(
      /not re-reviewed by this branch's lenses/.test(latest?.carryNote ?? ""),
      "carried ledger row states the merged-in mainline tree was not re-reviewed",
    );
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

// (E) a recorded REVIEW_INCOMPLETE run is never carried (#1176 round 2)
{
  const { decideEmptyDelta } = await import("../src/lens-review-auto-delta.ts");
  const { r } = await carryFixture({
    detail: "REVIEW_INCOMPLETE",
    round: 1,
    hasCritical: false,
    passed: false,
  });
  try {
    const e = await decideEmptyDelta({
      cwd: r.dir,
      branch,
      head: r.merge,
      base: "origin/main",
    });
    assert(
      e.kind === "full" && e.reason === "the recorded review was incomplete",
      "REVIEW_INCOMPLETE is never carried — the empty delta falls back to a full review",
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

// (G) same patch-id, different whitespace-sensitive digest → full review
{
  const { r, patchId } = await carryFixture({
    detail: "APPROVED",
    round: 1,
    hasCritical: false,
    passed: true,
  });
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId,
      diffSha256: "0".repeat(64),
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2,
      round: 1,
    },
  ]);
  try {
    const e = await decideEmptyDelta({ cwd: r.dir, branch, head: r.merge, base: "main" });
    assert(e.kind === "full", "a digest mismatch with an equal patch-id → full review, not carry");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (H) the REAL writer path: writeLensLedgerEntry records the reviewed head, and
// the checker recomputes the same identity on the merge → carry.
{
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  await execp(`git checkout -q ${r.c2}`, { cwd: r.dir });
  const recorded = await writeLensLedgerEntry(
    "APPROVED",
    "MEDIUM",
    r.dir,
    branch,
    false,
    r.c2,
    undefined,
    branch,
  );
  await execp(`git checkout -q ${branch}`, { cwd: r.dir });
  try {
    assert(recorded.recorded === true, "the real writer records the reviewed head c2");
    const stored = latestEntry(readLedgerAt(r.ledgerFile), branch, "lens");
    assert(typeof stored?.diffSha256 === "string", "the real writer stores diffSha256");
    const e = await decideEmptyDelta({ cwd: r.dir, branch, head: r.merge, base: "main" });
    assert(e.kind === "carry", "decideEmptyDelta recomputes the writer's identity → carry");
    writeLedger(r.ledgerFile, [{ ...(stored as LedgerEntry), diffSha256: "0".repeat(64) }]);
    const t = await decideEmptyDelta({ cwd: r.dir, branch, head: r.merge, base: "main" });
    assert(t.kind === "full", "the same stored row with a tampered digest → full review");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (I) the carried write is NOT recorded (ledger dir read-only) → no carry claimed
{
  const { r } = await carryFixture({
    detail: "APPROVED",
    round: 1,
    hasCritical: false,
    passed: true,
  });
  const ledgerDir = path.dirname(r.ledgerFile);
  chmodSync(ledgerDir, 0o555);
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
    assert(s.carriedFrom === undefined, "an unrecorded carry write is never reported as a carry");
    assert(calls > 0, "an unrecorded carry write falls back to a full review (lens children run)");
  } finally {
    chmodSync(ledgerDir, 0o755);
    cleanup(r.dir, r.ledgerFile);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
