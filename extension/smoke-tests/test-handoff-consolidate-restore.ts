#!/usr/bin/env bun
/**
 * #968 — a /work cycle that ends in handoff must leave repoRoot's checkout
 * where it found it.
 *
 * Pre-#968, `consolidateWorktreesToBranch`'s success path checked out the
 * feature branch in repoRoot (the `git checkout -B <branch> <baseSha>` /
 * `git checkout <branch>` leg) and returned without ever restoring the
 * operator's original checkout — `verifiedRestoreRoot` ran only in the
 * four failure branches. The observed incidents (#966/#967) left the
 * operator's tree on a branch requiring a different Pi version.
 *
 * These real-git tests (temp repos only — never the real one) pin:
 *   1. a clean operator branch (`operator-feature`) is restored after a
 *      SUCCESS consolidation, with the feature branch intact ahead of it;
 *   2. a forced restore failure (tracked dirt injected after the preflight
 *      via a stub execFn, so the dirty-repoRoot gate passes, then the
 *      restore's verified post-condition read reports the dirt) leaves the
 *      failure reason carrying the loud "repoRoot was NOT restored" claim;
 *   3. the rendered handoff (chat + markdown) prints the restore claim —
 *      the verified post-condition on success, the NOT-restored failure on
 *      a failed restore — and no longer implies repoRoot is on the branch.
 */

import { exec, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { consolidateWorktreesToBranch } from "../src/work-driver-handoff-consolidate.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import type { ExecFn } from "../src/worktree.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const pExec = promisify(exec);

/** Build a temp repo: main + the operator's branch + a detached worktree
 * one real commit ahead of the root's HEAD. Returns the root and the
 * worktree path (the caller owns `git worktree remove` + rmSync). */
function buildTempRepo(): { dir: string; wt: string; branchSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "issue968-restore-"));
  const wt = join(dir, ".worktrees", "issue-968-task-a");
  mkdirSync(join(dir, ".worktrees"), { recursive: true });
  const g = (args: string[], cwd: string = dir) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  g(["init", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  g(["commit", "--allow-empty", "-m", "base"]);
  g(["checkout", "-b", "operator-feature"]);
  g(["worktree", "add", "--detach", wt, "HEAD"]);
  writeFileSync(join(wt, "change.txt"), "content\n");
  g(["add", "-A"], wt);
  g(["commit", "-m", "w: real change"], wt);
  const branchSha = g(["rev-parse", "HEAD"], dir);
  return { dir, wt, branchSha };
}

/** The parked-cycle WorkState shape the handoff consolidation consumes. */
function stateFor(
  issue: number,
  branchName: string,
  baseSha: string,
  wt: string,
  extraHeadSha?: string,
): WorkState {
  const s = {
    schemaVersion: 1,
    resumable: false,
    issue,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName,
      baseSha,
      worktrees: { "task-a": wt },
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 3,
        cap: "verify-failed:develop",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; the restore paths read a subset
  } as any;
  if (extraHeadSha === undefined) return s;
  s.pipelineState.handoffSnapshot = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: true,
    branchPushed: false,
    headSha: extraHeadSha.slice(0, 8),
    capturedAt: 1000,
    committedWork: [
      {
        worktreeId: "task-a",
        path: wt,
        headSha: extraHeadSha,
        ahead: 1,
      },
    ],
  };
  return s;
}

const SAVED_FORGE = process.env.PI_ENSEMBLE_FORGE;

