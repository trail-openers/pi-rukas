#!/usr/bin/env bun
/**
 * #1852 — the lens-fix scope fence refuses a widening BEFORE anything pushes.
 *
 * The gate (`lensFixFenceCheck`) is what the lens-fix step never had: the fix
 * pass's fence ran between a pass's dispatch and its push, and the lens fix had
 * no equivalent, so every landing arm committed and pushed whatever the fixer
 * wrote anywhere in the tree. These are real-git tests: a fixture repo with a
 * real `.worktrees/` tree, a real round tip, and the driver's own
 * `postPassFault`/admission ladder underneath the gate.
 *
 * Each case asserts a refusal (or its absence) AND that the refusal says why,
 * because the park reason is the only thing the operator reads.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import type { PassPlan } from "../src/work-driver-adversarial-fix-scope.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import {
  lensFixFenceCheck,
  lensFixPlanFromSnapshot,
  lensFixRevertAlreadyUsed,
} from "../src/work-driver-lens-fix-fence-gate.ts";
import { lensFixPassPlan } from "../src/work-driver-lens-fix-fence.ts";
import type { LensFixFenceSnapshot } from "../src/workflow-state-schema.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";
import { git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FINDINGS = '[{"path":"a.txt","severity":"MEDIUM","title":"t","suggestion":"s"}]';

/** A repo with a develop commit, plus a `.worktrees/` tree sitting on it. */
function cycle(label: string): { repoRoot: string; tree: string; roundTip: string } {
  const repoRoot = repoWithFile(label);
  const tree = `${repoRoot}/.worktrees/issue-1852`;
  git(repoRoot, "worktree add -q --detach .worktrees/issue-1852 HEAD");
  writeFileSync(`${tree}/a.txt`, "two\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "develop: the feature"');
  return { repoRoot, tree, roundTip: git(tree, "rev-parse HEAD").trim() };
}

function stateFor(
  repoRoot: string,
  tree: string,
  declared: string[],
  outOfScope: string[],
): WorkState {
  const s = initialState(1852, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "lens-fix",
      reviewRound: 1,
      baseSha: git(repoRoot, "rev-parse HEAD").trim(),
      branchName: "feature/issue-1852",
      worktrees: { default: tree },
      workstreams: {
        default: { id: "default", scope: "fix the thing", paths: declared, outOfScope },
      },
    },
  };
}

async function snapshotFor(
  repoRoot: string,
  tree: string,
  roundTip: string,
  state: WorkState,
): Promise<LensFixFenceSnapshot> {
  const planned = await lensFixPassPlan(defaultExec, repoRoot, state.pipelineState, {
    id: "default",
    worktree: tree,
    roundTip,
    findings: FINDINGS,
  });
  if (!planned.ok) throw new Error(`plan failed: ${planned.reason}`);
  return {
    round: state.pipelineState.reviewRound,
    workstreamId: "default",
    roundTip,
    fence: { ...planned.value.fence, helperDirs: [...planned.value.fence.helperDirs] },
    declared: planned.value.declared,
    named: planned.value.named,
    candidates: [...planned.value.candidates],
    findings: planned.value.findings,
    worktree: tree,
  };
}

function ctxFor(repoRoot: string): CycleContext {
  return {
    host: { sendUserMessage: () => {}, emit: () => {} } as never,
    repoRoot,
    issue: 1852,
    verifyExecFn: defaultExec,
  } as unknown as CycleContext;
}

