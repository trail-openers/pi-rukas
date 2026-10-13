#!/usr/bin/env bun
/**
 * #973 — the AUTOMATIC delta base (design decision 6).
 *
 * When no explicit `since` is given, a follow-up review on a branch
 * defaults its `since` to the branch's latest lens ledger entry's `headSha`
 * when that SHA is a strict ancestor of HEAD; otherwise the review is FULL.
 *
 * Covers (real git repos via `git init -q -b main`, lens children stubbed):
 *   - no ledger → full review
 *   - a ledger entry whose headSha is an ancestor of HEAD → delta over
 *     exactly that range
 *   - headSha not an ancestor (e.g. after a rebase) → full
 *   - headSha == HEAD → no-review (decision 4)
 *   - `full: true` → full
 *   - explicit `since` → that range
 *
 * Uses PI_ENSEMBLE_REVIEW_LEDGER_FILE for an isolated ledger. The mainline
 * (#1128) cases live in test-auto-delta-mainline.ts.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, execp, mergeMainFixture, mkRepo, writeLedger } from "./lib/auto-delta-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
  exit = 1;
  return false;
}

const { resolveDeltaSince, resolveReviewDiff } = await import("../src/lens-review-diff.ts");
const { runLensReview } = await import("../src/lens-review.ts");
const { renderSummary } = await import("../src/lens-review-format.ts");

const branch = "feature/work";

// (1) No ledger → full review
{
  const r = await mkRepo();
  try {
    await runLensReview({
      base: "main",
      head: "feature/work",
      cwd: r.dir,
      branch,
      lensChildFn: async () =>
        ({
          lens: "SECURITY",
          ok: true,
          ms: 0,
          startMs: Date.now(),
          findings: [],
          attempts: 1,
          blocked: false,
          summary: "clean",
        }) as never,
    });
    assert(true, "no ledger → full review (no crash)");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (2) Ledger entry whose headSha is an ancestor of HEAD → delta over that range
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c1, // c1 is an ancestor of c2 (HEAD)
      round: 1,
    },
  ]);
  try {
    const since = await resolveDeltaSince(branch, undefined, r.dir);
    eq(since, r.c1, "auto since resolves to the ledger entry's headSha (c1)");
    // Verify the diff covers exactly c1..c2
    const d = await resolveReviewDiff({
      base: "main",
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "ok", "delta review resolves to ok");
    if (d.kind === "ok") {
      eq(d.delta?.auto, true, "delta is marked auto");
      eq(d.delta?.since, r.c1, "delta since is the auto-resolved headSha");
      const expected = (await execp(`git diff ${r.c1}..${r.c2}`, { cwd: r.dir })).stdout;
      eq(d.diff, expected, "delta diff matches git diff c1..c2 byte-for-byte");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (3) headSha not an ancestor → full review
{
  const r = await mkRepo();
  // Create a divergent commit from c0, then use that as headSha in the ledger
  await execp(`git checkout -qb feature/diverged ${r.c0}`, { cwd: r.dir });
  writeFileSync(path.join(r.dir, "diverged.txt"), "div\n");
  await execp("git add diverged.txt && git commit -q -m div", {
    cwd: r.dir,
    shell: "/bin/bash",
  });
  const diverged = (await execp("git rev-parse HEAD", { cwd: r.dir })).stdout.trim();
  await execp("git checkout -q feature/work", { cwd: r.dir });
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: diverged, // not an ancestor of c2
      round: 1,
    },
  ]);
  try {
    const since = await resolveDeltaSince(branch, undefined, r.dir);
    eq(since, undefined, "non-ancestor headSha → no auto since (full review)");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (4) headSha == HEAD → no-review (decision 4)
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2, // == HEAD (c2)
      round: 1,
    },
  ]);
  try {
    const since = await resolveDeltaSince(branch, undefined, r.dir);
    eq(since, undefined, "headSha == HEAD → no auto since (sha === head → full/no-review)");
    // When headSha == HEAD, the delta is empty → noReview
    const d = await resolveReviewDiff({
      since: r.c2,
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "noReview", "headSha == HEAD → no-review outcome");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (4b) no-review outcome at the runLensReview level (the roster is the
// INSTALLED skills dir, which always resolves in this environment, so the
// run reaches the fan-out with stubbed lens children): the summary carries
// noReview: true, and renderSummary says "NO REVIEW", never "APPROVED"
// (a no-review outcome must not look like an approval).
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2, // == HEAD → auto since == head → empty delta
      round: 1,
    },
  ]);
  try {
    const s = await runLensReview({
      base: "main",
      head: "feature/work",
      cwd: r.dir,
      branch,
      lensChildFn: async () => {
        throw new Error("lensChildFn must not be called on a no-review run");
      },
    });
    assert(s.noReview === true, "no-review summary carries noReview: true");
    assert(
      s.noReview === true && s.deltaReview?.since === r.c2,
      "…with the since ref carried on deltaReview",
    );
    assert(
      renderSummary(s, 4).startsWith("NO REVIEW"),
      "renderSummary says 'NO REVIEW …' for a no-review outcome",
    );
    assert(
      !/verdict.*APPROVED/.test(renderSummary(s, 4)),
      "…and never prints an APPROVED verdict for it",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (5) full: true → full review
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c1,
      round: 1,
    },
  ]);
  try {
    const d = await resolveReviewDiff({
      full: true,
      base: "main",
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "ok", "full: true → full review resolves to ok");
    if (d.kind === "ok") {
      eq(d.delta, undefined, "full: true → no delta (full review)");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (#1039) Legacy entry whose headSha is a branch name (non-SHA) → full
// review (treated as unknown, never matched by string or passed to git
// as a commit ref).
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: branch, // a branch name, not a 40-char SHA (pre-#1039 legacy)
      round: 1,
    },
  ]);
  try {
    const since = await resolveDeltaSince(branch, undefined, r.dir);
    eq(since, undefined, "legacy branch-name headSha → no auto since (full review, not delta)");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (6) Explicit since → that range
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c1,
      round: 1,
    },
  ]);
  try {
    // Explicit since = c0 (different from the auto c1)
    const d = await resolveReviewDiff({
      since: r.c0,
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "ok", "explicit since → delta review resolves to ok");
    if (d.kind === "ok") {
      eq(d.delta?.since, r.c0, "explicit since wins over auto");
      eq(d.delta?.auto, undefined, "explicit since is not marked auto");
      const expected = (await execp(`git diff ${r.c0}..${r.c2}`, { cwd: r.dir })).stdout;
      eq(d.diff, expected, "delta diff matches git diff c0..c2 byte-for-byte");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (7) A round after `merge main` (no fix) reviews no main-only hunks → no-review
{
  const r = await mergeMainFixture();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2,
      round: 1,
    },
  ]);
  try {
    const d = await resolveReviewDiff({ base: "main", head: "feature/work", branch, cwd: r.dir });
    assert(
      d.kind === "noReview",
      "merge-of-main round (no fix) → no-review, main-only hunks excluded",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (8) A fix commit after the merge: only the fix's hunk is reviewed
{
  const r = await mergeMainFixture();
  writeFileSync(path.join(r.dir, "third.txt"), "three\n");
  await execp("git add third.txt && git commit -q -m c3", { cwd: r.dir, shell: "/bin/bash" });
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2,
      round: 1,
    },
  ]);
  try {
    const d = await resolveReviewDiff({ base: "main", head: "feature/work", branch, cwd: r.dir });
    assert(d.kind === "ok", "fix-after-merge round resolves to ok");
    if (d.kind === "ok") {
      assert(
        d.diff.includes("third.txt"),
        "fix-after-merge round reviews the fix hunk (third.txt)",
      );
      assert(!d.diff.includes("main-only.txt"), "fix-after-merge round excludes main-only.txt");
      assert(
        !d.diff.includes("first.txt") && !d.diff.includes("second.txt"),
        "fix-after-merge round excludes already-reviewed c1/c2 hunks",
      );
      eq(d.delta?.auto, true, "fix-after-merge round is an auto delta");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (9) full: true over the same history reviews everything, including merged hunks
{
  const r = await mergeMainFixture();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2,
      round: 1,
    },
  ]);
  try {
    const d = await resolveReviewDiff({
      full: true,
      base: "main",
      head: "feature/work",
      branch,
      cwd: r.dir,
    });
    assert(d.kind === "ok", "full: true over merged history → ok");
    if (d.kind === "ok") {
      assert(
        d.diff.includes("first.txt") && d.diff.includes("second.txt"),
        "full: true includes every branch hunk (already-reviewed c1/c2 too)",
      );
      eq(d.delta, undefined, "full: true → no delta");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
