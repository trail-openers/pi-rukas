#!/usr/bin/env bun
/**
 * #810 — the merge-subject seam: a parked cycle's consolidated single-commit
 * branch must merge with the PR title (not the driver's `chore(handoff):`
 * housekeeping commit subject), and the handoff's printed recovery commands
 * must carry the same explicit-subject merge command.
 *
 * Tests:
 *   1. The driver's merge step (mechanizedMerge) passes --subject (the PR
 *      title) for a parked, consolidated, single-commit branch.
 *   2. A normal (non-parked) cycle: no --subject flag, byte-identical to
 *      the pre-#810 merge command.
 *   3. The handoff recovery step-3 command includes the PR number and
 *      --squash (the subject is absent when the title is not in state).
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { mechanizedMerge } from "../src/work-driver-merged-mechanized.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { mkStateMerged } from "./work-driver-merged-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";

function mkCtx(issue: number, exec: VerifyExecFn): DriverContext {
  return {
    repoRoot: "/fake",
    issue,
    pi: { sendUserMessage: () => {} },
    verifyExecFn: exec,
    mergeGrant: true,
  } as unknown as DriverContext;
}

/** A minimal parked+consolidated state for the renderers. */
function parkedConsolidatedState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 337,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "explore",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-337-x",
      prNumber: 810,
      handoffSnapshot: {
        modifiedFiles: [],
        unstagedCount: 0,
        stagedCount: 0,
        branchExists: true,
        branchPushed: false,
        headSha: "abc12345",
        capturedAt: 1000,
        committedWork: [
          {
            worktreeId: "default",
            path: ".worktrees/issue-337-x-default",
            headSha: "deadbeef00112233445566778899001122334455",
            ahead: 1,
          },
        ],
      },
    },
    eventLog: [
      { kind: "cap-hit", at: 1, cap: "review-incomplete", reviewRound: 0, nextStep: "handoff" },
      {
        kind: "handoff-consolidated",
        at: 2,
        branchName: "feature/issue-337-x",
        workstreams: ["default"],
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    ] as any,
  };
}

// ---------------------------------------------------------------------------
// 1. Handoff recovery: step-3 is a squash-merge of the PR.
// ---------------------------------------------------------------------------
{
  const s = parkedConsolidatedState();
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-337`);
  for (const [name, out] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    assert(
      /gh pr merge 810 --squash/.test(out) || /glab mr merge 810 --squash/.test(out),
      `${name} (#810): the step-3 recovery command is a squash-merge of PR 810`,
    );
    // No --subject in the recovery when the PR title is not recorded in
    // state (the renderers don't have an exec seam to read it live).
    assert(
      !/--subject/.test(out),
      `${name} (#810): no --subject flag in the recovery (the title is not in state; degrades to pre-#810 form)`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Mechanized merge: parked + consolidated + single commit → --subject.
// ---------------------------------------------------------------------------
{
  const state = mkStateMerged(100, 42, "feature/issue-100", {});
  state.eventLog.push({
    kind: "handoff-consolidated",
    at: 99,
    branchName: "feature/issue-100",
    workstreams: ["default"],
  } as never);
  state.pipelineState.baseSha = "base000";
  const calls: string[] = [];
  let viewCount = 0;
  const exec: VerifyExecFn = async (cmd) => {
    calls.push(cmd);
    if (cmd.includes("gh repo view"))
      return {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    if (cmd.includes("git rev-list --count")) return { stdout: "1" };
    if (cmd.includes("--json title")) return { stdout: "fix(work): the real change description" };
    if (cmd.includes("gh pr view")) {
      viewCount++;
      return { stdout: viewCount === 1 ? "OPEN" : "MERGED" };
    }
    if (cmd.includes("gh pr merge")) return { stdout: "Merged" };
    return { stdout: "" };
  };
  const r = await mechanizedMerge(mkCtx(100, exec), state);
  assert(
    r.ok === true,
    `#810: mechanizedMerge succeeds for a parked consolidated single-commit branch (got: ${JSON.stringify(r)})`,
  );
  const mergeCmd = calls.find((c) => c.includes("gh pr merge"));
  assert(
    mergeCmd?.includes("--subject") && mergeCmd?.includes("fix(work): the real change description"),
    `#810: the merge command carries the explicit --subject (the PR title): ${mergeCmd ?? "(no merge cmd found)"}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Normal (non-parked) cycle: no --subject flag.
// ---------------------------------------------------------------------------
{
  const state = mkStateMerged(200, 55, "feature/issue-200", {});
  state.pipelineState.baseSha = "base000";
  const calls: string[] = [];
  let viewCount = 0;
  const exec: VerifyExecFn = async (cmd) => {
    calls.push(cmd);
    if (cmd.includes("gh repo view"))
      return {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    if (cmd.includes("gh pr view")) {
      viewCount++;
      return { stdout: viewCount === 1 ? "OPEN" : "MERGED" };
    }
    if (cmd.includes("gh pr merge")) return { stdout: "Merged" };
    return { stdout: "" };
  };
  const r = await mechanizedMerge(mkCtx(200, exec), state);
  assert(r.ok === true, `#810: normal (non-parked) merge succeeds (got: ${JSON.stringify(r)})`);
  const mergeCmd = calls.find((c) => c.includes("gh pr merge"));
  assert(
    !mergeCmd?.includes("--subject"),
    `#810: normal cycle merge carries NO --subject flag (byte-identical to pre-#810): ${mergeCmd ?? "(none)"}`,
  );
}

// ---------------------------------------------------------------------------
console.log(`\nexit ${exit}`);
process.exit(exit);
