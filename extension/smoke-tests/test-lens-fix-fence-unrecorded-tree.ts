#!/usr/bin/env bun
/**
 * #1852 round 3 item 1 — a lens tree with NO fence must never land unchecked.
 *
 * The gate's skip branch reads the event log: no `lens-fix-fence-unavailable`
 * record means "an older driver wrote this state, there was nothing to judge",
 * and the round lands. That branch was reachable by the ORDINARY shape of a
 * current driver's state — not by a broken git read — in two shapes:
 *
 *   (a) the lens tree IS `ctx.repoRoot`. `lensWorktree` falls back there when the
 *       state records no tree, and the repo root has no `worktrees` entry to
 *       build a fence from, so the step wrote neither a snapshot nor a record;
 *   (b) a `.worktrees/` tree no `pipelineState.worktrees` entry names —
 *       `revertStraysOnce` refuses it for want of a recorded tree, so the round
 *       had neither a fence nor a revert.
 *
 * Both now record a refusal in `buildLensFixFence`, and the gate parks.
 *
 * THE NON-VACUITY IS MEASURED, not asserted. `lib/lens-fix-unrecorded-tree-fixtures.ts`
 * imports only modules that exist on `a9758573` (the last commit before #1852
 * added the gate), and the base expectation below is run there in
 * `test-lens-fix-fence-unrecorded-tree-base` — on that commit the same fixture
 * pushes the stray, which is what makes the head-side assertions non-vacuous.
 *
 * Everything drives the REAL step pair — `runLensFix` then `runAdversarial` — not
 * a hand-built snapshot: the hole was in what the STEP recorded (nothing), and a
 * snapshot typed by hand cannot fail to record it.
 */

import { existsSync } from "node:fs";
import {
  cleanupRepo,
  driveLensFixAndAdversarial,
  unrecordedRepo,
  type UnrecordedFixture,
} from "./lib/lens-fix-unrecorded-tree-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

console.log("# (a) a REPO-ROOT lens tree with an untracked stray parks and pushes nothing");
{
  const f = unrecordedRepo("1852-root-stray", { treePath: "repoRoot", stray: true });
  assert(
    existsSync(f.strayPath),
    "NON-VACUITY: the stray really is in the tree the fixer worked in",
  );
  const pushes: string[] = [];
  const { caps, before, after, state } = await driveLensFixAndAdversarial(f, false, pushes);
  assert(
    caps.includes("lens-fix-scope"),
    `the round parked on the lens-fix scope cap (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    !pushes.some((p) => p.includes("push")),
    `nothing was pushed (attempts: ${JSON.stringify(pushes)})`,
  );
  assert(
    before === after,
    `origin/<branch> did not move (${before} -> ${after}) — the stray did not reach the PR`,
  );
  assert(
    existsSync(f.strayPath),
    "PM decision #1852-1: the stray was NOT reverted — the driver never reverts at the repo root",
  );
  assert(
    state.pipelineState.currentStep === "handoff",
    `the cycle routes to the handoff, not on to the next step (${state.pipelineState.currentStep})`,
  );
  const cap = state.eventLog.find(
    (e) => e.kind === "cap-hit" && (e as { cap?: string }).cap === "lens-fix-scope",
  ) as { evidence?: string; lensWorktreePath?: string } | undefined;
  assert(
    (cap?.evidence ?? "").includes("lens-fix fence could not be built"),
    `the park says the round cannot be cleared without its fence (${(cap?.evidence ?? "").slice(0, 130)})`,
  );
  assert(
    cap?.lensWorktreePath === f.tree,
    `and it names the tree the operator has to open (${cap?.lensWorktreePath})`,
  );
  cleanupRepo(f.repoRoot);
}

console.log("# (b) an UNRECORDED .worktrees/ tree parks rather than landing unchecked");
{
  // A real `.worktrees/` tree that no `pipelineState.worktrees` entry names: the
  // step has no workstream to build a fence from and the revert has no recorded
  // tree to revert into, so silence used to mean "the gate does not run".
  const f = unrecordedRepo("1852-unrecorded", { treePath: "worktree", stray: true });
  const pushes: string[] = [];
  const { caps, before, after, state } = await driveLensFixAndAdversarial(f, false, pushes);
  assert(
    caps.includes("lens-fix-scope"),
    `an unrecorded lens tree parks on the scope cap (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    !pushes.some((p) => p.includes("push")),
    `nothing was pushed (attempts: ${JSON.stringify(pushes)})`,
  );
  assert(before === after, `origin/<branch> did not move (${before} -> ${after})`);
  const cap = state.eventLog.find(
    (e) => e.kind === "cap-hit" && (e as { cap?: string }).cap === "lens-fix-scope",
  ) as { evidence?: string } | undefined;
  assert(
    (cap?.evidence ?? "").includes("no workstream records the lens tree"),
    `the park names the missing record as the reason (${(cap?.evidence ?? "").slice(0, 150)})`,
  );
  cleanupRepo(f.repoRoot);
}

console.log("# the RECORD is what makes the gate run, and it is persisted");
{
  // Same shapes, no stray. The round still has to be JUDGED, so the step's
  // refusal must be on the log AND on disk: an append nobody persisted is
  // invisible to the gate after a resume, which reads "no record" as "an older
  // driver wrote this state" and skips (#1852 round 3 item 2).
  const f = unrecordedRepo("1852-recorded", { treePath: "repoRoot", stray: false });
  const pushes: string[] = [];
  const { state } = await driveLensFixAndAdversarial(f, false, pushes);
  const recorded = state.eventLog.filter((e) => e.kind === "lens-fix-fence-unavailable");
  assert(
    recorded.length > 0,
    `the step recorded why this round has no fence (${JSON.stringify(recorded.map((e) => (e as { reason?: string }).reason))})`,
  );
  assert(
    recorded.every((e) => (e as { round?: number }).round === 1),
    "the record carries the round the gate matches on",
  );
  cleanupRepo(f.repoRoot);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
