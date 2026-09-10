#!/usr/bin/env bun
/**
 * #674 — the handoff must say where the work actually is.
 *
 * The five parked cycles (#645/#649/#659/#660/#664) all capped
 * `verify-failed:develop` at reviewRound 0 — before adversarial, before
 * commit-pr — so at handoff time the feature branch does NOT exist locally
 * or remotely. The developer's work lives as commits on detached-HEAD
 * worktrees under `.worktrees/issue-<N>-<id>`. The pre-#674 handoff
 * printed `git -C <repoRoot> status` / `add -p` / `push -u origin
 * <branch>` — every command against a main checkout that is provably
 * empty. An operator following it verbatim concludes the work was lost.
 *
 * This test builds the exact parked state (cap verify-failed:develop,
 * branchName set, non-empty worktrees map, handoffSnapshot with
 * committedWork entries) and asserts that BOTH surfaces (renderHandoffMarkdown
 * + renderHandoffUserMessage) name the actual worktree paths + HEAD SHAs
 * and working cherry-pick commands — NOT the generic main-checkout block.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consolidateWorktreesToBranch,
  countAheadOfBase,
  handoffConsolidationEnabled,
  workNotYetOnBranch,
} from "../src/work-driver-handoff-consolidate.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { captureCommittedWork } from "../src/work-driver-handoff-post.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";

/**
 * The exact shape of the five parked cycles: cap verify-failed:develop,
 * branchName set, worktrees map populated, handoffSnapshot with
 * committedWork (the work is on detached HEADs, commits ahead of base).
 */
function parkedDevelopState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 674,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-674",
      baseSha: "aaaabbbb11112222333344445555666677778888",
      worktrees: {
        default: `${REPO}/.worktrees/issue-674-default`,
        "task-a": `${REPO}/.worktrees/issue-674-task-a`,
      },
      handoffSnapshot: {
        modifiedFiles: [],
        unstagedCount: 0,
        stagedCount: 0,
        branchExists: false,
        branchPushed: false,
        headSha: "99998888",
        capturedAt: 1000,
        committedWork: [
          {
            worktreeId: "default",
            path: `${REPO}/.worktrees/issue-674-default`,
            headSha: "1111222233334444555566667777888899990000",
            ahead: 2,
          },
          {
            worktreeId: "task-a",
            path: `${REPO}/.worktrees/issue-674-task-a`,
            headSha: "aabbccddeeff0011223344556677889900112233",
            ahead: 1,
          },
        ],
      },
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
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

/** The consolidated variant: a handoff-consolidated event is present. */
function parkedDevelopConsolidatedState(): WorkState {
  const s = parkedDevelopState();
  s.eventLog.push({
    kind: "handoff-consolidated",
    at: 4,
    branchName: "feature/issue-674",
    workstreams: ["default", "task-a"],
  });
  s.eventLog.push({
    kind: "handoff-emitted",
    at: 5,
    commentUrl: "https://github.com/acme/repo/issues/674#issuecomment-1",
    labelApplied: true,
    handoffBodyPath: `${REPO}/tmp/issue-674/handoff-comment.md`,
    consolidated: true,
    consolidatedBranch: "feature/issue-674",
    consolidatedWorkstreams: ["default", "task-a"],
  });
  return s;
}

// ---------------------------------------------------------------------------
// 1. The shared decision produces worktree-aware steps for the parked shape.
// ---------------------------------------------------------------------------
{
  const s = parkedDevelopState();
  const { steps } = recoveryStepsForCap(s);
  const wtSteps = steps.filter(
    (st) => st.section === "worktree-work-consolidated" || st.section === "worktree-work-fallback",
  );
  assert(
    wtSteps.length > 0,
    "shared decision: worktree-aware steps are produced for the parked shape",
  );
  assert(
    wtSteps[0]?.section === "worktree-work-fallback",
    "shared decision: the fallback section is used when no consolidation event is present",
  );
}

{
  const s = parkedDevelopConsolidatedState();
  const { steps } = recoveryStepsForCap(s);
  const wtSteps = steps.filter(
    (st) => st.section === "worktree-work-consolidated" || st.section === "worktree-work-fallback",
  );
  assert(wtSteps.length > 0, "shared decision (consolidated): worktree-aware steps are produced");
  assert(
    wtSteps[0]?.section === "worktree-work-consolidated",
    "shared decision (consolidated): the consolidated section is used when a consolidation event is present",
  );
}

// ---------------------------------------------------------------------------
// 2. The markdown surface names the actual worktree paths + HEAD SHAs.
// ---------------------------------------------------------------------------
{
  const md = renderHandoffMarkdown(parkedDevelopState());
  assert(md.includes(".worktrees/issue-674-default"), "markdown: names the default worktree path");
  assert(md.includes(".worktrees/issue-674-task-a"), "markdown: names the task-a worktree path");
  assert(
    md.includes("1111222233334444555566667777888899990000".slice(0, 8)),
    "markdown: names the default worktree's HEAD SHA",
  );
  assert(
    md.includes("aabbccddeeff0011223344556677889900112233".slice(0, 8)),
    "markdown: names the task-a worktree's HEAD SHA",
  );
  assert(md.includes("cherry-pick"), "markdown: offers a working cherry-pick command");
  assert(
    !md.includes("git add -p"),
    "markdown: does NOT offer the generic 'git add -p' main-checkout command",
  );
  assert(
    !/git -C [^\n]*status/.test(md) || !/git -C [^\n]*diff --stat/.test(md),
    "markdown: does NOT offer the generic 'git status' / 'git diff --stat' main-checkout commands",
  );
}

