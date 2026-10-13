#!/usr/bin/env bun
/**
 * #1128 — the automatic delta's MAINLINE handling: a bare review (no `base`)
 * resolves the mainline itself, and a fallback to the two-dot range is always
 * disclosed, never silent. Split out of test-auto-delta-base.ts (500-line cap).
 *
 * Covers (real git repos via lib/auto-delta-fixture.ts):
 *   - bare review after `merge main` → mainline auto-resolved, main hunks excluded
 *   - bare review with no resolvable mainline → two-dot fallback, disclosed
 *   - the unparseable-diff predicate behind that fallback
 *
 * Uses PI_ENSEMBLE_REVIEW_LEDGER_FILE for an isolated ledger.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, execp, mergeMainFixture, writeLedger } from "./lib/auto-delta-fixture.ts";

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

const { resolveReviewDiff } = await import("../src/lens-review-diff.ts");

const branch = "feature/work";

// (10) A BARE review (no base) after `merge main` resolves the mainline itself
// (origin/HEAD → origin/main) and excludes main's hunks like an explicit base.
{
  const r = await mergeMainFixture();
  await execp(
    "git update-ref refs/remotes/origin/main main && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main",
    {
      cwd: r.dir,
      shell: "/bin/bash",
    },
  );
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
    const d = await resolveReviewDiff({ branch, head: "feature/work", cwd: r.dir });
    assert(d.kind === "ok", "bare review after merge main → ok");
    if (d.kind === "ok") {
      assert(
        !d.diff.includes("main-only.txt"),
        "bare review excludes main-only.txt (mainline auto-resolved)",
      );
      assert(d.diff.includes("third.txt"), "bare review reviews the fix hunk (third.txt)");
      eq(d.delta?.fallback, undefined, "bare review with a resolved mainline records no fallback");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (11) A bare review with NO resolvable mainline falls back to the two-dot
// range and says so: the fallback is recorded, and a non-empty range is never
// reported as no-review.
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
    const d = await resolveReviewDiff({ branch, head: "feature/work", cwd: r.dir });
    assert(d.kind === "ok", "bare review with no mainline ref → ok (two-dot), never noReview");
    if (d.kind === "ok") {
      assert(
        typeof d.delta?.fallback === "string" && d.delta.fallback.length > 0,
        "no-mainline fallback is recorded on the delta",
      );
      assert(
        d.diff.includes("main-only.txt"),
        "two-dot fallback covers the merged main hunks (disclosed, not hidden)",
      );
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (12) A non-empty diff that parses to no file sections is unreadable — the
// predicate behind the fallback (never an empty / no-review outcome).
{
  const { unparseable } = await import("../src/review-delta-hunks.ts");
  eq(
    unparseable("garbage without headers\n"),
    true,
    "non-empty diff with no file sections is unparseable",
  );
  eq(unparseable(""), false, "empty diff is not unparseable (it is a genuine empty delta)");
  eq(unparseable("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"), false, "a real diff parses");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