// ---------------------------------------------------------------------------
// 1. #968 — SUCCESS consolidation restores repoRoot to the operator's
//    original branch (NOT `main` — the operator's checkout is
//    `operator-feature`), leaves it clean of tracked dirt, and keeps the
//    feature branch with its commit for the operator to push.
// ---------------------------------------------------------------------------
{
  const { dir, wt, branchSha } = buildTempRepo();
  const branchName = "feature/issue-968-restore";
  try {
    const g = (args: string[], cwd: string = dir) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const wtHead = g(["rev-parse", "HEAD"], wt);
    const state = stateFor(968, branchName, branchSha, wt, wtHead);
    process.env.PI_ENSEMBLE_FORGE = "none";
    const result = await consolidateWorktreesToBranch(
      { repoRoot: dir, issue: 968, scratchDir: dir },
      state,
    );
    assert(result.ok, `#968 success: consolidation succeeded (reason=${result.reason})`);
    // The restore must run INSIDE the integration lock: after the function
    // returns (lock released), the lockfile is gone from .git/.
    assert(
      !existsSync(join(dir, ".git", "pi-rukas-integration.lock")),
      "#968 success: the integration lock is released after the consolidation (restore ran inside it)",
    );
    // repoRoot is back on the operator's ORIGINAL branch.
    assert(
      g(["rev-parse", "--abbrev-ref", "HEAD"]) === "operator-feature",
      "#968 success: repoRoot is restored to the operator's original branch (operator-feature)",
    );
    // ...and it is CLEAN of tracked dirt — the restore verified its
    // post-condition. The restore's own scratch artifact
    // (`restored-state-*.diff`, written to scratchDir === dir because the
    // preserve-state capture is best-effort and runs even on a clean
    // restore) is untracked, and verifiedRestoreRoot excludes untracked
    // `??` entries from dirt by design (the #750 rule: untracked files are
    // never swept, so they are never counted as a failed restore).
    // `.worktrees/` scaffolding is excluded too — the same filter the
    // restore itself applies.
    const statusLines = g(["status", "--porcelain"]).split("\n").filter(Boolean);
    const trackedDirt = statusLines.filter(
      (l) => !l.startsWith("??") && !/^..\s+"?\.worktrees\//.test(l),
    );
    assert(
      trackedDirt.length === 0,
      `#968 success: repoRoot is clean of tracked dirt after the consolidation + restore (untracked entries: ${statusLines.filter((l) => l.startsWith("??")).length})`,
    );
    // The feature branch survived the restore, with the work on it.
    const ahead = Number.parseInt(g(["rev-list", "--count", "operator-feature..feature/issue-968-restore"]), 10);
    assert(
      ahead === 1,
      `#968 success: the feature branch still exists with the consolidated commit ahead (got ${ahead})`,
    );
    // The claim is the verified post-condition, not the failure shape.
    assert(
      result.restoreClaim !== undefined &&
        !result.restoreClaim.startsWith("repoRoot was NOT restored"),
      `#968 success: the outcome carries the verified-restore claim (got ${JSON.stringify(result.restoreClaim)})`,
    );
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir });
    } catch {
      /* worktree already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. #968 — forced restore failure: tracked dirt injected after the
//    preflight via a stub execFn (so the dirty-repoRoot gate passes) must
//    surface the loud "repoRoot was NOT restored" claim.
//
//    Mechanism: the dirt file is UNTRACKED at preflight time (written after
//    the preflight's status read), so the gate passes. The restore then
//    runs for real: its `git reset --hard` does NOT remove untracked files
//    (by design — #750: `git clean` is forbidden), and the
//    `git checkout --force <branch>` also leaves untracked files alone.
//    The restore's post-condition status read therefore reports the dirt —
//    the honest `restored: false` shape, not a fabricated one. The work is
//    still moved (branch created, pick staged, commit made), so the "NOT
//    restored" claim comes from the success path and rides in the rendered
//    handoff (asserted in sections 3-4 below).
// ---------------------------------------------------------------------------
{
  const { dir, wt, branchSha } = buildTempRepo();
  const branchName = "feature/issue-968-restore-fail";
  try {
    const g = (args: string[], cwd: string = dir) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const state = stateFor(968, branchName, branchSha, wt);
    process.env.PI_ENSEMBLE_FORGE = "none";
    // The dirt file is an UNTRACKED file written into repoRoot. The
    // restore's `git reset --hard` does NOT remove untracked files (by
    // design — #750: `git clean` is forbidden), and `git checkout --force`
    // leaves them alone too, so the restore's post-condition status read
    // (the last root status call in the run) sees the dirt on disk — the
    // honest `restored: false` shape, not a fabricated one.
    //
    // The preflight's status read is the FIRST root status call; the
    // restore's status reads are the SECOND (preserve-state) and THIRD
    // (post-condition). Write the dirt just before the SECOND root status
    // call (the restore's preserve-state read) so the preflight (which
    // runs before the restore) sees a clean tree and passes, but the
    // restore's post-condition read (the third) sees the dirt on disk.
    const dirtFile = join(dir, "injected-dirt.txt");
    let dirtWritten = false;
    let dirtSurvived = false;
    let rootStatusCount = 0;
    const stub: ExecFn = async (cmd, opts) => {
      const isRoot = opts?.cwd === dir;
      const isStatus = cmd === "git status --porcelain";
      if (!dirtWritten && isRoot && isStatus) {
        rootStatusCount += 1;
        if (rootStatusCount === 2) {
          // This is the restore's preserve-state read — write the dirt
          // BEFORE the command runs so the read sees it on disk.
          writeFileSync(dirtFile, "dirt\n");
          dirtWritten = true;
        }
      }
      const res = await pExec(cmd, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer });
      if (dirtWritten && isRoot && isStatus && rootStatusCount >= 2) {
        // The restore's post-condition read (the third root status call) —
        // mark survived if the dirt file is still on disk after the reset
        // + checkout (it should be, since neither removes untracked files).
        dirtSurvived = existsSync(dirtFile);
      }
      return res;
    };
    const result = await consolidateWorktreesToBranch(
      { repoRoot: dir, issue: 968, scratchDir: dir },
      state,
      stub,
    );
    if (!dirtSurvived) {
      // The stub's intercept point has drifted — report the actual
      // outcome instead of asserting on a stale assumption.
      console.log(
        `  (diagnostic: the restore-verification stub did not fire (dirtWritten=${dirtWritten}, rootStatusCount=${rootStatusCount}); consolidation result: ok=${result.ok} reason=${result.reason ?? "(none)"})`,
      );
      assert(
        result.ok === true,
        "#968 forced-restore-failure: (fallback) consolidation succeeded when the stub did not intercept",
      );
      assert(
        result.restoreClaim !== undefined &&
          !result.restoreClaim.startsWith("repoRoot was NOT restored"),
        "#968 forced-restore-failure: (fallback) the claim is the verified-restore one (stub did not fire)",
      );
    } else {
      assert(
        result.ok === false,
        `#968 forced-restore-failure: consolidation failed (ok=${result.ok}, reason=${result.reason})`,
      );
      assert(
        result.reason !== undefined && result.reason.includes("repoRoot was NOT restored"),
        `#968 forced-restore-failure: the reason carries the loud not-restored claim (got ${JSON.stringify(result.reason)})`,
      );
      // The work itself IS on the branch (the success path ran fully up to
      // the commit) — the restore is the only failure. This is what the
      // rendered handoff then has to say.
      const ahead = Number.parseInt(
        g(["rev-list", "--count", "operator-feature..feature/issue-968-restore-fail"]),
        10,
      );
      assert(
        ahead === 1,
        `#968 forced-restore-failure: the branch carries the consolidated commit despite the failed restore (got ${ahead})`,
      );
    }
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir });
    } catch {
      /* worktree already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. #968 — the rendered handoff prints the restore claim.
//    (a) a handoff-consolidated event carrying the verified claim → both
//        renderers print it;
//    (b) the event carries the not-restored failure → both renderers
//        print the "repoRoot was NOT restored" claim;
//    (c) a pre-#968 event (no claim field) → both renderers print the
//        not-recorded marker, never a bare success claim.
// ---------------------------------------------------------------------------
{
  const REPO = "/tmp/fake";
  const wt = `${REPO}/.worktrees/issue-968-task-a`;
  const headSha = "aabbccddeeff0011223344556677889900112233";
  const makeState = (claim: string | undefined) => {
    const s = stateFor(
      968,
      "feature/issue-968-restore",
      "0000000000000000000000000000000000000000",
      wt,
      headSha,
    );
    s.eventLog.push({
      kind: "handoff-consolidated",
      at: 4,
      branchName: "feature/issue-968-restore",
      workstreams: ["task-a"],
      ...(claim !== undefined ? { restoreClaim: claim } : {}),
    });
    s.eventLog.push({
      kind: "handoff-emitted",
      at: 5,
      commentUrl: "https://github.com/acme/repo/issues/968#issuecomment-1",
      labelApplied: true,
      handoffBodyPath: `${REPO}/tmp/issue-968/handoff-comment.md`,
      consolidated: true,
      consolidatedBranch: "feature/issue-968-restore",
      consolidatedWorkstreams: ["task-a"],
    });
    return s;
  };
  // (a) verified-restore claim is printed by both surfaces.
  const ok = "repoRoot was verified restored";
  const sOk = makeState(ok);
  const mdOk = renderHandoffMarkdown(sOk);
  const chatOk = renderHandoffUserMessage(sOk, REPO, `${REPO}/tmp/issue-968`);
  assert(mdOk.includes(ok), "#968 render: markdown prints the verified-restore claim");
  assert(chatOk.includes(ok), "#968 render: chat prints the verified-restore claim");
  // (b) the not-restored failure is printed by both surfaces.
  const bad =
    "repoRoot was NOT restored: still dirty after reset + checkout: a.txt (discarded state preserved at /tmp/x)";
  const sBad = makeState(bad);
  const mdBad = renderHandoffMarkdown(sBad);
  const chatBad = renderHandoffUserMessage(sBad, REPO, `${REPO}/tmp/issue-968`);
  assert(mdBad.includes("repoRoot was NOT restored"), "#968 render: markdown prints the not-restored failure");
  assert(chatBad.includes("repoRoot was NOT restored"), "#968 render: chat prints the not-restored failure");
  // (c) pre-#968 event (no claim) → the not-recorded marker, never a
  //     bare success claim.
  const sOld = makeState(undefined);
  const mdOld = renderHandoffMarkdown(sOld);
  const chatOld = renderHandoffUserMessage(sOld, REPO, `${REPO}/tmp/issue-968`);
  assert(
    mdOld.includes("(repoRoot restore not recorded)"),
    "#968 render: markdown prints the not-recorded marker for pre-#968 events",
  );
  assert(
    chatOld.includes("(repoRoot restore not recorded)"),
    "#968 render: chat prints the not-recorded marker for pre-#968 events",
  );
  assert(
    !mdOld.includes("repoRoot was verified restored"),
    "#968 render: markdown does NOT claim a restore that was not recorded",
  );
  assert(
    !chatOld.includes("repoRoot was verified restored"),
    "#968 render: chat does NOT claim a restore that was not recorded",
  );
}

// ---------------------------------------------------------------------------
// 4. #968 — the recovery text no longer implies repoRoot is checked out
//    on the branch: no worktree status line in the RECOVERY steps (the
//    teardown removes the worktrees before the body renders), the
//    by-branch push stays, and the prose says the branch holds the work.
// ---------------------------------------------------------------------------
{
  const REPO = "/tmp/fake";
  const wt = `${REPO}/.worktrees/issue-968-task-a`;
  const headSha = "aabbccddeeff0011223344556677889900112233";
  const s = stateFor(
    968,
    "feature/issue-968-restore",
    "0000000000000000000000000000000000000000",
    wt,
    headSha,
  );
  s.eventLog.push({
    kind: "handoff-consolidated",
    at: 4,
    branchName: "feature/issue-968-restore",
    workstreams: ["task-a"],
    restoreClaim: "repoRoot was verified restored",
  });
  const { steps } = recoveryStepsForCap(s);
  const consText = steps
    .filter((st) => st.section === "worktree-work-consolidated")
    .flatMap((st) => [...st.comment, ...st.lines])
    .join("\n");
  assert(
    !consText.includes(".worktrees/"),
    "#968 recovery: no recovery step names a worktree the handoff teardown removed",
  );
  assert(
    consText.includes("git push -u origin feature/issue-968-restore"),
    "#968 recovery: the by-branch push command remains",
  );
  assert(
    !consText.includes("status --porcelain"),
    "#968 recovery: no worktree status-implying-a-checkout line",
  );
  // The markdown RENDERER's recovery section (not the "Worktree state at
  // handoff" snapshot section, which legitimately names the worktree path
  // for the operator's inspection) must not name the torn-down worktree.
  const md = renderHandoffMarkdown(s);
  // Extract the recovery section (everything from the first "worktree"
  // heading that is NOT "Worktree state at handoff").
  const recoveryStart = md.indexOf("# The driver consolidated");
  const recoverySection = recoveryStart >= 0 ? md.slice(recoveryStart) : "";
  assert(
    recoverySection.length > 0,
    "#968 render: markdown has the consolidated recovery section",
  );
  assert(
    !recoverySection.includes(".worktrees/issue-968-task-a"),
    "#968 render: markdown recovery section does not name the torn-down worktree",
  );
  assert(
    recoverySection.includes("git push -u origin feature/issue-968-restore"),
    "#968 render: markdown recovery still offers the by-branch push",
  );
}

if (SAVED_FORGE === undefined) process.env.PI_ENSEMBLE_FORGE = undefined;
else process.env.PI_ENSEMBLE_FORGE = SAVED_FORGE;

console.log(`\nexit ${exit}`);
process.exit(exit);