console.log("# a fix that stays inside the fence lands");
{
  const c = cycle("gate-ok");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,
    revertAlreadyUsed: false,
    fenceRecorded: true,
  });
  assert(v.ok, `an in-fence round is approved (reason: ${v.ok ? "" : v.reason})`);
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a stray in a worktree: reverted once, then allowed");
{
  const c = cycle("gate-stray");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  writeFileSync(`${c.tree}/scratch-notes.md`, "the fixer should not have written this\n");
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,
    revertAlreadyUsed: false,
    fenceRecorded: true,
    onRevertible: async () => {
      called++;
      // The test performs the revert the driver performs, then reports it.
      rmSync(`${c.tree}/scratch-notes.md`, { force: true });
      return {
        ok: true as const,
        event: {
          kind: "fix-pass-strays-reverted" as const,
          at: 1_500_000,
          workstreamId: "default",
          paths: ["scratch-notes.md"],
          preservedRef: "refs/pi-rukas/lens-fix-strays/1852/default-1",
          patchPath: "/tmp/1852-default-1.patch",
          source: "lens-fix" as const,
          round: 1,
        },
      };
    },
  });
  assert(called === 1, "the gate asked for exactly one revert");
  assert(
    v.ok,
    `a reverted first stray set does not park the round (reason: ${v.ok ? "" : v.reason})`,
  );
  assert(
    v.ok && v.revert?.source === "lens-fix" && v.revert.round === 1,
    "the revert record carries the lens-fix source and the round (the counter reads them)",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a SECOND stray set in the same round parks");
{
  const c = cycle("gate-second");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  writeFileSync(`${c.tree}/scratch-notes.md`, "again\n");
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,
    revertAlreadyUsed: true,
    fenceRecorded: true,
    onRevertible: async () => {
      called++;
      return {
        ok: true as const,
        event: {
          kind: "fix-pass-strays-reverted" as const,
          at: 1,
          workstreamId: "default",
          paths: [],
          preservedRef: "r",
          patchPath: "p",
        },
      };
    },
  });
  assert(
    !v.ok && v.reason.includes("SECOND"),
    `a second set parks with the reason that says so (${v.ok ? "APPROVED" : v.reason.slice(0, 90)})`,
  );
  assert(called === 0, "the gate does not revert a second time");
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# an outOfScope change parks and is never reverted");
{
  const c = cycle("gate-fenced");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  // Tracked AND committed in the round, so it is in the delta rather than the
  // working tree: an outOfScope file the fixer modified and committed.
  writeFileSync(`${c.tree}/b.txt`, "touched past the fence\n");
  git(c.tree, "add -A");
  git(c.tree, 'commit -q -m "widening past the fence"');
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,
    revertAlreadyUsed: false,
    fenceRecorded: true,
    onRevertible: async () => {
      called++;
      return undefined;
    },
  });
  assert(!v.ok, "the outOfScope change is refused");
  assert(
    v.ok === false && v.reason.includes("b.txt"),
    `the refusal names the fenced file (${v.ok ? "APPROVED" : v.reason.slice(0, 120)})`,
  );
  assert(
    called === 0,
    "an absolute refusal never reaches the revert — the fence wins over the driver's own convenience",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# the repo-root arm parks on ANY stray and says why");
{
  const c = cycle("gate-root");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  writeFileSync(`${c.tree}/scratch-notes.md`, "stray at the lens tree\n");
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    // The lens tree IS the tree the driver would revert into — here declared as
    // the repo root, which is the arm PM decision #1852-1 makes stricter.
    inWorktree: false,
    tree: c.tree,
    round: 1,
    revertAlreadyUsed: false,
    fenceRecorded: true,
    onRevertible: async () => {
      called++;
      return undefined;
    },
  });
  assert(
    !v.ok && v.reason.includes("repo root"),
    `the repo-root stray parks naming the tree as the reason the revert was skipped (${v.ok ? "APPROVED" : v.reason.slice(0, 120)})`,
  );
  assert(called === 0, "no revert is attempted at the repo root (PM decision #1852-1)");
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a RECORDED fence failure parks; no record at all means the gate does not run");
{
  const c = cycle("gate-nosnap");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const noSnap = {
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: undefined,
    inWorktree: true,
    tree: c.tree,
    round: 1,
    revertAlreadyUsed: false,
  };
  const v = await lensFixFenceCheck({ ...noSnap, fenceRecorded: true });
  assert(
    !v.ok,
    `a round that RECORDS a fence failure parks fail-closed — nothing pushes (${v.ok ? "APPROVED" : v.reason.slice(0, 90)})`,
  );
  const skipped = await lensFixFenceCheck({ ...noSnap, fenceRecorded: false });
  assert(
    skipped.ok,
    `a round with NO fence record at all is not judged — an older driver wrote this state (${skipped.ok ? "" : skipped.reason})`,
  );
  assert(
    skipped.ok && (skipped.notes[0] ?? "").includes("did not run"),
    "and the skip says so in its notes, where the trace says why",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a fence from another round cannot clear this one");
{
  const c = cycle("gate-stale-round");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: { ...snap, round: 4 },
    inWorktree: true,
    tree: c.tree,
    round: 1,
    revertAlreadyUsed: false,
    fenceRecorded: true,
  });
  assert(
    !v.ok && v.reason.includes("round 4"),
    `the gate refuses a fence belonging to another round (${v.ok ? "APPROVED" : v.reason.slice(0, 90)})`,
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# the counter reads source + round + workstream, nothing else");
{
  const base = initialState(1852, 1_000_000);
  const rev = (
    over: Partial<Extract<WorkEvent, { kind: "fix-pass-strays-reverted" }>>,
  ): WorkEvent => ({
    kind: "fix-pass-strays-reverted",
    at: 1,
    workstreamId: "default",
    paths: ["x"],
    preservedRef: "r",
    patchPath: "p",
    ...over,
  });
  const events: WorkEvent[] = [
    // A FIX PASS revert in the same round/workstream must not spend the round.
    rev({ source: "fix-pass", round: 1 }),
    // A lens-fix revert from another round, and one for another workstream.
    rev({ source: "lens-fix", round: 2 }),
    rev({ source: "lens-fix", round: 1, workstreamId: "other" }),
    // A pre-#1852 event with neither field — the fix pass's, by the default.
    rev({}),
  ];
  assert(
    !lensFixRevertAlreadyUsed(events, 1, "default"),
    "a fix pass's revert, another round's revert, another workstream's revert and a pre-#1852 record NONE of them spend this round's one revert",
  );
  assert(
    lensFixRevertAlreadyUsed([...events, rev({ source: "lens-fix", round: 1 })], 1, "default"),
    "the round's OWN lens-fix revert is what spends it",
  );
  void base;
}

console.log("# the plan is rebuilt from the recorded tip, not a fresh read");
{
  const c = cycle("gate-tip");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const plan: PassPlan = lensFixPlanFromSnapshot(snap, c.tree, st.pipelineState);
  assert(
    plan.headBefore === c.roundTip,
    "plan.headBefore is the RECORDED round tip (the round's own commits are not strays)",
  );
  assert(plan.worktree === c.tree, "the plan judges the tree the prompt was built from");
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
