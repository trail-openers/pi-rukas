#!/usr/bin/env bun
/**
 * #1134 — the integrated PR diff is three-dot (merge base), so a base that
 * moves after the branch is cut must not appear in the lens-review diff.
 *
 * Two-dot `origin/<base>..origin/<branch>` compares tip against tip: every
 * commit the base gained since the branch was cut shows up as a REVERSAL,
 * and lenses report it as CRITICAL findings against code the PR never
 * touched. This fixture builds a real bare remote, cuts a branch, advances
 * the base on origin, fetches, and asserts what `readIntegratedDiff` (the
 * driver's lens-review read) returns.
 *
 * Fixtures:
 *   (a) the base's new commit touches an UNRELATED file;
 *   (b) the base's new commit touches a file the branch ALSO changes.
 *   (c) an UNCHANGED branch: emptiness must not depend on whether the base moved.
 *
 * A control assertion runs the two-dot range by hand to prove each fixture
 * really reproduces the bug — a fixture that never fails the old code proves
 * nothing.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readIntegratedDiff } from "../src/work-driver-diff.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileP("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout;

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=T"];
const commit = async (cwd: string, msg: string) => {
  await git(cwd, "add", "-A");
  await git(cwd, ...IDENT, "commit", "-qm", msg);
};

/**
 * A bare origin seeded with `main` (base.txt + other.txt), and a working clone
 * `repo` whose remote-tracking refs (incl. origin/HEAD → main) are set by the
 * clone itself, exactly as on a real host.
 */
async function seedRemote(root: string): Promise<{ remote: string; seed: string; repo: string }> {
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const repo = path.join(root, "repo");
  await git(root, "init", "-q", "--bare", "--initial-branch=main", remote);
  mkdirSync(seed);
  await git(seed, "init", "-q", "--initial-branch=main");
  writeFileSync(path.join(seed, "base.txt"), "line1\nline2\nline3\n");
  writeFileSync(path.join(seed, "other.txt"), "other\n");
  await git(seed, "add", "-A");
  await commit(seed, "base");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "origin", "main");
  await git(root, "clone", "-q", remote, repo);
  return { remote, seed, repo };
}

/** Cut `feature/x` in repo with `edit`, push it, then advance main in seed. */
async function cutThenAdvanceBase(
  fx: { seed: string; repo: string },
  branchEdit: () => Promise<void>,
  baseEdit: () => Promise<void>,
  branch: string,
) {
  await git(fx.repo, "checkout", "-qb", branch);
  await branchEdit();
  await commit(fx.repo, "branch change");
  await git(fx.repo, "push", "-q", "origin", branch);
  await baseEdit();
  await commit(fx.seed, "base moved");
  await git(fx.seed, "push", "-q", "origin", "main");
  await git(fx.repo, "fetch", "-q", "origin");
}

async function withFixture(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-diff-base-moved-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (a) base commit touches an unrelated file
// ---------------------------------------------------------------------------
await withFixture(async (root) => {
  const fx = await seedRemote(root);
  await cutThenAdvanceBase(
    fx,
    async () => writeFileSync(path.join(fx.repo, "feature.txt"), "feature\n"),
    async () => writeFileSync(path.join(fx.seed, "other.txt"), "other\nbase-new\n"),
    "feature/a",
  );

  // Control: the two-dot range really does reverse the base's commit.
  const twoDot = await git(fx.repo, "diff", "origin/main..origin/feature/a");
  assert(
    /other\.txt/.test(twoDot) && /-base-new/.test(twoDot),
    "(a) control: the two-dot range reverses the base's unrelated commit (the bug reproduces)",
  );

  const r = await readIntegratedDiff(fx.repo, "feature/a");
  assert(r.ok === true, "(a) readIntegratedDiff succeeds after the base advanced");
  assert(
    r.ok === true && /\+feature/.test(r.diff) && /feature\.txt/.test(r.diff),
    "(a) the reviewed diff contains the branch's own change",
  );
  assert(
    r.ok === true && !/other\.txt/.test(r.diff) && !/base-new/.test(r.diff),
    "(a) the reviewed diff contains NO reversal of the base's new commit",
  );
});

// ---------------------------------------------------------------------------
// (b) base commit touches a file the branch ALSO changes (different lines)
// ---------------------------------------------------------------------------
await withFixture(async (root) => {
  const fx = await seedRemote(root);
  const lines = (...l: string[]) => `${l.join("\n")}\n`;
  await cutThenAdvanceBase(
    fx,
    async () =>
      writeFileSync(path.join(fx.repo, "base.txt"), lines("line1", "feature-line", "line3")),
    async () =>
      writeFileSync(path.join(fx.seed, "base.txt"), lines("base-advanced", "line2", "line3")),
    "feature/b",
  );

  const twoDot = await git(fx.repo, "diff", "origin/main..origin/feature/b");
  assert(
    /-base-advanced/.test(twoDot) || /\+line1/.test(twoDot),
    "(b) control: the two-dot range reverses the base's edit to the shared file (the bug reproduces)",
  );

  const r = await readIntegratedDiff(fx.repo, "feature/b");
  assert(
    r.ok === true && /\+feature-line/.test(r.diff),
    "(b) the reviewed diff contains the branch's own edit to the shared file",
  );
  assert(
    r.ok === true && !/base-advanced/.test(r.diff) && !/\+line1|-line1/.test(r.diff),
    "(b) the reviewed diff contains NO hunk from the base's edit to the same file",
  );
});

// ---------------------------------------------------------------------------
// (c) unchanged branch: emptiness is the same before and after the base moves
// ---------------------------------------------------------------------------
await withFixture(async (root) => {
  const fx = await seedRemote(root);
  await git(fx.repo, "checkout", "-qb", "feature/c");
  await git(fx.repo, "push", "-q", "origin", "feature/c");
  await git(fx.repo, "fetch", "-q", "origin");

  const before = await readIntegratedDiff(fx.repo, "feature/c");
  assert(
    before.ok === true && before.empty === true,
    "(c) unchanged branch is a confirmed-empty diff before the base moves",
  );

  writeFileSync(path.join(fx.seed, "other.txt"), "other\nbase-new\n");
  await commit(fx.seed, "base moved");
  await git(fx.seed, "push", "-q", "origin", "main");
  await git(fx.repo, "fetch", "-q", "origin");

  const after = await readIntegratedDiff(fx.repo, "feature/c");
  assert(
    after.ok === true && after.empty === true && after.diff === "",
    "(c) unchanged branch is STILL a confirmed-empty diff after the base moved (no phantom reversal)",
  );
});

console.log(`\nexit ${exit}`);
process.exit(exit);
