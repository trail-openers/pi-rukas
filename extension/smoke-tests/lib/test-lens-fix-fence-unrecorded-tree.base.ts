#!/usr/bin/env bun
/**
 * #1852 round 3 item 1 — the BASE expectations of the unrecorded-tree fixture.
 *
 * THIS FILE IS RUN ON BASE, not on HEAD. `lib/lens-fix-unrecorded-tree-base.sh`
 * copies it over `test-lens-fix-fence-unrecorded-tree.ts` in a detached checkout
 * of `a9758573` (the last commit before the lens-fix gate) and runs it there.
 * It is kept tracked, beside the head test it mirrors, for one reason: the
 * head-side assertions ("the round parked", "nothing was pushed", "origin/<branch>
 * did not move") are only worth anything if the SAME fixture does the opposite on
 * the pre-#1852 sources. This file is that proof, and keeping it next to the test
 * it refutes is what stops the two from drifting apart.
 *
 * It imports only modules that exist on base, and records the push through the
 * context's `verifyExecFn` — the seam the landing arm's own
 * `runNetGit(ctx.verifyExecFn ?? execp, …)` call goes through — so the identical
 * fixture and context load on both sides.
 */

import { existsSync } from "node:fs";
import { git } from "./lib/adversarial-fix-fixtures.ts";
import {
  cleanupRepo,
  driveLensFixAndAdversarial,
  unrecordedRepo,
} from "./lib/lens-fix-unrecorded-tree-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

console.log("# (a) BASE: the repo-root stray is committed and the push is ATTEMPTED");
{
  const f = unrecordedRepo("1852-root-stray", { treePath: "repoRoot", stray: true });
  assert(
    existsSync(f.strayPath),
    "NON-VACUITY: the stray really is in the tree the fixer worked in",
  );
  const pushes: string[] = [];
  const { caps, before, after, state } = await driveLensFixAndAdversarial(f, false, pushes);
  assert(
    !caps.includes("lens-fix-scope"),
    `base has no lens-fix fence to park on (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    pushes.some((p) => p.includes("push")),
    `NON-VACUITY: base ATTEMPTED the push (attempts: ${JSON.stringify(pushes)}) — the hole #1852 closes`,
  );
  assert(
    Number(after) > Number(before),
    `NON-VACUITY: base moved origin/<branch> ${before} -> ${after} — the stray landed on the PR`,
  );
  const landed = git(f.repoRoot, `show --name-only --format= origin/${f.branch}`).trim();
  assert(
    landed.includes("fixer-stray.md"),
    `and the pushed commit CONTAINS the stray (files: ${JSON.stringify(landed)})`,
  );
  assert(
    state.pipelineState.currentStep !== "handoff",
    `base did not park (currentStep: ${state.pipelineState.currentStep})`,
  );
  cleanupRepo(f.repoRoot);
}

console.log("# (b) BASE: the unrecorded .worktrees/ tree lands unchecked too");
{
  const f = unrecordedRepo("1852-unrecorded", { treePath: "worktree", stray: true });
  const pushes: string[] = [];
  const { caps, before, after } = await driveLensFixAndAdversarial(f, false, pushes);
  assert(
    !caps.includes("lens-fix-scope"),
    `base has no fence to park on (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    pushes.some((p) => p.includes("push")),
    `NON-VACUITY: base attempted the push for the unrecorded tree too (${JSON.stringify(pushes)})`,
  );
  assert(
    Number(after) > Number(before),
    `origin/<branch> ${before} -> ${after} — the landing arms ran unjudged`,
  );
  cleanupRepo(f.repoRoot);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
