#!/usr/bin/env bun
/**
 * #794 (task-b) — the handoff recovery commands must not reproduce the
 * #775 failure.
 *
 * For a dependsOn STACK (A → B → C → D, each worktree based on its
 * dependency's tip, ahead-of-base counts 1/2/3/4), the pre-#794 recovery
 * printed `git cherry-pick <headSha>` for EVERY worktree — sequential picks
 * that replay each ancestor once per level of the stack. Following the
 * printed instructions reproduced the failure. The fix prints only the
 * dependency LEAVES (the worktree(s) no other workstream builds on), which
 * carry the union of the stack's commits.
 *
 * This test pins both directions:
 *  - a stacked cycle prints exactly ONE cherry-pick line (the leaf's tip);
 *  - a cycle with NO dependsOn declarations (the N-disjoint case, and
 *    pre-#679 state files) prints one cherry-pick line per worktree —
 *    byte-identical to the pre-#794 behaviour.
 */

import { dependencyLeaves } from "../src/work-driver-leaf-selection.ts";
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
const issue = 775;
const BRANCH = "feature/issue-775";

// Distinct, easily-greppable 40-char SHAs per workstream.
const SHAs: Record<string, string> = {
  prep: "111122223333444455556666777788889999aaaa",
  "label-verify": "22223333444455556666777788889999aaaabbbb",
  "forge-seams": "3333444455556666777788889999aaaabbbcccc",
  "banner-tests": "444455556666777788889999aaaabbbccccddd",
};

function committedWork(wt: string, ahead: number) {
  return {
    worktreeId: wt,
    path: `${REPO}/.worktrees/issue-${issue}-${wt}`,
    headSha: SHAs[wt],
    ahead,
  };
}

