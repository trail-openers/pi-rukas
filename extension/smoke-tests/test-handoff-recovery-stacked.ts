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
// The cycle's global base and the stack root's recorded workstream base
// (the dependency's tip at deferred-creation time; #861 decision 6).
const BASE_SHA = "aaaa11111111111111111111111111111111111111";
const PREP_BASE = "cccc22222222222222222222222222222222222222";

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
      baseSha: BASE_SHA,
      workstreamBaseShas: { prep: PREP_BASE },
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
    pickLines[0]?.includes(`${BASE_SHA}..${SHAs["banner-tests"]}`),
    "stack: the single pick is a range from the cycle's baseSha to the leaf's tip (root's own base is prep's head)",
  );
  assert(
    !pickLines.join("\n").includes(SHAs["label-verify"]),
    "stack: an intermediate ancestor's HEAD is not a pick target",
  );
  assert(
    !pickLines.join("\n").includes(SHAs["prep"]),
    "stack: the root ancestor's HEAD is not a pick target",
  );
  assert(
    !pickLines.join("\n").includes(PREP_BASE),
    "stack: the root's workstream base (its parent's tip) is not emitted — rootBase is the stack root's own base",
  );
}

// ---------------------------------------------------------------------------
// 1a. #861 — a workstream base RECORDED for the stack root is used verbatim
//     as rootBase (the deferred-creation shape where the root itself was
//     created from a dependency's tip outside this stack).
// ---------------------------------------------------------------------------
{
  const s = stackedState();
  s.pipelineState.workstreams = {
    "label-verify": { id: "label-verify", dependsOn: ["prep"] },
    "forge-seams": { id: "forge-seams", dependsOn: ["label-verify"] },
    "banner-tests": { id: "banner-tests", dependsOn: ["forge-seams"] },
  };
  const { steps } = recoveryStepsForCap(s);
  const pickLines = steps
    .filter((s) => s.section === "worktree-work-fallback")
    .flatMap((s) => s.lines)
    .filter((l) => l.includes("git cherry-pick"));
  assert(pickLines.length === 1, "recorded base: exactly one cherry-pick command is printed");
  // The map's recorded base is PREP's own base (the parent's tip); the pick
  // root's OWN base is prep's head — so the emitted range runs from BASE_SHA
  // and never emits the recorded PREP_BASE as rootBase.
  assert(
    pickLines[0]?.includes(`${BASE_SHA}..${SHAs["banner-tests"]}`),
    "recorded base: a recorded workstream base that is not the pick root's own base is not used as rootBase",
  );
  assert(
    !pickLines.join("\n").includes(PREP_BASE),
    "recorded base: the map's non-root base is not emitted on the recovery line",
  );
}

// ---------------------------------------------------------------------------
// 1a-2. #861 — a workstream whose own `workstreamBaseShas` is the stack
//     root's base: a 2-node diamond where `a` and `b` are independent
//     (no dependsOn between them) and both are in `toPick` — the case
//     where the LEAF is also the root (single-element toPick).
//     `a` (base at PICK_BASE, no dependsOn) → the sole leaf.
// ---------------------------------------------------------------------------
{
  const s = stackedState();
  const PICK_BASE = "dddd33333333333333333333333333333333333333";
  s.pipelineState.worktrees = {
    a: `${REPO}/.worktrees/issue-${issue}-a`,
  };
  s.pipelineState.workstreams = {
    a: { id: "a" },
    b: { id: "b", dependsOn: ["a"] },
  };
  s.pipelineState.workstreamBaseShas = { a: PICK_BASE };
  s.pipelineState.handoffSnapshot.committedWork = [
    {
      worktreeId: "a",
      path: `${REPO}/.worktrees/issue-${issue}-a`,
      headSha: SHAs["prep"],
      ahead: 1,
    },
  ];
  const { steps } = recoveryStepsForCap(s);
  const pickLines = steps
    .filter((st) => st.section === "worktree-work-fallback")
    .flatMap((st) => st.lines)
    .filter((l) => l.includes("git cherry-pick"));
  // committedWork has only 'a'; toPick = ['a'] (a is the only leaf); stacked = false
  // (1 < 1 is false) → per-leaf pick, not a range. The workstreamBaseShas path
  // is not exercised here (no range pick).
  assert(pickLines.length === 1, "own base: one cherry-pick for a single-element committedWork");
  assert(
    pickLines[0]?.includes(SHAs["prep"]),
    "own base: single leaf picks its own head SHA (no range)",
  );
}

