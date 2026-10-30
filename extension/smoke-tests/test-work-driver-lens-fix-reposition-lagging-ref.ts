#!/usr/bin/env bun
/**
 * #1882 — the lens-fix reposition gate must not park when the LOCAL branch
 * ref lags `origin/<branch>` and the remote holds the cycle's OWN pushed
 * lens-fix commit.
 *
 * The field shape (the top stop reason in 26 factory runs, 6 of them): round
 * 1's fix landed and was pushed (`git push -u origin <branch>`), but nothing
 * advances `refs/heads/<branch>` for a detached integration — `integrate()`
 * pushes at repoRoot and then restores the checkout to the cycle's starting
 * ref, and `landCommittedFix()`'s verified restore does the same. At round 2
 * the gate resolved the tip from that LAGGING local ref, counted the
 * already-pushed round-1 commit as "commits the branch does not", and emitted
 * `cap-hit cap=lens-fix-reposition nextStep=handoff`. The fixer never
 * dispatched.
 *
 * Three cases, all offline against a bare origin plus real git (same
 * convention as test-work-driver-981-divergence-realgit.ts, so NOT *-live):
 *   1. the field shape — no park, backup ref written, tree at the tip, and
 *      the step readers attribute the cap to `lens-fix`, not `lens-review`;
 *   2. a GENUINE reposition (a commit neither ref holds) still parks;
 *   3. the gate's `git fetch` still refreshes a stale remote-tracking ref,
 *      so a push from elsewhere does not park either.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { capStep } from "../src/headless/caps.ts";
import { failedStepOf } from "../src/headless/failed-step.ts";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { parkReason } from "../src/work-queue-park-reason.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";
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

/** Real exec that honours the driver's argv form (#1005) — the gate's git
 *  calls all use it, so a shell-only fake would never see them. */