function stackedState(): WorkState {
  return {
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
      branchName: BRANCH,
      baseSha: "aaaa11111111111111111111111111111111111111",
      worktrees: {
        prep: `${REPO}/.worktrees/issue-${issue}-prep`,
        "label-verify": `${REPO}/.worktrees/issue-${issue}-label-verify`,
        "forge-seams": `${REPO}/.worktrees/issue-${issue}-forge-seams`,
        "banner-tests": `${REPO}/.worktrees/issue-${issue}-banner-tests`,
      },
      workstreams: {
        prep: { id: "prep" },
        "label-verify": { id: "label-verify", dependsOn: ["prep"] },
        "forge-seams": { id: "forge-seams", dependsOn: ["label-verify"] },
        "banner-tests": { id: "banner-tests", dependsOn: ["forge-seams"] },
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
          committedWork("prep", 1),
          committedWork("label-verify", 2),
          committedWork("forge-seams", 3),
          committedWork("banner-tests", 4),
        ],
      },
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 3,
        cap: "consolidated-verify-conflict",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

// ---------------------------------------------------------------------------
// 1. A #775-shaped stack prints exactly ONE cherry-pick — the leaf's tip.
// ---------------------------------------------------------------------------
{
  const { steps } = recoveryStepsForCap(stackedState());
  const pickLines = steps
    .filter((s) => s.section === "worktree-work-fallback")
    .flatMap((s) => s.lines)
    .filter((l) => l.includes("git cherry-pick"));
  assert(pickLines.length === 1, "stack: exactly one cherry-pick command is printed");
  assert(
    pickLines[0]?.includes(SHAs["banner-tests"]),
    "stack: the single pick is the leaf workstream's tip (banner-tests)",
  );
  assert(
    !pickLines.join("\n").includes(SHAs["label-verify"]),
    "stack: an intermediate ancestor's HEAD is not a pick target",
  );
  assert(
    !pickLines.join("\n").includes(SHAs["prep"]),
    "stack: the root ancestor's HEAD is not a pick target",
  );
  const allLines = steps.flatMap((s) => [...s.comment, ...s.lines]).join("\n");
  assert(
    allLines.includes("dependsOn") || allLines.includes("stack"),
    "stack: the printed block explains why only the leaf is picked",
  );
  assert(allLines.includes("tip of the dependency chain"), "stack: the pick is named as the tip of the dependency chain");
}

// ---------------------------------------------------------------------------
// 2. No dependsOn declarations — every worktree is its own leaf; the
//    per-worktree list is byte-identical to the pre-#794 behaviour.
// ---------------------------------------------------------------------------
{
  const s = stackedState();
  s.pipelineState.workstreams = {
    "task-a": { id: "task-a" },
    "task-b": { id: "task-b" },
  };
  s.pipelineState.handoffSnapshot.committedWork = [
    {
      worktreeId: "task-a",
      path: `${REPO}/.worktrees/issue-775-task-a`,
      headSha: "aabbccddeeff0011223344556677889900112233",
      ahead: 1,
    },
    {
      worktreeId: "task-b",
      path: `${REPO}/.worktrees/issue-775-task-b`,
      headSha: "ffeeddccbbaa0011223344556677889900112233",
      ahead: 2,
    },
  ];
  const { steps } = recoveryStepsForCap(s);
  const pickLines = steps
    .filter((st) => st.section === "worktree-work-fallback")
    .flatMap((st) => st.lines)
    .filter((l) => l.includes("git cherry-pick"));
  assert(pickLines.length === 2, "disjoint: one cherry-pick per worktree when no dependsOn is declared");
  assert(
    pickLines.join("\n").includes("aabbccddeeff0011223344556677889900112233"),
    "disjoint: task-a's HEAD is picked",
  );
  assert(
    pickLines.join("\n").includes("ffeeddccbbaa0011223344556677889900112233"),
    "disjoint: task-b's HEAD is picked",
  );
  const allLines = steps.flatMap((st) => [...st.comment, ...st.lines]).join("\n");
  assert(!allLines.includes("tip of the dependency chain"), "disjoint: no stack-only explanation is printed");
}

// ---------------------------------------------------------------------------
// 3. Pre-#775 / pre-#679 state files have NO `workstreams` field at all —
//    the same disjoint behaviour must hold (absent map ≡ all independent).
// ---------------------------------------------------------------------------
{
  const s = stackedState();
  delete (s.pipelineState as Record<string, unknown>).workstreams;
  const { steps } = recoveryStepsForCap(s);
  const pickLines = steps
    .filter((st) => st.section === "worktree-work-fallback")
    .flatMap((st) => st.lines)
    .filter((l) => l.includes("git cherry-pick"));
  assert(pickLines.length === 4, "no workstreams map: one pick per worktree (pre-#679 shape)");
}

// ---------------------------------------------------------------------------
// 4. dependencyLeaves unit checks: chain, diamond, and independent sets.
// ---------------------------------------------------------------------------
{
  const chain = dependencyLeaves(
    ["a", "b", "c"],
    { a: [], b: ["a"], c: ["b"] },
  );
  assert(
    chain.length === 1 && chain[0] === "c",
    "dependencyLeaves: a 3-deep chain yields the single leaf 'c'",
  );

  const diamond = dependencyLeaves(
    ["a", "b", "c", "d"],
    { a: [], b: [], c: ["a", "b"], d: ["c"] },
  );
  assert(
    diamond.length === 1 && diamond[0] === "d",
    "dependencyLeaves: a diamond yields the single leaf 'd'",
  );

  const disjoint = dependencyLeaves(["a", "b", "c"], { a: [], b: [], c: [] });
  assert(
    disjoint.length === 3,
    "dependencyLeaves: no dependsOn edges → every workstream is a leaf",
  );

  const absentMap = dependencyLeaves(["a", "b"], undefined);
  assert(absentMap.length === 2, "dependencyLeaves: absent dependsOn map → every workstream is a leaf");

  // Ids present in the map but not in the picked set are ignored.
  const subset = dependencyLeaves(["b"], { a: [], b: ["a"] });
  assert(
    subset.length === 1 && subset[0] === "b",
    "dependencyLeaves: the dependsOn map may cover ids outside the picked set",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
