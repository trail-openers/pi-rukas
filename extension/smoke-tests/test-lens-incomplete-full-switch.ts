#!/usr/bin/env bun
/**
 * #2223 — the `PI_ENSEMBLE_LENS_INCOMPLETE_FULL` switch.
 *
 * An incomplete lens round must not make its head look reviewed: the delta-base
 * reader skips a `REVIEW_INCOMPLETE` row, checked BEFORE the same-head
 * `noReview` arm, so the next dispatch reviews the whole range. The switch is
 * the operator's escape hatch back to the pre-fix behaviour, and three things
 * an operator and a later edit both need are asserted here and nowhere else:
 *
 *   - the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can
 *     discover is a knob that does not exist — `test-headless-inputs.ts` checks
 *     the roster against the readers and never opens `docs/`);
 *   - the truth table on the exported reader (on for unset, `"1"`, `""` and
 *     `"false"`; off for the literal `"0"` alone);
 *   - the OFF arm's byte-identical ledger consequence: with `=0` the incomplete
 *     row IS the automatic delta base and the same-head round is a `noReview`
 *     again, exactly as it read before the rule existed.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an
 * operator's exported `=0`, would otherwise make the ON cases measure the
 * wrong arm.
 *
 * The field shape — all six lenses blocked, then a re-dispatch with no new
 * commit that must reach the fan-out — is `test-lens-incomplete-full-review.ts`;
 * this file pins the switch, that one pins the defect.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import {
  decideEmptyDelta,
  resolveDeltaSince,
} from "../src/lens-review-auto-delta.ts";
import { lensIncompleteForcesFull } from "../src/lens-review-incomplete-switch.ts";
import { latestEntry, readLedgerAt, workingTreePatchId } from "../src/review-ledger.ts";
import { cleanup, mergeMainFixture, writeLedger } from "./lib/auto-delta-fixture.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const branch = "feature/work";

/** A real bare `origin` with origin/HEAD → main, so the writer resolves
 * `<remote>/<mainline>` the way it does in production (the auto-delta fixture's
 * `.`-only remote leaves origin/HEAD unset and no identity can be computed). */
async function addOrigin(dir: string): Promise<void> {
  const bare = path.join(path.dirname(dir), "origin.git");
  await execp(
    `git clone -q --bare ${dir} ${bare} && git remote add origin ${bare} && git fetch -q origin && git remote set-head origin main`,
    { cwd: dir, shell: "/bin/bash" },
  );
}

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

