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
import { appendEvent, initialState, type WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";

const dirtyFixture = (dirty?: boolean): WorkState => {
  let s = initialState(481, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "handoff" as const,
      currentStep: "handoff" as const,
      lastCompletedStep: "commit-pr" as const,
      branchName: "feature/issue-481-worktree-provision",
      worktrees: { default: `${REPO}/.worktrees/issue-481-default` },
      baseSha: "abc1234",
      workstreamBaseShas: { default: "abc1234" },
      commitShas: { default: "def5678" },
      incompleteConsolidation: {
        verdicts: [
          {
            id: "default",
            status: "uncovered" as const,
            uncoveredPaths: ["extension/src/worktree-provision.ts"],
            ...(dirty !== undefined ? { dirty } : {}),
          },
        ],
        filesPresent: ["extension/src/other.ts"],
      },
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_500,
    cap: "commit-pr-incomplete-consolidation",
    reviewRound: 0,
    nextStep: "handoff",
  });
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
