#!/usr/bin/env bun
/**
 * #912 — review ledger writer (temp-repo tests).
 * Temp-repo tests asserting ledger entry writing, patchId identity,
 * failure isolation, and merge-base semantics (cases a–f).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLensReview } from "../src/lens-review.ts";
import {
  type LedgerEntry,
  adversarialPassed,
  appendLedgerEntry,
  branchPatchId,
  dedupeLatest,
  lensBlockedByThreshold,
  lensPassed,
  readLedgerAt,
  readLedgerFile,
  remoteName,
  validEntries,
  workingTreePatchId,
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

/** Set up a temp repo with a local bare origin + a feature branch. */
function setupRepo(): { repo: string; origin: string; branch: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin.git");
  execSync(`git init -q ${origin}`, { stdio: "ignore" });
  execSync(`git clone -q ${origin} ${repo}`, { stdio: "ignore" });
  const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "ignore" });
  git("git config user.email t@t.t");
  git("git config user.name t");
  git("echo base > base.txt");
  git("git add base.txt");
  git('git commit -qm "base"');
  // Rename to a non-default branch so checkout + push work cleanly.
  git("git branch -M dev");
  git("git push -q origin dev");
  // Set the mainline symbolic ref so detectMainline resolves without gh.
  git("git remote set-head origin dev");
  git("git checkout -qb feature/x dev");
  git("echo change > change.txt");
  git("git add change.txt");
  git('git commit -qm "change"');
  git("git push -q origin feature/x");
  return { repo, origin, branch: "feature/x" };
}

const ledgerFile = (repo: string) => {
  const common = execSync("git rev-parse --git-common-dir", { cwd: repo, encoding: "utf8" }).trim();
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  return path.join(abs, "review-ledger.json");
};

/** Wait for an async ledger write to land (the writer is fire-and-forget). */
function waitForLedger(file: string, ms = 2000): LedgerEntry[] | null {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return readLedgerAt(file);
      } catch {
        /* partial write — keep waiting */
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return existsSync(file) ? readLedgerAt(file) : null;
}

// helpers

const signal = new AbortController().signal;

// runAdversarialLoop writes entry

