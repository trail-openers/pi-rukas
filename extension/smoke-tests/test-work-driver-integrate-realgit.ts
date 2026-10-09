#!/usr/bin/env bun
/** #287 — always-worktree against REAL git. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-commit.ts";
import { integrate, readDirtyPorcelain, restoreRepoRoot } from "../src/work-driver-integrate.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

// Shared fixture: bare origin + repo with one commit on main.
async function makeFixture(tmpPrefix: string, files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  const [originDir, repo, scratch] = ["origin.git", "repo", "scratch"].map((n) => path.join(root, n));
  mkdirSync(scratch, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  for (const [f, content] of Object.entries(files)) writeFileSync(path.join(repo, f), content);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  return { root, originDir, repo, scratch };
}

// ---- A+B+B2+C: branch setup, cherry-pick, resume, follow-up ----
{
  const { root, repo, scratch } = await makeFixture("pi-ens-realgit-", { "tracked.txt": "base\n" });
  try {
    const setup = await mechanizedBranchSetup(realExec, repo, 287, [287], [], "always worktree");
    const wt = setup.worktrees.default ?? "";
    assert(existsSync(wt), "real git: worktree exists on disk");
    assert(path.resolve(wt) !== path.resolve(repo), "real git: worktree is not the repo root");
    assert(
      (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() === "HEAD",
      "real git: worktree HEAD is DETACHED",
    );
    assert(
      (await git(wt, ["rev-parse", "HEAD"])).stdout.trim() === setup.baseSha,
      "real git: worktree is detached at baseSha",
    );
    {
      const exists = await git(repo, ["rev-parse", "--verify", setup.branchName]).then(
        () => true,
        () => false,
      );
      assert(!exists, "real git: branch not created until integration");
    }
    writeFileSync(path.join(repo, "operator-wip.txt"), "do not touch me\n");
    assert(
      (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() === "main",
      "real git: repo root still on main after branch setup",
    );
    rmSync(path.join(repo, "operator-wip.txt"));

    // B: cherry-pick integration
    writeFileSync(path.join(wt, "feature.txt"), "new feature\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "add feature.txt"]);
    const commitSha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    assert(commitSha.length === 40, "real git: developer commit SHA captured");
    const ok = await integrate(realExec, {
      repoRoot: repo,
      branchName: setup.branchName,
      baseSha: setup.baseSha,
      worktrees: setup.worktrees,
      scratchDir: scratch,
      commitTitle: "feat: thing",
      commitBody: "Fixes #287",
      mode: "create",
      requireAllNonEmpty: true,
    });
    assert(ok.ok && !ok.empty, `real git: cherry-pick integration succeeded`);
    assert(
      ok.commitShas !== undefined && ok.commitShas.default === commitSha,
      "real git: commitShas recorded",
    );
    assert(
      (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() === setup.branchName,
      "real git: repo root on feature branch",
    );
    assert(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"])).stdout.includes("feature.txt"),
      "real git: worktree file landed in cherry-pick",
    );
    assert(
      (await git(repo, ["rev-list", "--count", `${setup.baseSha}..HEAD`])).stdout.trim() === "1",
      "real git: branch is one commit ahead of base",
    );
    assert(
  await execFileP("git", ["rev-parse", "--verify", setup.branchName], {
    cwd: path.join(root, "origin.git"),
  }).then(() => true).catch(() => false),
      "real git: branch was pushed to origin",
    );

    // B2: resume — already-applied SHA skipped
    await integrate(realExec, {
      repoRoot: repo,
      branchName: setup.branchName,
      worktrees: setup.worktrees,
      scratchDir: scratch,
      commitTitle: "feat: again",
      commitBody: "b",
      mode: "followup",
      requireAllNonEmpty: true,
      commitShas: { default: commitSha },
    });
    assert(
      (await git(repo, ["rev-list", "--count", `${setup.baseSha}..HEAD`])).stdout.trim() === "1",
      "real git: resume — already-applied SHA skipped (still 1 commit)",
    );

    // C: follow-up (lens-fix, uncommitted)
    writeFileSync(path.join(wt, "feature.txt"), "new feature\nfixed\n");
    await git(wt, ["add", "."]);
    const follow = await integrate(realExec, {
      repoRoot: repo,
      branchName: setup.branchName,
      worktrees: setup.worktrees,
      scratchDir: scratch,
      commitTitle: "fix(lens): round 1",
      commitBody: "b",
      mode: "followup",
    });
    assert(follow.ok && !follow.empty, "real git: follow-up integration succeeded");
    assert(
      (await git(repo, ["rev-list", "--count", `${setup.baseSha}..HEAD`])).stdout.trim() === "2",
      "real git: lens-fix landed as SECOND commit (#287 Part C)",
    );
    assert(
      (await git(repo, ["show", "HEAD:feature.txt"])).stdout.includes("fixed"),
      "real git: lens-fix content committed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- D: cherry-pick conflict ----
{
  const { root, repo, scratch } = await makeFixture("pi-ens-conflict-", { "shared.txt": "base line\n" });
  try {
    const setup2 = await mechanizedBranchSetup(realExec, repo, 453, [453], ["task-a", "task-b"], "conflict");
    const wtA = setup2.worktrees["task-a"] ?? "";
    const wtB = setup2.worktrees["task-b"] ?? "";
    assert(existsSync(wtA) && existsSync(wtB), "conflict: both worktrees exist");
    writeFileSync(path.join(wtA, "shared.txt"), "line from A\n");
    await git(wtA, ["add", "."]);
    const shaA = (await git(wtA, ["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(path.join(wtB, "shared.txt"), "line from B\n");
    await git(wtB, ["add", "."]);
    const shaB = (await git(wtB, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await integrate(realExec, {
      repoRoot: repo,
      branchName: setup2.branchName,
      baseSha: setup2.baseSha,
      worktrees: setup2.worktrees,
      scratchDir: scratch,
      commitTitle: "feat: conflicting",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      commitShas: { "task-a": shaA, "task-b": shaB },
    });
    assert(!result.ok, "conflict: integration reported failure");
    assert(
      result.reason.includes("conflict") || result.reason.includes("abort"),
      `conflict: reason mentions conflict/abort (got: ${result.reason})`,
    );
    assert(
      (await git(repo, ["rev-parse", "--verify", setup2.branchName])).stdout.trim() === setup2.baseSha,
      "conflict: branch restored to baseSha after abort",
    );
    console.log("✓ conflict test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- E: dirty-repoRoot — #654 ----
{
  const { root, repo, scratch } = await makeFixture("pi-ens-dirty-", { "tracked.txt": "base\n" });
  try {
    const setup3 = await mechanizedBranchSetup(realExec, repo, 654, [654], [], "dirty");
    const wt3 = setup3.worktrees.default ?? "";
    assert(existsSync(wt3), "dirty: worktree exists");
    writeFileSync(path.join(wt3, "fix.txt"), "fixed\n");
    await git(wt3, ["add", "."]);

    // E1: tracked dirt → stash+pop
    writeFileSync(path.join(repo, "operator-wip.txt"), "do not touch me\n");
    await git(repo, ["add", "operator-wip.txt"]);
    const dirt = await readDirtyPorcelain(realExec, repo);
    assert(dirt !== undefined, "dirty E1: readDirtyPorcelain finds tracked dirt");
    if (dirt) {
      const outcome = await restoreRepoRoot(realExec, repo, dirt);
      assert(outcome.restored === true, `dirty E1: restoreRepoRoot stashes+pops (got: ${JSON.stringify(outcome)})`);
      assert(existsSync(path.join(repo, "operator-wip.txt")), "dirty E1: operator file survived");
    }

    // E2: untracked-only
    await git(repo, ["reset", "HEAD", "operator-wip.txt"]);
    await git(repo, ["checkout", "--", "operator-wip.txt"]).catch(() => {});
    writeFileSync(path.join(repo, "untracked-only.txt"), "untracked\n");
    const dirt2 = await readDirtyPorcelain(realExec, repo);
    assert(
      dirt2?.some((l) => l.startsWith("??")) === true,
      "dirty E2: untracked-only root is DIRT (N=1 shape)",
    );
    assert(existsSync(path.join(repo, "untracked-only.txt")), "dirty E2: untracked file untouched");

    // E3: integrate() refuses dirty repoRoot
    await git(repo, ["clean", "-fd"]).catch(() => {});
    await git(repo, ["checkout", "--", "."]).catch(() => {});
    writeFileSync(path.join(repo, "tracked-dirty.txt"), "dirty\n");
    await git(repo, ["add", "tracked-dirty.txt"]);
    const dr = await integrate(realExec, {
      repoRoot: repo,
      branchName: setup3.branchName,
      worktrees: setup3.worktrees,
      scratchDir: scratch,
      commitTitle: "fix(lens): r1",
      commitBody: "b",
      mode: "followup",
    });
    assert(!dr.ok, "dirty E3: integrate() refuses dirty repoRoot");
    assert(dr.failure === "dirty-repoRoot", `dirty E3: failure='dirty-repoRoot' (got: ${dr.failure})`);
    assert(
      dr.porcelain !== undefined && dr.porcelain.length > 0,
      "dirty E3: porcelain carried for restore-or-park",
    );
    console.log("✓ dirty-root test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- F: range-read fallback — #736 ----
{
  const { root, repo, scratch } = await makeFixture("pi-ens-drop-", { "tracked.txt": "base\n" });
  try {
    const setup4 = await mechanizedBranchSetup(realExec, repo, 736, [736], [], "drop");
    const wt4 = setup4.worktrees.default ?? "";
    writeFileSync(path.join(wt4, "a-multi.txt"), "first\n");
    writeFileSync(path.join(wt4, "b-multi.txt"), "second\n");
    await git(wt4, ["add", "."]);
    await git(wt4, ["commit", "-q", "-m", "add both"]);
    const dropExec: ExecFn = async (cmd, o) => {
      if (cmd.includes("--reverse") && cmd.includes("rev-list") && o?.cwd === wt4)
        throw new Error("simulated rev-list range read failure");
      return realExec(cmd, o);
    };
    const r = await integrate(dropExec, {
      repoRoot: repo,
      branchName: setup4.branchName,
      baseSha: setup4.baseSha,
      worktrees: setup4.worktrees,
      scratchDir: scratch,
      commitTitle: "feat: drop",
      commitBody: "b",
      mode: "create",
    });
    assert(r.ok && !r.empty, `drop: integrate() ok despite range-read failure`);
    if (r.ok && !r.empty) {
      assert(r.completeness?.checkError === undefined, "drop: completeness measurement present");
      assert(r.completeness?.droppedPaths.length === 0, `drop: no files dropped`);
      assert(
        r.completeness?.landed.includes("a-multi.txt") && r.completeness?.landed.includes("b-multi.txt"),
        "drop: both files landed",
      );
    }
    console.log("✓ drop-through-integrate test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- G: #981 — round-2 lens-fix divergence (the 978 shape) ----
{
  const { root, repo, scratch } = await makeFixture("pi-ens-981-", {
    "docs.txt": "line1\nline2\nline3\n",
    "note.txt": "alpha\n",
  });
  try {
    const s5 = await mechanizedBranchSetup(realExec, repo, 981, [981], [], "981 round-2");
    const wt5 = s5.worktrees.default ?? "";
    assert(existsSync(wt5), "981 G: worktree exists");

    // Round 1: commit + integrate (create mode creates the branch).
    writeFileSync(path.join(wt5, "docs.txt"), "line1\nline2\nline3\nround-1 fix\n");
    await git(wt5, ["add", "."]);
    await git(wt5, ["commit", "-q", "-m", "fix(lens): round 1"]);
    const f1 = await integrate(realExec, {
      repoRoot: repo,
      branchName: s5.branchName,
      baseSha: s5.baseSha,
      worktrees: s5.worktrees,
      scratchDir: scratch,
      commitTitle: "fix(lens): round 1",
      commitBody: "b1",
      mode: "create",
    });
    assert(f1.ok && !f1.empty, "981 G: round-1 integration landed");
    const tip1 = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    assert(tip1 !== s5.baseSha, "981 G: branch tip moved past base (divergence shape)");

    // Worktree back to old base + round-1 (stale).
    await git(wt5, ["checkout", "-q", "--detach", s5.baseSha]);
    const r1Sha = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    await git(wt5, ["merge", "--ff-only", "-q", r1Sha]);

    // Round 2: commit in stale worktree.
    writeFileSync(path.join(wt5, "note.txt"), "alpha\nbeta\n");
    await git(wt5, ["add", "."]);
    await git(wt5, ["commit", "-q", "-m", "fix(lens): round 2"]);
    const r2Sha = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    assert(r2Sha.length === 40, "981 G: round-2 commit captured");

    // Reposition fails (worktree diverged from branch tip).
    const rep = await repositionLensFixWorktree(realExec, wt5, s5.branchName);
    assert(rep === false, "981 G: reposition fails best-effort (diverged worktree)");

    // Round-2 integration: dedup skips round-1, lands only round-2.
    const f2 = await integrate(realExec, {
      repoRoot: repo,
      branchName: s5.branchName,
      baseSha: s5.baseSha,
      worktrees: s5.worktrees,
      scratchDir: scratch,
      commitTitle: "fix(lens): round 2",
      commitBody: "b2",
      mode: "followup",
    });
    assert(f2.ok && !f2.empty, `981 G: round-2 integration landed cleanly`);
    if (f2.ok && !f2.empty) {
      assert(
        (await git(repo, ["show", "HEAD:note.txt"])).stdout.includes("beta"),
        "981 G: round-2 content on branch tip",
      );
      const ahead = (await git(repo, ["rev-list", "--count", `${s5.baseSha}..HEAD`])).stdout.trim();
      assert(ahead === "2", `981 G: branch has exactly r1+r2 (got ${ahead} — r1 NOT re-picked)`);
      const ref = (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      assert(ref === s5.branchName, `981 G: repoRoot on feature branch (got '${ref}')`);
      const dirty = (await git(repo, ["status", "--porcelain"])).stdout.split("\n").filter((l) => l.trim());
      assert(dirty.length === 0, `981 G: repoRoot clean after round-2`);
    }
    console.log("✓ 981 G: round-2 lens-fix divergence test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- H: #981 — pick-range regression (no reposition) ----
{
  const { root, repo, scratch } = await makeFixture("pi-ens-981b-", {
    "docs.txt": "line1\nline2\nline3\n",
    "note.txt": "alpha\n",
  });
  try {
    const s6 = await mechanizedBranchSetup(realExec, repo, 982, [982], [], "981b");
    const wt6 = s6.worktrees.default ?? "";

    // Round 1: commit + integrate (create mode).
    writeFileSync(path.join(wt6, "docs.txt"), "line1\nline2\nline3\nround-1 fix\n");
    await git(wt6, ["add", "."]);
    await git(wt6, ["commit", "-q", "-m", "fix(lens): round 1"]);
    const r1Sha = (await git(wt6, ["rev-parse", "HEAD"])).stdout.trim();
    const f1 = await integrate(realExec, {
      repoRoot: repo,
      branchName: s6.branchName,
      baseSha: s6.baseSha,
      worktrees: s6.worktrees,
      scratchDir: scratch,
      commitTitle: "fix(lens): round 1",
      commitBody: "b1",
      mode: "create",
    });
    assert(f1.ok && !f1.empty, "981b: round-1 integration landed");

    // Stale worktree: base + round-1, then round-2.
    await git(wt6, ["checkout", "-q", "--detach", s6.baseSha]);
    await git(wt6, ["merge", "--ff-only", "-q", r1Sha]);
    writeFileSync(path.join(wt6, "note.txt"), "alpha\nbeta\n");
    await git(wt6, ["add", "."]);
    await git(wt6, ["commit", "-q", "-m", "fix(lens): round 2"]);

    // Integration WITHOUT reposition.
    const f2 = await integrate(realExec, {
      repoRoot: repo,
      branchName: s6.branchName,
      baseSha: s6.baseSha,
      worktrees: s6.worktrees,
      scratchDir: scratch,
      commitTitle: "fix(lens): round 2",
      commitBody: "b2",
      mode: "followup",
    });
    assert(f2.ok && !f2.empty, `981b: round-2 integration landed`);
    if (f2.ok && !f2.empty) {
      const ahead = (await git(repo, ["rev-list", "--count", `${s6.baseSha}..HEAD`])).stdout.trim();
      assert(ahead === "2", `981b: branch has exactly r1+r2 (got ${ahead} — r1 dedup-skipped)`);
      const docs = (await git(repo, ["show", "HEAD:docs.txt"])).stdout;
      assert(docs.includes("round-1 fix") && !docs.includes("round-1 fix\nround-1 fix"), "981b: r1 content once");
      assert((await git(repo, ["show", "HEAD:note.txt"])).stdout.includes("beta"), "981b: r2 content landed");
    }
    console.log("✓ 981b: pick-range regression test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