// ── (1) the docs row exists and is understandable from the docs alone ────────
{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LENS_INCOMPLETE_FULL`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LENS_INCOMPLETE_FULL",
  );
  // The row has to name both the symptom and the escape hatch: an operator who
  // sets `=0` is putting the false "no changes" refusal back, and should read
  // that consequence — not just the knob's name — from the row.
  assert(
    doc.includes("REVIEW_INCOMPLETE"),
    "and that row names the verdict it keys on (REVIEW_INCOMPLETE)",
  );
  assert(
    doc.includes("no changes since the last lens review"),
    "and that row names the symptom the rule removes, in the operator's own words",
  );
}

// ── (2) the truth table: only the literal "0" is off ─────────────────────────
for (const [value, want] of [
  [undefined, true],
  ["", true],
  ["1", true],
  ["false", true],
  ["0", false],
] as const) {
  await withEnv({ PI_ENSEMBLE_LENS_INCOMPLETE_FULL: value }, async () => {
    assert(
      lensIncompleteForcesFull() === want,
      `PI_ENSEMBLE_LENS_INCOMPLETE_FULL=${JSON.stringify(value)} reads ${String(want)}`,
    );
  });
}

// ── (3) the OFF arm: the incomplete row is the delta base again ──────────────
// The byte-identical pre-fix behaviour on the two readers the rule touches.
// The row is spelled the way a pre-#2223 ledger spells an all-blocked round —
// `detail: REVIEW_INCOMPLETE` carrying the REAL head it was invoked at. The
// current writer no longer produces that shape (it carries the last COMPLETED
// head forward, or none), which is exactly why it is spelled by hand here: the
// escape hatch has to reproduce the old reading of the old rows, and a fixture
// that wrote today's row would prove the off arm on data no off host ever has.
{
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  const identity = await identityAt(r.dir, r.c2);
  writeLedger(r.ledgerFile, [incompleteRow(r.c2, identity, 1)]);
  try {
    await withEnv({ PI_ENSEMBLE_LENS_INCOMPLETE_FULL: "0" }, async () => {
      assert(lensIncompleteForcesFull() === false, "(off) the switch reads off");
      const since = await resolveDeltaSince(branch, undefined, r.dir);
      assert(
        since === r.c2,
        `(off) the incomplete row IS the automatic delta base again (${String(since)?.slice(0, 12)})`,
      );
      // The head the round never reviewed, named as its own delta base: the
      // pre-fix refusal, byte for byte.
      const e = await decideEmptyDelta({
        cwd: r.dir,
        branch,
        head: r.c2,
        base: "origin/main",
      });
      assert(
        e.kind === "noReview",
        `(off) a same-head round is the refusal again, not a full review (kind ${e.kind})`,
      );
    });
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// ── (4) the ON arm: the same row is not a base, and the same head reviews ────
{
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  const identity = await identityAt(r.dir, r.c2);
  writeLedger(r.ledgerFile, [incompleteRow(r.c2, identity, 1)]);
  try {
    await withEnv({ PI_ENSEMBLE_LENS_INCOMPLETE_FULL: undefined }, async () => {
      assert(lensIncompleteForcesFull() === true, "(on) the switch reads on");
      const since = await resolveDeltaSince(branch, undefined, r.dir);
      assert(since === undefined, "(on) the incomplete row is no delta base (full review)");
      const e = await decideEmptyDelta({
        cwd: r.dir,
        branch,
        head: r.c2,
        base: "origin/main",
      });
      assert(
        e.kind === "full",
        `(on) the same-head empty delta is a full review, not the refusal (kind ${e.kind})`,
      );
    });
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// ── (5) a COMPLETED row is still a base with the switch on (no over-sweep) ───
{
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  const identity = await identityAt(r.dir, r.c2);
  writeLedger(r.ledgerFile, [
    { ...incompleteRow(r.c2, identity, 3), detail: "APPROVED", passed: true },
  ]);
  try {
    await withEnv({ PI_ENSEMBLE_LENS_INCOMPLETE_FULL: undefined }, async () => {
      const since = await resolveDeltaSince(branch, undefined, r.dir);
      assert(
        since === r.c2 || since === undefined,
        "(on) a completed row is judged by the pre-existing rules, not the new one",
      );
      // The reader's own contract for an equal head is unchanged: no delta, and
      // the carry rule (not this one) decides what the empty delta means.
      const e = await decideEmptyDelta({
        cwd: r.dir,
        branch,
        head: r.c2,
        base: "origin/main",
      });
      assert(e.kind === "noReview", "(on) a completed same-head row still reads as no-review");
    });
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// ── (6) a legacy row with no `detail` is not swept up by the new rule ────────
// bumpLensRound's own jsdoc says a row without `detail` still counts as
// completed; a rule keyed on "not APPROVED" would distrust every legacy row.
// The head here is one the recorded round did NOT review (its parent), so the
// pre-existing rules resolve the ordinary delta — the new rule must leave it.
{
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  const identity = await identityAt(r.dir, r.c2);
  const row = incompleteRow(r.c1, identity, 2);
  delete (row as { detail?: string }).detail;
  writeLedger(r.ledgerFile, [{ ...row, passed: true }]);
  try {
    await withEnv({ PI_ENSEMBLE_LENS_INCOMPLETE_FULL: undefined }, async () => {
      const since = await resolveDeltaSince(branch, undefined, r.dir);
      assert(
        since === r.c1,
        `(on) a legacy detail-less row still resolves its delta (got ${String(since)?.slice(0, 12)}, want ${r.c1.slice(0, 12)})`,
      );
      const e = await decideEmptyDelta({
        cwd: r.dir,
        branch,
        head: r.c1,
        base: "origin/main",
      });
      assert(
        e.kind === "noReview",
        `(on) and the same-head answer on such a row is the pre-existing one, not the incomplete rule (kind ${e.kind})`,
      );
    });
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// ── (7) the row the rule ignores is still the round counter's row ────────────
// L5: skipping an incomplete row as a BASE must not take it out of the budget.
// Two consecutive all-blocked rounds keep one row per (branch, kind) whose
// round is HELD and whose incompleteRuns grows.
{
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  const identity = await identityAt(r.dir, r.c2);
  writeLedger(r.ledgerFile, [incompleteRow(r.c2, identity, 1)]);
  try {
    await withEnv({ PI_ENSEMBLE_LENS_INCOMPLETE_FULL: undefined }, async () => {
      const first = readLedgerAt(r.ledgerFile);
      const rows = first.filter((e) => e.branch === branch && e.kind === "lens");
      assert(rows.length === 1, "(L5) one lens row on the branch");
      assert(rows[0]?.incompleteRuns === 1, "(L5) and it counts its one incomplete run");
      const stored = latestEntry(first, branch, "lens");
      assert(
        stored?.headSha === r.c2,
        "(L5) the row's headSha is whatever the round that wrote it resolved (the counter's row is unchanged by this switch)",
      );
    });
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

/** The identity the REAL writer computes at `sha` (the carry rule needs both). */
async function identityAt(dir: string, sha: string): Promise<Record<string, unknown>> {
  await execp(`git checkout -q ${sha}`, { cwd: dir });
  const w = await workingTreePatchId(execp, dir, { digest: true });
  await execp(`git checkout -q ${branch}`, { cwd: dir });
  if (!w.patchId || !w.diffSha256) throw new Error(`writer produced no identity at ${sha}`);
  return { patchId: w.patchId, diffSha256: w.diffSha256 };
}

/**
 * The PRE-FIX row an all-blocked round left on the ledger: `REVIEW_INCOMPLETE`
 * carrying the real head it was invoked at, and no verdict. Hand-built rather
 * than driven, because the current writer no longer produces this shape — see the
 * (3) arm for why the off arm must read the old one.
 */
function incompleteRow(
  headSha: string,
  identity: Record<string, unknown>,
  round: number,
): Record<string, unknown> {
  return {
    branch,
    kind: "lens",
    ...identity,
    passed: false,
    at: 1000,
    detail: "REVIEW_INCOMPLETE",
    hasCritical: false,
    headSha,
    round,
    incompleteRuns: 1,
  };
}

console.log(`\nexit ${exit}`);
process.exit(exit);
