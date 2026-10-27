#!/usr/bin/env bun
/**
 * #1849 item 7 — the stray revert runs only in the worktree the DRIVER recorded
 * for this workstream.
 *
 * `PassPlan.worktree` names the tree every destructive call of the revert targets,
 * and it is a caller- and test-filled field. The gate that existed
 * (`assertInsideWorktrees`) proves a path lives under `.worktrees/` — a statement
 * about the namespace, not about ownership. So a plan built from a stale or
 * cross-wired state pointed the revert at a SIBLING workstream's tree: the files
 * deleted were the neighbour's, the pass reported a revert of its own strays, and
 * the `fix-pass-strays-reverted` event recorded it either way.
 *
 * The rule now: `pipelineState.worktrees[workstreamId]` — the value Step 3 wrote
 * and every later step reads — must name the SAME directory as the plan's
 * `worktree`, compared by realpath so a symlinked or differently spelled root does
 * not refuse a revert of the right tree. Three shapes are asserted:
 *   - a sibling under `.worktrees/` is refused, and BOTH trees are untouched;
 *   - no recorded tree at all is refused (nothing was recorded ⇒ nothing to revert into);
 *   - the matching tree still reverts, and a spelling difference that resolves to
 *     the same directory (a trailing separator, `.` segments) is NOT a mismatch.
 */

import { existsSync, readFileSync } from "node:fs";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import type { WorkState } from "../src/workflow-state.ts";
import {
  devWrite,
  git,
  passTreeAt,
  typedCycleCtx,
  typedPassPlans,
} from "./lib/adversarial-fix-fixtures.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A state recording `worktree` (or nothing) for the `default` workstream. The
 *  constructor is the REAL `initialState`, with only the recorded tree overridden:
 *  the gate under test reads a field of `pipelineState`, so a hand-rolled state
 *  object would be checking the test's own shape rather than the driver's. */
function stateRecording(worktree: string | undefined): WorkState {
  const s = initialState(1846, 1);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: worktree === undefined ? {} : { default: worktree },
    },
  };
}

const post: PostPass = {
  diffs: {},
  admissions: [],
  reason: "stray",
  straysFor: "default",
  strays: [{ file: "helper.ts", refused: "no-slot" }],
  untracked: ["scratch-notes.md"],
};

console.log("# a plan naming a SIBLING worktree is refused, and both trees stand");
{
  const t = passTreeAt("1846-sibling");
  // A second driver worktree for a different workstream — the shape a cross-wired
  // plan points at. Both live under `.worktrees/`, so the namespace gate cannot
  // tell them apart; only the recorded tree can.
  git(t.repoRoot, "worktree add -q --detach .worktrees/issue-1846-sibling HEAD");
  const sibling = `${t.repoRoot}/.worktrees/issue-1846-sibling`;
  // The sibling has its own copy of everything, including a file of the same name
  // the revert would have deleted: `helper.ts` is tracked there from the base.
  devWrite(sibling, "sibling-only.txt", "written by its own workstream\n");
  // Snapshot the sibling's OWN state before the call, so the assertion is about
  // what the revert did (nothing) rather than about the fixture's setup.
  const siblingBefore = git(sibling, "status --porcelain");
  const ownBefore = readFileSync(`${t.worktree}/b.txt`, "utf8");
  const plans = await typedPassPlans(t.repoRoot, sibling, ["a.txt"], "a.txt: fix it");
  assert(
    plans[0]?.worktree === sibling,
    "the fixture's plan really does name the SIBLING tree (that is the bug shape)",
  );
  const outcome = await revertStraysOnce(
    typedCycleCtx(t.repoRoot, 1846),
    stateRecording(t.worktree),
    plans,
    post,
    1,
  );
  assert(
    outcome?.ok === false,
    `the revert is refused, not performed on the wrong tree (${JSON.stringify(outcome)})`,
  );
  assert(
    outcome?.ok === false && /refusing to revert/.test(outcome.reason),
    "and the reason is the revert's own refusal, so the pass parks on it",
  );
  assert(
    outcome?.ok === false &&
      outcome.reason.includes(sibling) &&
      outcome.reason.includes(t.worktree),
    "and it names BOTH trees, so the operator can see which two disagreed",
  );
  // The point of the whole item: nothing was destroyed anywhere.
  assert(
    existsSync(`${t.worktree}/helper.ts`) === true,
    "the real workstream's stray is still there — the refusal ran no destructive call",
  );
  assert(
    readFileSync(`${t.worktree}/b.txt`, "utf8") === ownBefore,
    "and its edited stray is byte-identical to what the pass left",
  );
  // `helper.ts` exists in the pass's tree only as the stray the pass COMMITTED,
  // so it is absent from a sibling added at the base — which is what makes this
  // assertion about the sibling's OWN file rather than the strays'
  assert(
    existsSync(`${sibling}/sibling-only.txt`) === true &&
      git(sibling, "status --porcelain") === siblingBefore,
    "and the sibling workstream's tree is byte-for-byte as it stood — the revert never touched it",
  );
  assert(
    git(t.worktree, "status --porcelain").trim() !== "",
    "the pass's tree is still dirty with its strays, i.e. exactly as it arrived",
  );
}

console.log("# no recorded worktree is refused rather than trusted");
{
  const t = passTreeAt("1846-unrecorded");
  const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
  const outcome = await revertStraysOnce(
    typedCycleCtx(t.repoRoot, 1846),
    stateRecording(undefined),
    plans,
    post,
    1,
  );
  assert(
    outcome?.ok === false && /no worktree is recorded/.test(outcome.reason),
    `with nothing recorded there is no tree to revert into (${JSON.stringify(outcome)})`,
  );
  assert(
    existsSync(`${t.worktree}/helper.ts`) === true,
    "and the tree is untouched",
  );
}

console.log("# the recorded tree still reverts, spelling and all");
{
  const t = passTreeAt("1846-matching");
  const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
  // A spelling difference that resolves to the SAME directory must not refuse a
  // legitimate revert: `realpath` is the comparison, not string equality. The
  // trailing separator and the `..`-style detour are the two shapes a path built
  // by `join`/`path.resolve` from different call sites actually differs by.
  const spelled = `${t.worktree}/.git/..`;
  const outcome = await revertStraysOnce(
    typedCycleCtx(t.repoRoot, 1846),
    stateRecording(spelled),
    plans,
    post,
    1,
  );
  assert(
    outcome?.ok === true,
    `a differently spelled path to the SAME tree still reverts (${JSON.stringify(outcome).slice(0, 120)})`,
  );
  assert(
    existsSync(`${t.worktree}/helper.ts`) === false,
    "and the stray is actually gone, so this case proves the revert ran",
  );
}

console.log("# an unresolvable recorded tree is a refusal, not a pass");
{
  const t = passTreeAt("1846-unresolvable");
  const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
  const outcome = await revertStraysOnce(
    typedCycleCtx(t.repoRoot, 1846),
    stateRecording(`${t.repoRoot}/.worktrees/issue-1846-never-created`),
    plans,
    post,
    1,
  );
  assert(
    outcome?.ok === false,
    `a recorded tree that does not exist cannot authorise a revert (${JSON.stringify(outcome).slice(0, 130)})`,
  );
  assert(
    existsSync(`${t.worktree}/helper.ts`) === true,
    "and 'could not tell' did not read as 'fine' — the tree is untouched",
  );
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