// ---------------------------------------------------------------------------
// 3. The chat surface names the actual worktree paths + HEAD SHAs.
// ---------------------------------------------------------------------------
{
  const chat = renderHandoffUserMessage(parkedDevelopState(), REPO, `${REPO}/tmp/issue-674`);
  assert(chat.includes(".worktrees/issue-674-default"), "chat: names the default worktree path");
  assert(chat.includes(".worktrees/issue-674-task-a"), "chat: names the task-a worktree path");
  assert(
    chat.includes("1111222233334444555566667777888899990000".slice(0, 8)),
    "chat: names the default worktree's HEAD SHA",
  );
  assert(
    chat.includes("aabbccddeeff0011223344556677889900112233".slice(0, 8)),
    "chat: names the task-a worktree's HEAD SHA",
  );
  assert(chat.includes("cherry-pick"), "chat: offers a working cherry-pick command");
  assert(
    !chat.includes("git add -p"),
    "chat: does NOT offer the generic 'git add -p' main-checkout command",
  );
  assert(
    !/git -C [^\n]*add -p/.test(chat),
    "chat: does NOT offer the generic 'git -C <repo> add -p' command",
  );
}

// ---------------------------------------------------------------------------
// 4. The consolidated variant says the branch contains the work.
// ---------------------------------------------------------------------------
{
  const md = renderHandoffMarkdown(parkedDevelopConsolidatedState());
  assert(
    md.includes("consolidated"),
    "markdown (consolidated): says the work was consolidated onto the branch",
  );
  assert(md.includes("feature/issue-674"), "markdown (consolidated): names the branch");
}

{
  const chat = renderHandoffUserMessage(
    parkedDevelopConsolidatedState(),
    REPO,
    `${REPO}/tmp/issue-674`,
  );
  assert(
    chat.includes("consolidated"),
    "chat (consolidated): says the work was consolidated onto the branch",
  );
}

// ---------------------------------------------------------------------------
// 5. The pre-branch cap (intent-park) with NO worktrees does NOT get
//    worktree-aware recovery.
// ---------------------------------------------------------------------------
{
  const s = parkedDevelopState();
  s.pipelineState.branchName = undefined;
  s.pipelineState.worktrees = {};
  s.pipelineState.handoffSnapshot = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: false,
    branchPushed: false,
    headSha: "99998888",
    capturedAt: 1000,
  };
  const { steps } = recoveryStepsForCap(s);
  const wtSteps = steps.filter(
    (st) => st.section === "worktree-work-consolidated" || st.section === "worktree-work-fallback",
  );
  assert(
    wtSteps.length === 0,
    "shared decision: no worktree-aware steps for a pre-branch cap with no worktrees",
  );
}

// ---------------------------------------------------------------------------
// 6. countAheadOfBase: returns 0 when no worktrees or no baseSha.
// ---------------------------------------------------------------------------
{
  const fakeExec = async () => ({ stdout: "2\n" });
  const r1 = await countAheadOfBase(fakeExec, REPO, undefined, { default: "/wt" });
  assert(r1.total === 0, "countAheadOfBase: returns 0 when no baseSha");

  const r2 = await countAheadOfBase(fakeExec, REPO, "base", {});
  assert(r2.total === 0, "countAheadOfBase: returns 0 when no worktrees");
}

// ---------------------------------------------------------------------------
// 7. workNotYetOnBranch: returns true when branch doesn't exist.
// ---------------------------------------------------------------------------
{
  const fakeExec = async (cmd: string) => {
    if (cmd.includes("rev-parse --verify")) throw new Error("not found");
    return { stdout: "1\n" };
  };
  const r = await workNotYetOnBranch(fakeExec, REPO, "feature/issue-674", "base", {
    default: "/wt",
  });
  assert(r === true, "workNotYetOnBranch: returns true when branch does not exist");
}

// ---------------------------------------------------------------------------
// 8. handoffConsolidationEnabled: respects the env var.
// ---------------------------------------------------------------------------
{
  const saved = process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE;
  process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE = "0";
  assert(
    handoffConsolidationEnabled() === false,
    "handoffConsolidationEnabled: PI_ENSEMBLE_HANDOFF_CONSOLIDATE=0 disables",
  );
  delete process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE;
  assert(handoffConsolidationEnabled() === true, "handoffConsolidationEnabled: enabled by default");
  if (saved !== undefined) process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE = saved;
}

// ---------------------------------------------------------------------------
// 9. captureCommittedWork: populates the snapshot's committedWork field.
// ---------------------------------------------------------------------------
{
  const snap = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: false,
    branchPushed: false,
    headSha: "",
    capturedAt: 0,
  };
  // captureCommittedWork shells out to real git (node child_process exec),
  // so this test uses a real temp worktree with a real commit.
  const dir = mkdtempSync(join(tmpdir(), "handoff-cw-"));
  try {
    const wt = join(dir, ".worktrees", "issue-674-default");
    mkdirSync(join(dir, ".worktrees"), { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: dir });
    execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "w1"], { cwd: wt });
    execFileSync("git", ["commit", "--allow-empty", "-m", "w2"], { cwd: wt });
    const baseSha = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: dir })
      .toString()
      .trim();
    await captureCommittedWork(snap, dir, {
      baseSha,
      worktrees: { default: wt },
    });
    assert(
      snap.committedWork?.length === 1,
      "captureCommittedWork: populates committedWork when work is ahead of base",
    );
    assert(
      snap.committedWork?.[0]?.ahead === 2,
      "captureCommittedWork: records the correct ahead count",
    );
  } finally {
    try {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", join(dir, ".worktrees", "issue-674-default")],
        { cwd: dir },
      );
    } catch {
      /* worktree already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
