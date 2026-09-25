#!/usr/bin/env bun
/**
 * #875 — dirty-flag rendering: the recovery-step generator branches on the
 * persisted per-workstream `dirty` flag. dirty=false → cherry-pick line,
 * no `add -A` / `git apply`. dirty=true → `add -A` + `diff --cached | git apply`.
 * Legacy (no flag) → treated as dirty (old wording).
 *
 * Extracted from test-handoff-rendering.ts (AGENTS.md §12 file-size limit).
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

/** Minimal commit-pr-incomplete-consolidation state for dirty-flag testing. */
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
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 3,
        cap: "commit-pr-incomplete-consolidation",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

const dirtyFixture = (dirty?: boolean): WorkState => {
  const s = commitPrConflictedState();
  s.pipelineState.incompleteConsolidation = {
    verdicts: [
      {
        id: "default",
        status: "uncovered",
        uncoveredPaths: ["extension/src/worktree-provision.ts"],
        ...(dirty !== undefined ? { dirty } : {}),
      },
    ],
    filesPresent: ["extension/src/other.ts"],
  } as any;
  s.pipelineState.commitPrRoot = {
    branch: "feature/issue-481-worktree-provision",
    unmergedPaths: [],
    stagedCount: 0,
    totalEntries: 0,
    capturedAt: Date.now(),
  };
  // Persisted SHAs for the cherry-pick line (dirty=false path).
  s.pipelineState.baseSha = "abc1234";
  s.pipelineState.workstreamBaseShas = { default: "abc1234" };
  s.pipelineState.commitShas = { default: "def5678" };
  return s;
};

for (const [name, dirty, expectCherryPick, expectAddApply] of [
  ["dirty=false", false, true, false],
  ["dirty=true", true, false, true],
  ["legacy (no flag)", undefined, false, true],
] as const) {
  const s = dirtyFixture(dirty);
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);
  for (const [surface, out] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    if (expectCherryPick) {
      assert(out.includes("cherry-pick"), `${surface} (#875 ${name}): has cherry-pick line`);
      assert(!out.includes("add -A"), `${surface} (#875 ${name}): no 'add -A'`);
      assert(!/git (?:-C \S+ )?apply/.test(out), `${surface} (#875 ${name}): no 'git apply'`);
    }
    if (expectAddApply) {
      assert(out.includes("add -A"), `${surface} (#875 ${name}): has 'add -A'`);
      assert(/git (?:-C \S+ )?apply/.test(out), `${surface} (#875 ${name}): has 'git apply'`);
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