const realExec: ExecFn = async (cmd, o) => {
  if (o?.argv) {
    const { stdout } = await execFileP(cmd, o.argv, {
      cwd: o.cwd,
      timeout: o.timeout,
      // `runNetGit` (the gate's fetch) passes a non-interactive env and a
      // tighter timeout; dropping them makes the fetch prompt or hang.
      env: o.env,
      maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  }
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/** A bare origin + a repo at main + the driver's own branch worktree. */
async function mkRepo(tag: string, issue: number, title: string) {
  const root = mkdtempSync(path.join(tmpdir(), `pi-ens-1882-${tag}-`));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const scratch = path.join(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "meter.js"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "note.txt"), "alpha\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const setup = await mechanizedBranchSetup(realExec, repo, issue, [issue], [], title);
  return { root, origin, repo, scratch, setup, wt: setup.worktrees.default ?? "" };
}

// ── Case 1: the field shape — round-1 fix pushed, local ref behind, round 2.
{
  const { root, repo, scratch, setup, wt } = await mkRepo("pushed", 1882, "1882 lagging ref");
  try {
    const branch = setup.branchName;

    // commit-pr: the feature lands on the branch and is pushed.
    writeFileSync(path.join(wt, "meter.js"), "one\ndrawMeter(meter)\nthree\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "feat: the meter"]);
    const first = await integrate(realExec, {
      repoRoot: repo,
      branchName: branch,
      baseSha: setup.baseSha,
      worktrees: setup.worktrees,
      scratchDir: scratch,
      commitTitle: "feat: the meter",
      commitBody: "b",
      mode: "create",
    });
    assert(first.ok && !first.empty, "1882: commit-pr landed the feature on the branch");

    // Round 1: the gate puts the fixer on the tip; it commits a fix; the
    // driver lands it and pushes it.
    const rep1 = await repositionLensFixWorktree(realExec, wt, branch, [1882], "1882 lagging ref");
    assert(
      rep1.kind === "already-at-tip" || rep1.kind === "repositioned",
      `1882: round 1 dispatches (${rep1.kind})`,
    );
    writeFileSync(path.join(wt, "meter.js"), "one\ndrawMeter(view.meter)\nthree\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "round 1 fix"]);
    const r1Sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const landed = await integrate(realExec, {
      repoRoot: repo,
      branchName: branch,
      baseSha: setup.baseSha,
      worktrees: setup.worktrees,
      scratchDir: scratch,
      commitTitle: "fix(lens): round 1",
      commitBody: "r1",
      mode: "followup",
    });
    assert(landed.ok && !landed.empty, "1882: round-1 fix landed");
    await realExec("git", {
      cwd: repo,
      argv: ["push", "-q", "origin", branch],
    });

    // The driver's round-1 integration restores repoRoot to the ref the
    // cycle started on (`main` here), so the local branch ref never followed
    // the push. Make the lag explicit so this case cannot drift into a
    // both-refs-current fixture.
    const remoteTip = (
      await git(repo, ["rev-parse", `refs/remotes/origin/${branch}`])
    ).stdout.trim();
    const r1OnBranch = (
      await git(repo, ["rev-list", "--count", `${setup.baseSha}..${remoteTip}`])
    ).stdout.trim();
    assert(
      r1OnBranch === "2",
      `1882: origin holds the feature + round-1 commits (got ${r1OnBranch})`,
    );
    await git(repo, ["update-ref", `refs/heads/${branch}`, setup.baseSha, remoteTip]);
    const localTip = (await git(repo, ["rev-parse", `refs/heads/${branch}`])).stdout.trim();
    assert(localTip === setup.baseSha, "1882: the local branch ref lags origin");
    assert(localTip !== remoteTip, "1882: local and remote tips differ");
    // The worktree sits on the round-1 fix it committed — NOT the patch-
    // applied commit the branch carries — which is the #981 round-2 shape
    // the field reproduced.
    await git(wt, ["checkout", "-q", "--detach", r1Sha]);
    const treeBefore = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    assert(treeBefore === r1Sha, "1882: the tree still holds the fixer's own round-1 commit");

    // The round-2 gate. Before #1882 this resolved the tip from the lagging
    // local ref, counted the round-1 commit as work the branch does not
    // have, and parked `lens-fix-reposition` — the fixer never dispatched.
    const rep2 = await repositionLensFixWorktree(realExec, wt, branch, [1882], "1882 lagging ref");
    assert(
      rep2.kind === "repositioned",
      `1882: a lagging local ref does NOT park the round-2 gate (got ${rep2.kind}${
        rep2.kind === "diverged" || rep2.kind === "unlanded" ? ` — ${rep2.detail}` : ""
      })`,
    );
    assert(
      rep2.kind === "repositioned" && rep2.tipSha === remoteTip,
      `1882: the accept came from the remote's patch-equivalence read, so it landed on the REMOTE tip (got ${
        rep2.kind === "repositioned" ? rep2.tipSha.slice(0, 12) : rep2.kind
      }, expected ${remoteTip.slice(0, 12)})`,
    );
    assert(
      rep2.kind === "repositioned" && rep2.backupRef !== undefined,
      "1882: the accept path still wrote a backup ref",
    );
    assert(
      rep2.kind === "repositioned" && rep2.fromSha === r1Sha,
      "1882: the move is recorded from the tree it started on",
    );
    // #1882 lens round 2 — the accept path's `checkout` runs with
    // `core.hooksPath=/dev/null` and `core.fsmonitor=false`. The worktree is
    // child-writable, so a hook the fixer dropped into the repo's hooks dir
    // must NOT execute as part of the driver's own move — a hook that runs
    // there runs arbitrary code in the parent, against a tree the fixer
    // controls. `core.hooksPath` is not set in the fixture's config, so an
    // un-hardened checkout runs this file. The hook installs BEFORE the gate
    // runs and the tree is still off the tip, so the gate's own checkout is
    // the only thing that can produce the marker.
    const gitDirOfWt = (await git(wt, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    const hooksDir = path.join(gitDirOfWt, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const marker = path.join(root, "hook-ran");
    const hook = path.join(hooksDir, "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    // git only consults `<git-dir>/hooks` when `core.hooksPath` points at it
    // (verified: an installed-but-unconfigured hook never fires). Setting it
    // in the repo config reproduces the field shape this guard exists for — a
    // child that writes its own hooks config into the repository it shares
    // with the driver. `core.hooksPath=/dev/null` on the driver's own argv is
    // what must outrank it.
    await git(repo, ["config", "core.hooksPath", hooksDir]);
    // The fixture's own checkout (a plain test call, not the driver's) proves
    // the hook is installed where a driver checkout WOULD find it: the marker
    // appears. Without this the "no marker" assertion below could pass simply
    // because the hook was never wired up.
    await git(wt, ["checkout", "-q", "--detach", remoteTip]);
    assert(
      existsSync(marker),
      "1882: the fixture's post-checkout hook is live where the driver's checkout reaches it",
    );
    // Back off the tip so the gate has a move to make, then run the gate.
    await git(wt, ["checkout", "-q", "--detach", r1Sha]);
    rmSync(marker, { force: true });
    const repHook = await repositionLensFixWorktree(
      realExec,
      wt,
      branch,
      [1882],
      "1882 lagging ref",
    );
    assert(
      repHook.kind === "repositioned",
      `1882: the gate still accepts with a hook installed (got ${repHook.kind})`,
    );
    assert(
      !existsSync(marker),
      "1882: the driver's own checkout ran NO hook from the child-writable repo",
    );
    const headNow = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    assert(headNow === remoteTip, "1882: the tree moved to the branch tip");
    if (rep2.kind === "repositioned" && rep2.backupRef) {
      const backed = (await git(wt, ["rev-parse", rep2.backupRef])).stdout.trim();
      assert(backed === r1Sha, "1882: the backup ref points at the tree it moved off");
    }
    // The fixer's base is the pushed tip: a round-2 edit applies to it.
    const treeContent = (await git(wt, ["show", "HEAD:meter.js"])).stdout;
    assert(
      treeContent.includes("view.meter"),
      "1882: the tree the fixer dispatches on carries the round-1 fix",
    );

    // AC3 — both step readers map the cap to lens-fix. The lifecycle is
    // unchanged (no pre-gate step-started), which is exactly why a mapping
    // is needed: lens-fix appends its step-started only inside the dispatch
    // that the gate precedes.
    const state: WorkState = {
      ...initialState(1882),
      pipelineState: {
        ...initialState(1882).pipelineState,
        status: "handoff",
        currentStep: "handoff",
        lastCompletedStep: "lens-review",
        branchName: branch,
      },
      eventLog: [
        { kind: "step-started", step: "lens-review", at: 1 },
        { kind: "cap-hit", cap: "lens-fix-reposition", at: 2, reviewRound: 2, nextStep: "handoff" },
        { kind: "step-started", step: "handoff", at: 3 },
      ],
    };
    assert(capStep("lens-fix-reposition") === "lens-fix", "1882: capStep maps the cap to lens-fix");
    assert(failedStepOf(state) === "lens-fix", "1882: failedStepOf names lens-fix");
    assert(
      parkReason(state).failedStep === "lens-fix",
      `1882: the queue's parkReason names lens-fix (got ${parkReason(state).failedStep})`,
    );
    // The park's own shape is unchanged (it still routes to handoff); the
    // reader assertions above are the point. Built through the same builder
    // the gate's caller uses, with a no-op emit sink and no state file.
    const capEvent = appendEvent(state, {
      kind: "cap-hit",
      at: 4,
      cap: "lens-fix-reposition",
      lensWorktreePath: wt,
      reviewRound: 2,
      evidence: "diverged: x",
      nextStep: "handoff",
    }).eventLog.slice(-1)[0];
    assert(
      capEvent?.kind === "cap-hit" && capEvent.cap === "lens-fix-reposition",
      "1882: the park still emits the lens-fix-reposition cap-hit",
    );
    assert(
      capEvent?.kind === "cap-hit" && capEvent.nextStep === "handoff",
      "1882: the park still routes to handoff",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Case 2: a GENUINE reposition still parks.
{
  const { root, repo, wt, setup } = await mkRepo("genuine", 1883, "1883 genuine");
  try {
    const branch = setup.branchName;
    // The field shape: commit-pr landed the feature and pushed the branch,
    // then the checkout was restored — so the LOCAL ref sits at the base
    // while origin holds the feature commit. (test-work-driver-981 J is the
    // mirror case: local ahead of origin; that one must keep parking.)
    writeFileSync(path.join(repo, "meter.js"), "one\ndrawMeter(meter)\nthree\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "feat: the meter"]);
    await git(repo, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    await git(repo, ["update-ref", `refs/heads/${branch}`, setup.baseSha]);
    await git(wt, ["checkout", "-q", "--detach", setup.baseSha]);
    // Someone else moved the branch: a commit the tree does not hold, and the
    // tree holds a commit NEITHER ref has. `repo`'s HEAD carries both
    // commits, so its local ref simply never followed the pushes.
    writeFileSync(path.join(repo, "note.txt"), "alpha\nsomeone else\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "foreign advance"]);
    await git(repo, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    writeFileSync(path.join(wt, "fixer.txt"), "mine\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "fixer work neither ref holds"]);

    const rep = await repositionLensFixWorktree(realExec, wt, branch, [1883], "1883 genuine");
    assert(
      rep.kind === "diverged" || rep.kind === "unlanded",
      `1882: a tree holding a commit NEITHER ref has still parks (got ${rep.kind})`,
    );
    assert(
      rep.kind === "diverged" || rep.kind === "unlanded" ? rep.backupRef !== undefined : false,
      "1882: the genuine park still backs the tree up",
    );
    const headStill = (await git(wt, ["show", "HEAD:fixer.txt"])).stdout;
    assert(headStill.includes("mine"), "1882: the genuine park did not move or destroy the tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Case 3: the gate's own fetch refreshes a stale remote-tracking ref.
{
  const { root, origin, repo, wt, setup } = await mkRepo("fetch", 1884, "1884 fetch");
  try {
    const branch = setup.branchName;
    // A second clone pushes the driver's own round-1 fix; this clone's
    // remote-tracking ref is stale and its local ref lags further still.
    const other = path.join(root, "other");
    await git(repo, ["push", "-q", "origin", `${setup.baseSha}:refs/heads/${branch}`]);
    await git(root, ["clone", "-q", "-b", branch, origin, other]);
    await git(other, ["config", "user.email", "t@example.com"]);
    await git(other, ["config", "user.name", "T"]);
    writeFileSync(path.join(other, "meter.js"), "one\ndrawMeter(other.meter)\nthree\n");
    await git(other, ["add", "."]);
    await git(other, ["commit", "-q", "-m", "round 1 fix from the other clone"]);
    await git(other, ["push", "-q", "origin", branch]);
    const remoteTip = (await git(other, ["rev-parse", "HEAD"])).stdout.trim();
    await git(repo, ["update-ref", `refs/heads/${branch}`, setup.baseSha]);

    const rep = await repositionLensFixWorktree(realExec, wt, branch, [1884], "1884 fetch");
    assert(
      rep.kind === "repositioned",
      `1882: the gate's fetch resolves the lagging ref pair (got ${rep.kind}${
        rep.kind === "diverged" || rep.kind === "unlanded" ? ` — ${rep.detail}` : ""
      })`,
    );
    const headNow = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    assert(headNow === remoteTip, "1882: the tree moved to the freshly-fetched tip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