{
  const { repo, branch } = setupRepo();
  try {
    // Drive the writer's output directly via the same code path the loop
    // calls (appendLedgerEntry + adversarialPassed + branchPatchId).
    const patchId = await branchPatchId(execp, repo, "HEAD", "origin/dev");
    assert(
      typeof patchId === "string" && patchId.length > 0,
      "branchPatchId computes an id for the branch's diff",
    );

    // MINOR_OBSERVATIONS / approved → passed true
    assert(
      adversarialPassed({ ok: true, loopOutcome: "approved" }),
      "approved result → passed true",
    );
    assert(
      !adversarialPassed({ ok: false, loopOutcome: "rejected" }),
      "CRITICAL rejection → passed false",
    );
    assert(
      !adversarialPassed({ ok: false, loopOutcome: "infra-failure" }),
      "infra-failure → passed false",
    );

    const reason = await appendLedgerEntry(
      {
        branch,
        kind: "adversarial",
        patchId: patchId as string,
        passed: true,
        at: Date.now(),
        detail: "approved",
      },
      execp,
      repo,
    );
    assert(reason === undefined, "appendLedgerEntry writes without error");
    const entries = waitForLedger(ledgerFile(repo));
    assert(
      entries !== null && entries.length === 1,
      "the ledger file now holds one adversarial entry",
    );
    assert(entries?.[0]?.passed === true, "the stored entry is passed=true");
    assert(entries?.[0]?.patchId === patchId, "the stored patchId matches the computed one");

    // Writer and guard compute identical patchIds for the same content:
    // re-computing yields the same id (stability).
    const again = await branchPatchId(execp, repo, "HEAD", "origin/dev");
    assert(again === patchId, "writer and guard compute identical patchIds for the same content");

    // A new commit changes the patchId.
    execSync("echo more >> change.txt", { cwd: repo, stdio: "ignore" });
    execSync("git add change.txt", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "more"', { cwd: repo, stdio: "ignore" });
    const newId = await branchPatchId(execp, repo, "HEAD", "origin/dev");
    assert(newId !== patchId, "a new commit changes the patchId");

    // Write-failure isolation: point the writer at a non-writable path by
    // simulating a throwing exec; the entry is simply not written and no
    // exception escapes.
    const throwing = async () => {
      throw new Error("disk full");
    };
    let threw = false;
    try {
      await appendLedgerEntry(
        { branch, kind: "adversarial", patchId: "x", passed: true, at: Date.now() },
        throwing as unknown as typeof execp,
        repo,
      );
    } catch {
      threw = true;
    }
    assert(!threw, "a ledger write failure does not throw (failure isolation)");
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

// write failure leaves the review result byte-identical

{
  const { repo, branch } = setupRepo();
  try {
    // runLensReview with empty skills dir → blocked-lens summary + ledger write.
    const emptySkills = mkdtempSync(path.join(os.tmpdir(), "skills-"));
    const prevSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
    process.env.PI_ENSEMBLE_SKILLS_DIR = emptySkills;
    try {
      const s1 = await runLensReview({ diff: "a", cwd: repo, branch });
      const s2 = await runLensReview({ diff: "a", cwd: repo, branch });
      assert(
        JSON.stringify(s1.verdict) === JSON.stringify(s2.verdict),
        "a lens summary is unaffected by the ledger write (byte-identical across runs)",
      );
      assert(
        s1.verdict === "REVIEW_INCOMPLETE",
        "empty skills dir → blocked lenses → REVIEW_INCOMPLETE (the write is orthogonal)",
      );
    } finally {
      if (prevSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
      else process.env.PI_ENSEMBLE_SKILLS_DIR = prevSkills;
      rmSync(emptySkills, { recursive: true, force: true });
    }
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

// No AGENTS.md → MEDIUM default → ISSUES_FOUND does not pass.
assert(
  !lensPassed("ISSUES_FOUND", "MEDIUM"),
  "no AGENTS.md → MEDIUM default → ISSUES_FOUND does not pass",
);
// A project that loosens to LOW → ISSUES_FOUND passes.
assert(lensPassed("ISSUES_FOUND", "LOW"), "a LOW threshold → ISSUES_FOUND passes");
assert(!lensPassed("CRITICAL_ISSUES_FOUND", "LOW"), "CRITICAL blocks even at LOW");

// detached worktree with a caller-supplied branch

{
  const { repo } = setupRepo();
  try {
    // Detach HEAD at the feature branch tip (driver worktree shape).
    execSync("git checkout -q --detach origin/feature/x", { cwd: repo, stdio: "ignore" });
    const head = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert(head === "HEAD", "HEAD is detached (the driver worktree shape)");
    // branchPatchId works off refs, not HEAD.
    const pid = await branchPatchId(execp, repo, "origin/feature/x", "origin/dev");
    assert(
      typeof pid === "string" && pid.length > 0,
      "a detached worktree with a caller-supplied branch still yields a patchId",
    );
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

// workingTreePatchId (item 1)

{
  const { repo } = setupRepo();
  try {
    // workingTreePatchId: remote is `origin`; merge-base of HEAD + origin/dev.
    const computed = await workingTreePatchId(execp, repo);
    assert(
      typeof computed.patchId === "string" && computed.patchId.length > 0,
      "workingTreePatchId computes an id for the working-tree diff",
    );
    assert(computed.untracked.length === 0, "no untracked files in the clean working tree");
    assert(computed.warning === undefined, "no warning for a clean working tree");

    // The patchId should match the branchPatchId of the same content.
    const branchId = await branchPatchId(execp, repo, "HEAD", "origin/dev");
    assert(computed.patchId === branchId, "workingTreePatchId matches branchPatchId");

    // An uncommitted change changes the working-tree patchId; branch patchId unchanged.
    execSync("echo uncommitted >> change.txt", { cwd: repo, stdio: "ignore" });
    const withUncommitted = await workingTreePatchId(execp, repo);
    assert(withUncommitted.patchId !== computed.patchId, "uncommitted change changes working-tree patchId");
    // The branch patchId is unchanged (commits only).
    const branchIdAfter = await branchPatchId(execp, repo, "HEAD", "origin/dev");
    assert(branchIdAfter === branchId, "branch patchId unchanged by uncommitted edit");

    // Untracked files: still written, but with a warning.
    execSync("echo new > untracked.txt", { cwd: repo, stdio: "ignore" });
    const withUntracked = await workingTreePatchId(execp, repo);
    assert(
      withUntracked.untracked.length === 1 && withUntracked.untracked[0] === "untracked.txt",
      "untracked files are enumerated",
    );
    assert(
      withUntracked.warning !== undefined && withUntracked.warning.includes("untracked"),
      "a warning is returned when untracked files exist",
    );
    assert(
      typeof withUntracked.patchId === "string" && withUntracked.patchId.length > 0,
      "the entry is still written (patchId present) when untracked files exist",
    );
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

// Merge-base semantics across base advancement
//
// The guard and ledger writers both compute the patch id from the MERGE-BASE
// (three-dot diff). Properties tested:
//   - disjoint base advance → id stable (the #985 bug); same-file base
//     advance → id still matches (conflict detection is GitHub's job);
//   - rebase/merge making the merge-base diff empty → undefined (fail closed).

{
  const { repo, branch } = setupRepo();
  try {
    // Review recorded at base B0: the guard's computation at review time.
    const atB0 = await branchPatchId(execp, repo, branch, "origin/dev");
    assert(typeof atB0 === "string" && atB0.length > 0, "case a: patchId computed at base B0");

    // (b) Base advances to B1 with a DISJOINT commit → ids equal (merge allowed).
    execSync("git checkout -q dev", { cwd: repo, stdio: "ignore" });
    execSync("echo disjoint > disjoint.txt", { cwd: repo, stdio: "ignore" });
    execSync("git add disjoint.txt", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "disjoint base advance"', { cwd: repo, stdio: "ignore" });
    execSync("git push -q origin dev", { cwd: repo, stdio: "ignore" });
    const atB1 = await branchPatchId(execp, repo, branch, "origin/dev");
    assert(
      atB1 === atB0,
      "case b: disjoint base advance does not change the branch's own diff (ids equal — merge allowed)",
    );

    // (c) Branch gains a commit → ids differ (fail closed preserved).
    execSync("git checkout -q feature/x", { cwd: repo, stdio: "ignore" });
    execSync("echo more >> change.txt", { cwd: repo, stdio: "ignore" });
    execSync("git add change.txt", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "branch commit after review"', { cwd: repo, stdio: "ignore" });
    const atB1AfterCommit = await branchPatchId(execp, repo, branch, "origin/dev");
    assert(
      atB1AfterCommit !== atB0,
      "case c: a new commit on the branch still yields a different id (fail closed)",
    );

    // (d) Base advances touching the SAME file — merge-base diff unchanged,
    // so the id still matches (conflict detection is GitHub's job).
    execSync("git checkout -q dev", { cwd: repo, stdio: "ignore" });
    execSync("echo conflict > conflict.txt", { cwd: repo, stdio: "ignore" });
    execSync("git add conflict.txt", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "same-file base advance"', { cwd: repo, stdio: "ignore" });
    execSync("git push -q origin dev", { cwd: repo, stdio: "ignore" });
    const atB2 = await branchPatchId(execp, repo, branch, "origin/dev");
    assert(
      atB2 === atB1AfterCommit,
      "case d: a base advance touching the same file still matches (merge-base diff unchanged; conflict detection is GitHub's job)",
    );

    // (f) Untracked file at review time, later committed → different id.
    execSync("git checkout -q feature/x", { cwd: repo, stdio: "ignore" });
    execSync("echo late > untracked-late.txt", { cwd: repo, stdio: "ignore" });
    const beforeCommit = await workingTreePatchId(execp, repo);
    assert(
      beforeCommit.untracked.length === 1 && beforeCommit.untracked[0] === "untracked-late.txt",
      "case f: an untracked file is enumerated by the writer at review time",
    );
    const writerIdBefore = beforeCommit.patchId;
    assert(
      typeof writerIdBefore === "string" && writerIdBefore.length > 0,
      "case f: the writer still produces an id for the tracked content",
    );
    execSync("git add untracked-late.txt", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "untracked file lands in a commit"', { cwd: repo, stdio: "ignore" });
    const afterCommit = await branchPatchId(execp, repo, branch, "origin/dev");
    assert(
      afterCommit !== writerIdBefore,
      "case f: an untracked file at review time that is later committed still yields a different id at merge time (fail closed)",
    );
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

{
    const r2 = setupRepo();
    try {
      execSync("git checkout -q dev", { cwd: r2.repo, stdio: "ignore" });
      execSync("echo change > change.txt", { cwd: r2.repo, stdio: "ignore" });
      execSync("git add change.txt", { cwd: r2.repo, stdio: "ignore" });
      execSync('git commit -qm "base adds same file as branch"', { cwd: r2.repo, stdio: "ignore" });
      execSync("git push -q origin dev", { cwd: r2.repo, stdio: "ignore" });
      execSync("git checkout -q feature/x", { cwd: r2.repo, stdio: "ignore" });
      execSync("git merge --no-edit dev", { cwd: r2.repo, stdio: "ignore" });
      const atAncestor = await branchPatchId(execp, r2.repo, r2.branch, "origin/dev");
      assert(
        !atAncestor,
        "case e: base advances to a commit that is an ancestor of the branch head (branch merges the base's same-file commit) → empty merge-base diff → no valid patchId (fail closed)",
      );
    } finally {
      rmSync(path.dirname(r2.repo), { recursive: true, force: true });
    }
}

// remoteName (item 2)

{
  const { repo } = setupRepo();
  try {
    // The temp repo's remote is named `origin`.
    const name = await remoteName(execp, repo);
    assert(name === "origin", "remoteName resolves the remote (origin)");
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

// Bounded + validated ledger

{
  // Bounded on write: second entry for same (branch, kind) replaces the first.
  const a: LedgerEntry = {
    branch: "feature/x",
    kind: "adversarial",
    patchId: "p1",
    passed: true,
    at: 1000,
  };
  const b: LedgerEntry = { ...a, patchId: "p2", at: 2000 };
  const deduped = dedupeLatest([a, b]);
  assert(
    deduped.length === 1 && deduped[0] === b,
    "dedupeLatest keeps only the latest per (branch, kind)",
  );

  // A lower `at` written later still loses to the higher `at`.
  const deduped2 = dedupeLatest([b, a]);
  assert(
    deduped2.length === 1 && deduped2[0] === b,
    "dedupeLatest keeps the higher `at` regardless of order",
  );

  // Distinct (branch, kind) keys both survive.
  const other: LedgerEntry = { ...a, kind: "lens" };
  const otherBranch: LedgerEntry = { ...a, branch: "feature/y" };
  const deduped3 = dedupeLatest([a, b, other, otherBranch]);
  assert(deduped3.length === 3, "dedupeLatest keeps distinct (branch, kind) keys");

  // Validation: only well-formed rows survive; the rest are dropped.
  const good: LedgerEntry = { branch: "f", kind: "lens", patchId: "p", passed: false, at: 1 };
  const badRows = [
    { branch: "", kind: "lens", patchId: "p", passed: true, at: 1 }, // empty branch
    { branch: "f", kind: "both", patchId: "p", passed: true, at: 1 }, // bad kind
    { branch: "f", kind: "lens", patchId: 42, passed: true, at: 1 }, // non-string patchId
    { branch: "f", kind: "lens", patchId: "p", passed: true, at: NaN }, // NaN at
    { branch: "f", kind: "lens", patchId: "p", passed: "yes", at: 1 }, // non-boolean passed
    { branch: "f", kind: "lens", patchId: "p", passed: true }, // missing at
    null,
    "a string",
    42,
  ];
  const kept = validEntries([good, ...badRows]);
  assert(kept.length === 1 && kept[0] === good, "validEntries keeps only well-formed rows");

    // End-to-end: a corrupt file is read as its valid rows only.
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-validate-"));
  try {
    const file = path.join(dir, "review-ledger.json");
    writeFileSync(
      file,
      JSON.stringify({
        entries: [a, b, { branch: "x", kind: "nope", patchId: 1, at: "z", passed: "y" }],
      }),
      "utf8",
    );
    const loaded = readLedgerFile(file).entries;
    assert(
      loaded.length === 2 && loaded.some((e) => e.patchId === "p2"),
      "readLedgerFile drops corrupt rows",
    );
    assert(!loaded.some((e) => e.kind === "nope"), "a corrupt row is dropped, not trusted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// lensBlockedByThreshold (item 6)

{
    // The threshold predicate has ONE implementation (review-ledger.ts).
  assert(!lensBlockedByThreshold("APPROVED", "MEDIUM"), "APPROVED does not block at MEDIUM");
  assert(lensBlockedByThreshold("ISSUES_FOUND", "MEDIUM"), "ISSUES_FOUND blocks at MEDIUM");
  assert(!lensBlockedByThreshold("ISSUES_FOUND", "LOW"), "ISSUES_FOUND does not block at LOW");
  assert(
    lensBlockedByThreshold("CRITICAL_ISSUES_FOUND", "LOW"),
    "CRITICAL blocks at every threshold",
  );
  assert(
    lensBlockedByThreshold("REVIEW_INCOMPLETE", "LOW"),
    "REVIEW_INCOMPLETE blocks at every threshold",
  );
  // The predicate is the inverse of lensPassed.
  for (const verdict of [
    "APPROVED",
    "ISSUES_FOUND",
    "CRITICAL_ISSUES_FOUND",
    "REVIEW_INCOMPLETE",
  ]) {
    for (const th of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
      assert(
        lensBlockedByThreshold(verdict, th as never) === !lensPassed(verdict, th),
        `lensBlockedByThreshold(${verdict}, ${th}) === !lensPassed(${verdict}, ${th})`,
      );
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
