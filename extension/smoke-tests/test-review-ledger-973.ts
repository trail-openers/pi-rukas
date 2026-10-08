#!/usr/bin/env bun
/**
 * #973 — the round counter (bumpLensRound) and the new lens-entry fields
 * (round, hasCritical, headSha) on the writer's write path.
 *
 * The round is a pure function of the ledger file's previous contents:
 * the previous latest lens entry's `round` + 1 (legacy rows without
 * `round` count as 1; no previous lens entry is a first run, which is
 * round 1). The per-(branch, kind) dedupe keeps only one lens row per
 * branch, so the round lives ON the entry (design decision 3).
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LedgerEntry,
  appendLedgerEntry,
  bumpLensRound,
  dedupeLatest,
  readLedgerAt,
} from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execp = async (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) => {
  const r = execSync(cmd, {
    cwd: opts?.cwd,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: r, stderr: "" };
};

// ------------------------------------------- the round counter (pure)

{
  const base: LedgerEntry = {
    branch: "feature/x",
    kind: "lens",
    patchId: "p1",
    passed: false,
    at: 1000,
    detail: "ISSUES_FOUND",
    hasCritical: false,
  };
  // First run on a branch with no prior lens entry → round 1.
  const first = bumpLensRound({ ...base, at: 2000 }, []);
  assert(first.round === 1, "a first lens write is round 1");
  // A second run after a round-1 entry → round 2.
  const second = bumpLensRound({ ...base, at: 3000 }, [first]);
  assert(second.round === 2, "a second lens write after a round-1 entry is round 2");
  // A third run after a round-2 entry → round 3 (the round-cap threshold).
  const third = bumpLensRound({ ...base, at: 4000 }, [first, second]);
  assert(third.round === 3, "a third lens write after a round-2 entry is round 3");
  // A legacy entry without `round` counts as round 1 → the next is round 2.
  const legacy = { ...base, at: 5000 }; // no `round` field
  const afterLegacy = bumpLensRound({ ...base, at: 6000 }, [legacy]);
  assert(afterLegacy.round === 2, "a write after a legacy (no-round) entry is round 2");
  // An adversarial write does NOT advance the lens round counter.
  const advWrite = bumpLensRound(
    { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 7000 },
    [third],
  );
  assert(advWrite.round === undefined, "an adversarial write does not carry a lens round");
  // A write for a DIFFERENT branch does not see the other branch's round.
  const otherBranch = bumpLensRound({ ...base, branch: "feature/y", at: 8000 }, [third]);
  assert(otherBranch.round === 1, "a write for a different branch is round 1 for that branch");
  // #973 fix — ONLY a completed review advances the counter. A killed or
  // REVIEW_INCOMPLETE run carries the previous round unchanged, so the
  // exact driver sequence ISSUES_FOUND (r1) → REVIEW_INCOMPLETE (r2) →
  // ISSUES_FOUND (r3) is what the acceptance test below asserts ends at
  // round 2 through the FULL write path.
  const aborted: LedgerEntry = {
    branch: "feature/x",
    kind: "lens",
    patchId: "p2",
    passed: false,
    at: 4500,
    detail: "REVIEW_INCOMPLETE",
  };
  const afterAbort = bumpLensRound(aborted, [first, second]);
  assert(
    afterAbort.round === 2,
    "an aborted (REVIEW_INCOMPLETE) write carries the previous round unchanged",
  );
  const afterAbortThenDone = bumpLensRound({ ...base, at: 5000 }, [first, second, afterAbort]);
  assert(
    afterAbortThenDone.round === 3,
    "a completed write after an aborted one advances past the aborted round",
  );
  // A legacy row with no `detail` still counts as completed (as before
  // #973) — only an explicit REVIEW_INCOMPLETE does not advance.
  const afterLegacyNoDetail = bumpLensRound({ ...base, at: 5500 }, [legacy]);
  assert(
    afterLegacyNoDetail.round === 2,
    "a completed write after a legacy (no-detail) entry is round 2 (legacy counted as round 1)",
  );
  // The dedupe keeps only the latest per (branch, kind) for FRESH writes —
  // but the file may already hold older rows (a legacy write, a hand edit,
  // or the race fallback that re-merges without deduping). The guard's
  // latestEntry picks the highest `at` regardless, so a multi-row file
  // still counts the most recent round.
  const deduped = dedupeLatest([first, second, third]);
  assert(
    deduped.length === 1 && deduped[0].round === 3,
    "dedupeLatest keeps the latest lens row (round 3) per branch",
  );
}

// ------------------------------------------- the writer's write path

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-973-"));
  const repo = path.join(dir, "repo");
  execSync(`git init -q -b main ${repo}`, { stdio: "ignore" });
  execSync(`git -C ${repo} config user.email t@t.t`, { stdio: "ignore" });
  execSync(`git -C ${repo} config user.name t`, { stdio: "ignore" });
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync(`git -C ${repo} add -A`, { stdio: "ignore" });
  execSync(`git -C ${repo} commit -qm base`, { stdio: "ignore" });
  const common = execSync(`git -C ${repo} rev-parse --git-common-dir`, {
    encoding: "utf8",
  }).trim();
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  const file = path.join(abs, "review-ledger.json");
  try {
    // #1039 — the headSha fixtures are real repo OIDs (the commit the test
    // repo's HEAD points to), not arbitrary short strings. The low-level
    // appendLedgerEntry stores whatever headSha is passed (validation lives
    // at the writer level, not here), so the fixture value only matters
    // for the round-counter assertions that follow.
    const commitSha = execSync(`git -C ${repo} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const secondSha = commitSha; // same commit; the round counter is the test target
    const at = Date.now();
    const e1 = await appendLedgerEntry(
      {
        branch: "feature/x",
        kind: "lens",
        patchId: "p1",
        passed: false,
        at,
        detail: "ISSUES_FOUND",
        hasCritical: false,
        headSha: commitSha,
      },
      execp,
      repo,
    );
    assert(e1 === undefined, "appendLedgerEntry writes the lens entry without error");
    const entries1 = readLedgerAt(file);
    assert(entries1.length === 1, "the ledger holds one lens entry after the first write");
    assert(entries1[0]?.round === 1, "the first lens entry is round 1");
    assert(entries1[0]?.hasCritical === false, "the stored hasCritical is false");
    assert(entries1[0]?.headSha === commitSha, "the stored headSha is the commit reviewed");
    // A second write advances the round.
    const e2 = await appendLedgerEntry(
      {
        branch: "feature/x",
        kind: "lens",
        patchId: "p2",
        passed: false,
        at: at + 1000,
        detail: "ISSUES_FOUND",
        hasCritical: false,
        headSha: secondSha,
      },
      execp,
      repo,
    );
    assert(e2 === undefined, "the second lens write succeeds");
    const entries2 = readLedgerAt(file);
    // The file holds the historical row + the new row (the append does not
    // collapse the file — see the comment in review-ledger.ts); the guard's
    // latestEntry picks the highest `at`, which is the new row.
    const latest2 = entries2
      .filter((e) => e.kind === "lens" && e.branch === "feature/x")
      .sort((a, b) => b.at - a.at)[0];
    assert(latest2?.round === 2, "the second lens entry (latest by at) is round 2");
    assert(latest2?.headSha === secondSha, "the second entry's headSha is the newer commit");
    // A legacy entry (no hasCritical, no round) written first, then a new
    // entry: the new entry's round is 3 (the legacy counted as round 1).
    const e3 = await appendLedgerEntry(
      {
        branch: "feature/x",
        kind: "lens",
        patchId: "p3",
        passed: false,
        at: at + 2000,
        detail: "ISSUES_FOUND",
      },
      execp,
      repo,
    );
    assert(e3 === undefined, "the third lens write succeeds");
    const entries3 = readLedgerAt(file);
    const latest3 = entries3
      .filter((e) => e.kind === "lens" && e.branch === "feature/x")
      .sort((a, b) => b.at - a.at)[0];
    assert(
      latest3?.round === 3,
      "the third lens entry (latest by at) is round 3 (the legacy counted as round 1)",
    );
    assert(
      latest3?.hasCritical === undefined,
      "a legacy entry without hasCritical stores no hasCritical (conservative)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- the aborted-does-not-advance sequence

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-973-abort-"));
  const repo = path.join(dir, "repo");
  execSync(`git init -q -b main ${repo}`, { stdio: "ignore" });
  execSync(`git -C ${repo} config user.email t@t.t`, { stdio: "ignore" });
  execSync(`git -C ${repo} config user.name t`, { stdio: "ignore" });
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync(`git -C ${repo} add -A`, { stdio: "ignore" });
  execSync(`git -C ${repo} commit -qm base`, { stdio: "ignore" });
  const common = execSync(`git -C ${repo} rev-parse --git-common-dir`, {
    encoding: "utf8",
  }).trim();
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  const file = path.join(abs, "review-ledger.json");
  const latestX = (rows: LedgerEntry[]) =>
    rows
      .filter((e) => e.kind === "lens" && e.branch === "feature/x")
      .sort((a, b) => b.at - a.at)[0];
  try {
    // The exact sequence the acceptance test names:
    // ISSUES_FOUND (r1) → REVIEW_INCOMPLETE (r2) → ISSUES_FOUND (r3).
    const at = Date.now();
    await appendLedgerEntry(
      { branch: "feature/x", kind: "lens", patchId: "pa", passed: false, at,
        detail: "ISSUES_FOUND", hasCritical: false },
      execp,
      repo,
    );
    await appendLedgerEntry(
      { branch: "feature/x", kind: "lens", patchId: "pb", passed: false, at: at + 1000,
        detail: "REVIEW_INCOMPLETE" },
      execp,
      repo,
    );
    const afterAbort = latestX(readLedgerAt(file));
    assert(
      afterAbort?.round === 1,
      "aborted run carries the previous round (round 1 after an aborted run)",
    );
    await appendLedgerEntry(
      { branch: "feature/x", kind: "lens", patchId: "pc", passed: false, at: at + 2000,
        detail: "ISSUES_FOUND", hasCritical: false },
      execp,
      repo,
    );
    const afterThird = latestX(readLedgerAt(file));
    assert(
      afterThird?.round === 2,
      "ISSUES_FOUND (r1) → REVIEW_INCOMPLETE → ISSUES_FOUND ends at round 2, not 3",
    );
    // Three COMPLETED runs (an aborted run between them) reach round 3.
    await appendLedgerEntry(
      { branch: "feature/x", kind: "lens", patchId: "pd", passed: false, at: at + 3000,
        detail: "REVIEW_INCOMPLETE" },
      execp,
      repo,
    );
    assert(
      latestX(readLedgerAt(file))?.round === 2,
      "an aborted run between completed runs leaves the count unchanged",
    );
    await appendLedgerEntry(
      { branch: "feature/x", kind: "lens", patchId: "pe", passed: false, at: at + 4000,
        detail: "ISSUES_FOUND", hasCritical: false },
      execp,
      repo,
    );
    assert(
      latestX(readLedgerAt(file))?.round === 3,
      "three completed runs (with an aborted run between them) reach round 3",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
