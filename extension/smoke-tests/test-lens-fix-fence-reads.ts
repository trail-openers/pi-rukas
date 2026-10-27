#!/usr/bin/env bun
/**
 * #1852 — the lens-fix fence's two pure reads: the revert allowance and the
 * plan rebuilt from a record.
 *
 * Both are the parts of `work-driver-lens-fix-fence-gate.ts` that need no git:
 * the allowance is a scan of the event log, and the plan is a projection of the
 * persisted fence snapshot. They are separated from `test-lens-fix-fence-gate.ts`
 * (which is real-git throughout) because their value is that they cannot pass on
 * a fixture accident — no tree, no index, no tip to get wrong.
 */

import { rmSync } from "node:fs";
import {
  lensFixPlanFromSnapshot,
  lensFixRevertAlreadyUsed,
} from "../src/work-driver-lens-fix-fence-gate.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";
import { cycle, snapshotFor, stateFor } from "./lib/lens-fix-gate-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

console.log("# the counter reads source + round + workstream, nothing else");
{
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
}

console.log("# the plan is rebuilt from the recorded tip, not a fresh read");
{
  const c = cycle("plan-tip");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const plan = lensFixPlanFromSnapshot(snap, c.tree, st.pipelineState);
  assert(
    plan.headBefore === c.roundTip,
    "plan.headBefore is the RECORDED round tip (the round's own commits are not strays)",
  );
  assert(plan.worktree === c.tree, "the plan judges the tree the prompt was built from");
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# the plan is rebuilt from the recorded tip, not a fresh read");
{
  const c = cycle("plan-tip");
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
