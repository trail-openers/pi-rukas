#!/usr/bin/env bun
/**
 * #539 — the untracked-dirt handoff variant: a tree whose only dirt is
 * untracked residue (the exact shape that wedged #533/#534's cycles) must
 * NOT render "clean". The recovery block must say "run git status first"
 * and carry the sweep-safe instruction.
 *
 * Split from test-handoff-rendering.ts for the 500-line hard cap.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
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

/** A cycle that parked at commit-pr with a conflicted repoRoot. */
function commitPrConflictedState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 481,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "commit-pr",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-481-worktree-provision",
      worktrees: {},
      incompleteConsolidation: [
        { id: "default", paths: ["extension/src/worktree-provision.ts"] },
        { id: "task-b", paths: ["extension/smoke-tests/test-worktree-provision.ts"] },
      ],
      commitPrRoot: {
        branch: "feature/issue-481-worktree-provision",
        unmergedPaths: [],
        stagedCount: 0,
        totalEntries: 3,
        capturedAt: Date.now(),
      },
    },
    eventLog: [
      {
        kind: "plumb-report",
        at: 2,
        step: "commit-pr",
        role: "driver",
        body: "Mechanized commit-pr fell back to the ops dispatch: apply conflict.",
      },
      {
        kind: "cap-hit",
        at: 3,
        cap: "commit-pr-incomplete-consolidation",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
  };
}

{
  const s = commitPrConflictedState();
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);

  // The handoff must NOT say the tree is clean (the old lie).
  const notClean = /(?<!NOT )clean(?![a-z])/;
  assert(!notClean.test(md), "markdown (untracked dirt): does NOT render standalone 'clean'");
  assert(!/apply as-is/.test(md), "markdown (untracked dirt): does NOT say 'apply as-is'");
  assert(!notClean.test(chat), "chat (untracked dirt): does NOT render standalone 'clean'");
  assert(!/apply as-is/.test(chat), "chat (untracked dirt): does NOT say 'apply as-is'");

  // The handoff must say the tree is NOT clean and name the untracked count.
  assert(/NOT clean/.test(md), "markdown (untracked dirt): says the tree is NOT clean");
  assert(/3 untracked/.test(md), "markdown (untracked dirt): names the untracked count (3)");
  assert(/NOT clean/.test(chat), "chat (untracked dirt): says the tree is NOT clean");

  // The recovery block must say "run git status first" and carry the
  // sweep-safe instruction.
  assert(
    /git status/.test(md),
    "markdown (untracked dirt): tells the operator to run git status first",
  );
  assert(
    /commit ONLY the applied patch paths/i.test(md),
    "markdown (untracked dirt): carries the sweep-safe commit instruction",
  );
  assert(
    /git status/.test(chat),
    "chat (untracked dirt): tells the operator to run git status first",
  );
  assert(
    /commit ONLY the applied patch paths/i.test(chat),
    "chat (untracked dirt): carries the sweep-safe commit instruction",
  );

  // AC5: the dirty-cause line must mention checking .pi/work-state/.
  assert(
    /\.pi\/work-state\//.test(md),
    "markdown (untracked dirt): mentions checking .pi/work-state/ before discarding",
  );
  assert(
    /\.pi\/work-state\//.test(chat),
    "chat (untracked dirt): mentions checking .pi/work-state/ before discarding",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
