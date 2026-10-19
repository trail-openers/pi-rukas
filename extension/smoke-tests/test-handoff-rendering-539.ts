#!/usr/bin/env bun
/**
 * #500 / #539 — the "tree is clean" variants of the commit-pr handoff (split
 * from test-handoff-rendering.ts for the 500-line gate). The clean-tree
 * variant says clean; the 12-untracked variant (#539, the "tree is clean"
 * lie) must NOT — it names the count, orders `git status` first, warns the
 * paths may belong to another cycle, and commits ONLY the patch paths. Both
 * surfaces. Plus the inspection-failed variant.
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

// The #500 fixture: a cycle that parked at commit-pr with a conflicted
// repoRoot, its eventLog carrying the ops-fallback plumb-report. The
// sections below mutate `commitPrRoot` per-variant.
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
      // #500 — the recorded repoRoot state at commit-pr handoff.
      commitPrRoot: {
        // Note: mutated per-variant by the sections below.
        branch: "feature/issue-481-worktree-provision",
        unmergedPaths: [
          "extension/src/worktree-provision.ts",
          "extension/smoke-tests/test-worktree-provision.ts",
        ],
        stagedCount: 8,
        totalEntries: 10,
        capturedAt: Date.now(),
      },
    },
    eventLog: [
      {
        kind: "plumb-report",
        at: 2,
        step: "commit-pr",
        role: "driver",
        body: "Mechanized commit-pr fell back to the ops dispatch: apply conflict. Note: the repo root may contain partially staged consolidation from the mechanized attempt — verify with `git status` before re-applying patches.",
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

// #500 (clean-tree variant) + #539 (the "tree is clean" lie): zero unmerged,
// zero staged, 12 untracked leftovers (the exact #533/#534 shape) must NOT
// render the clean framing — name the count, order `git status` first, warn
// the paths may belong to another cycle, commit ONLY the patch paths. The
// zero-entries variant must still say clean. Both surfaces.
{
  const variants = [
    { totalEntries: 0, expectClean: true, tag: "clean root" },
    { totalEntries: 12, expectClean: false, tag: "#539 untracked dirt" },
  ] as const;
  for (const v of variants) {
    const s = commitPrConflictedState();
    s.pipelineState.commitPrRoot = {
      branch: "feature/issue-481-worktree-provision",
      unmergedPaths: [],
      stagedCount: 0,
      totalEntries: v.totalEntries,
      capturedAt: Date.now(),
    };
    const outs = [
      ["markdown", renderHandoffMarkdown(s, REPO)],
      ["chat", renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`)],
    ] as const;
    for (const [name, out] of outs) {
      if (v.expectClean) {
        assert(/clean|as-is/.test(out), `${name} (${v.tag}): says the tree is clean`);
        assert(
          !/unmerged paths \(\d+\)/.test(out),
          `${name} (${v.tag}): does not claim unmerged paths`,
        );
      } else {
        assert(
          !/The tree is clean|apply as-is/.test(out),
          `${name} (${v.tag}): does NOT claim the tree is clean`,
        );
        assert(/NOT clean|not clean/i.test(out), `${name} (${v.tag}): says not clean`);
        assert(/12 untracked/.test(out), `${name} (${v.tag}): names the untracked count (12)`);
        assert(/git status/.test(out), `${name} (${v.tag}): orders a git status first`);
        assert(
          /another cycle/.test(out) && /\.pi\/work-state\//.test(out),
          `${name} (${v.tag}): warns the paths may belong to another cycle (check .pi/work-state/)`,
        );
        assert(
          /ONLY the applied patch paths/.test(out),
          `${name} (${v.tag}): recovery commits ONLY the applied patch paths`,
        );
      }
    }
  }
  // The inline cap blurb (explainCap → "What this cap means") must not claim
  // "apply as-is" on the dirty variant either — the same blind spot inline.
  const s = commitPrConflictedState();
  s.pipelineState.commitPrRoot = {
    branch: "feature/issue-481-worktree-provision",
    unmergedPaths: [],
    stagedCount: 0,
    totalEntries: 12,
    capturedAt: Date.now(),
  };
  // #1675 — the cause lead is the first ### section; the inline cap blurb is
  // the "What this cap means" section that follows it.
  const capSection =
    renderHandoffMarkdown(s, REPO).split("### What this cap means")[1]?.split("###")[0] ?? "";
  assert(
    !/apply as-is/.test(capSection),
    "markdown (#539): the cap blurb does not claim 'apply as-is'",
  );
  assert(
    /NOT clean|12 untracked/.test(capSection),
    "markdown (#539): the cap blurb names the dirty state",
  );
}

// #500 — the inspection-failed variant: the handoff says the state is
// unknown and tells the operator to run git status first.
{
  const s = commitPrConflictedState();
  s.pipelineState.commitPrRoot = undefined;
  s.pipelineState.commitPrRootError = "git status exited 128: not a git repository";
  for (const [name, out] of [
    ["markdown", renderHandoffMarkdown(s, REPO)],
    ["chat", renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`)],
  ] as const) {
    assert(
      /inspection failed/.test(out),
      `${name} (inspection failed): says the inspection failed`,
    );
  }
  assert(
    /git status/.test(renderHandoffMarkdown(s, REPO)),
    "markdown (inspection failed): tells the operator to run git status first",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