// ---------------------------------------------------------------------------
// 1b. #861 — no recorded base for the stack root: the pick range falls back
//     to the cycle's baseSha (and with no dependsOn map at all the pick
//     stays a bare single-SHA pick — the pre-#679 shape).
// ---------------------------------------------------------------------------
{
  const s = stackedState();
  delete s.pipelineState.workstreams;
  const { steps } = recoveryStepsForCap(s);
  const pickLines = steps
    .filter((s) => s.section === "worktree-work-fallback")
    .flatMap((s) => s.lines)
    .filter((l) => l.includes("git cherry-pick"));
  assert(pickLines.length === 4, "fallback: no dependsOn map → one pick per worktree (pre-#679 shape)");
  assert(
    !pickLines.join("\n").includes(".."),
    "fallback: per-leaf picks are single-SHA picks, not a range",
  );
}

// ---------------------------------------------------------------------------
// 1c. #861 — a disjoint leaf that IS a dependency root gets its own
//     per-leaf pick: a recorded workstream base is never emitted for a
//     disjoint (non-stacked) pick.
// ---------------------------------------------------------------------------
{
  const s = stackedState();
  s.pipelineState.worktrees = {
    "task-a": `${REPO}/.worktrees/issue-${issue}-task-a`,
    "task-b": `${REPO}/.worktrees/issue-${issue}-task-b`,
  };
  s.pipelineState.workstreams = {
    "task-a": { id: "task-a" },
    "task-b": { id: "task-b" },
  };
  s.pipelineState.workstreamBaseShas = { "task-a": PREP_BASE };
  s.pipelineState.handoffSnapshot.committedWork = [
    {
      worktreeId: "task-a",
      path: `${REPO}/.worktrees/issue-${issue}-task-a`,
      headSha: "aabbccddeeff0011223344556677889900112233",
      ahead: 1,
    },
    {
      worktreeId: "task-b",
      path: `${REPO}/.worktrees/issue-${issue}-task-b`,
      headSha: "ffeeddccbbaa0011223344556677889900112233",
      ahead: 2,
    },
  ];
  const { steps } = recoveryStepsForCap(s);
  const pickLines = steps
    .filter((s) => s.section === "worktree-work-fallback")
    .flatMap((s) => s.lines)
    .filter((l) => l.includes("git cherry-pick"));
  assert(pickLines.length === 2, "disjoint-with-base: one cherry-pick per worktree");
  assert(
    !pickLines.join("\n").includes(PREP_BASE),
    "disjoint-with-base: a disjoint leaf's recorded workstream base is never emitted (no range pick)",
  );
}

// ---------------------------------------------------------------------------
// 1d. #861 — a stacked state where the stack root IS a leaf (the workstreams
//     map covers only the dependent chain; the root sits below it untracked),
//     plus the stack-only comment still explains the block.
// ---------------------------------------------------------------------------
{
  const s = stackedState();
  s.pipelineState.workstreams = {
    prep: { id: "prep" },
    "label-verify": { id: "label-verify", dependsOn: ["prep"] },
  };
  s.pipelineState.handoffSnapshot.committedWork = [
    committedWork("prep", 1),
    committedWork("label-verify", 2),
  ];
  const { steps } = recoveryStepsForCap(s);
  const pickLines = steps
    .filter((s) => s.section === "worktree-work-fallback")
    .flatMap((s) => s.lines)
    .filter((l) => l.includes("git cherry-pick"));
  assert(pickLines.length === 1, "stack root leaf: exactly one cherry-pick command is printed");
  assert(
    pickLines[0]?.includes(BASE_SHA + ".." + SHAs["label-verify"]),
    "stack root leaf: the pick range runs from the cycle's baseSha to the leaf's tip",
  );
  const allLines = steps.flatMap((s) => [...s.comment, ...s.lines]).join("\n");
  assert(
    allLines.includes("dependsOn") || allLines.includes("stack"),
    "stack: the printed block explains why only the leaf is picked",
  );
  assert(
    allLines.includes("applies every commit of the stack in order"),
    "stack: the pick is explained as applying every commit of the stack in order",
  );
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
    !pickLines.join("\n").includes(".."),
    "disjoint: per-leaf picks are single-SHA picks, not a range",
  );
  assert(
    pickLines.join("\n").includes("aabbccddeeff0011223344556677889900112233"),
    "disjoint: task-a's HEAD is picked",
  );
  assert(
    pickLines.join("\n").includes("ffeeddccbbaa0011223344556677889900112233"),
    "disjoint: task-b's HEAD is picked",
  );
  const allLines = steps.flatMap((st) => [...st.comment, ...st.lines]).join("\n");
  assert(!allLines.includes("applies every commit of the stack in order"), "disjoint: no stack-only explanation is printed");
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
