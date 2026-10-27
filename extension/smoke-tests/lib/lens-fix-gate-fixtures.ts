/**
 * Shared fixtures for `test-lens-fix-fence-gate.ts` (#1852).
 *
 * The gate's cases all need the same three things — a repo with a develop commit
 * and a `.worktrees/` tree sitting on it, a `WorkState` whose declared/out-of-scope
 * paths point at that tree, and a `LensFixFenceSnapshot` built from a real plan —
 * and they differ only in what they then write into the tree or add to the log.
 * Those builders live here so the test file spends its lines on verdicts.
 */
import { writeFileSync } from "node:fs";
import { defaultExec } from "../../src/work-driver-adversarial-fix-git.ts";
import type { CycleContext } from "../../src/work-driver-context.ts";
import { lensFixPassPlan } from "../../src/work-driver-lens-fix-fence.ts";
import type { LensFixFenceSnapshot } from "../../src/workflow-state-schema.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import { initialState } from "../../src/workflow-state.ts";
import { git, repoWithFile, silentSink } from "./adversarial-fix-fixtures.ts";

/** The findings the fixture round is fixing: one in-fence file, one out. */
export const FINDINGS = '[{"path":"a.txt","severity":"MEDIUM","title":"t","suggestion":"s"}]';

/** A repo with a base commit, one develop commit, plus a `.worktrees/` tree on it. */
export function cycle(label: string): { repoRoot: string; tree: string; roundTip: string } {
  const repoRoot = repoWithFile(label);
  const tree = `${repoRoot}/.worktrees/issue-1852`;
  git(repoRoot, "worktree add -q --detach .worktrees/issue-1852 HEAD");
  writeFileSync(`${tree}/a.txt`, "two\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "develop: the feature"');
  return { repoRoot, tree, roundTip: git(tree, "rev-parse HEAD").trim() };
}

export function stateFor(
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

/**
 * A real fence snapshot for a round, built through `lensFixPassPlan` rather than
 * hand-written, so the gate is judged against the record the step actually makes.
 */
export async function snapshotFor(
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

/**
 * The context a gate case drives. `issue` and `repoRoot` are load-bearing: the
 * stray revert spells its preserved ref and patch name from them
 * (`fix-pass-strays-<issue>-<workstream>`), and `verifyExecFn` is the transport
 * that revert uses — a context missing either reaches the revert's path builder
 * with an undefined issue and it refuses, which is not the outcome a gate test
 * means to observe.
 */
export function ctxFor(repoRoot: string): CycleContext {
  return {
    host: { sendUserMessage: () => {}, emit: () => {} } as never,
    repoRoot,
    issue: 1852,
    emitSink: silentSink,
    verifyExecFn: defaultExec,
  } as unknown as CycleContext;
}
