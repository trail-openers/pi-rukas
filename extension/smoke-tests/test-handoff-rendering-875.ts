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

// #875 LOW round — the dirty=false cherry-pick line must be qualified to the
// workstream's OWN worktree on BOTH surfaces, and the chat renderer's
// `requalifyLine` must leave a worktree-qualified pick alone (the
// `git -C .worktrees/<x>…` rule rewrites it to the absolute path; the
// repo-root re-anchoring rule only fires on unqualified `git` lines).
{
  const s = dirtyFixture(false);
  const wt = `${REPO}/.worktrees/issue-481-default`;
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);
  // The recorded worktree is absolute; the markdown surface still emits the
  // in-tree-relative qualifier (`git -C .worktrees/<x>` — the shape
  // `requalifyLine` rewrites cleanly), and the chat surface gets the
  // absolute path from that rewrite — never the repoRoot-anchored
  // `git -C <repoRoot> cherry-pick` shape (re-anchoring would requalify the
  // line as if it were an integration-tree command).
  assert(
    md.includes("git -C .worktrees/issue-481-default cherry-pick abc1234..def5678"),
    "markdown: cherry-pick line is qualified to the worktree (in-tree relative path)",
  );
  assert(
    chat.includes(`git -C ${wt} cherry-pick abc1234..def5678`),
    "chat: requalifyLine rewrites the worktree qualifier to the absolute path",
  );
  assert(
    !chat.includes(`git -C ${REPO} cherry-pick`),
    "chat: cherry-pick is NOT re-anchored at repoRoot",
  );
}

// #875 LOW round — a RELATIVE recorded worktree path renders in-tree-relative
// on the markdown surface (`.worktrees/issue-481-default`) and `requalifyLine`
// rewrites the qualifier to the absolute path on the chat surface.
{
  let s = dirtyFixture(false);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { default: ".worktrees/issue-481-default" },
    },
  };
  const wt = `${REPO}/.worktrees/issue-481-default`;
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);
  assert(
    md.includes("git -C .worktrees/issue-481-default cherry-pick abc1234..def5678"),
    "markdown (relative worktree): in-tree-relative qualifier on the pick",
  );
  assert(
    chat.includes(`git -C ${wt} cherry-pick abc1234..def5678`),
    "chat (relative worktree): requalifyLine rewrote the qualifier to the absolute path",
  );
}

// #875 LOW round — when the base SHA is absent (no cycle base, no per-
// workstream base), the cherry-pick line must be plain text naming the
// problem — never a command interpolating a placeholder.
{
  let s = dirtyFixture(false);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      baseSha: undefined,
      workstreamBaseShas: {},
    },
  };
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);
  for (const [surface, out] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    assert(out.includes("base SHA"), `${surface}: no-base case names the missing base SHA`);
    assert(!out.includes("(base)"), `${surface}: no '(base)' placeholder in the output`);
    assert(!/git (?:-C \S+ )?cherry-pick/.test(out), `${surface}: no cherry-pick command rendered`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
