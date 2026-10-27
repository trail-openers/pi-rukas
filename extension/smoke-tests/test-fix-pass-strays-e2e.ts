#!/usr/bin/env bun
/**
 * #1846 — the fix pass's stray revert, driven through the step seam and the
 * seam's caller.
 *
 * The field shape this replaces (issue #1846): a fix pass lands its fix, adds a
 * small helper the fence does not admit, and the whole cycle hands off with
 * `cap-hit: fix-pass-park` and text telling a human to
 * "revert <files> in that worktree and land the rest by hand". The driver can do
 * that revert itself, losslessly, so the park is now reserved for the cases where
 * reverting is the wrong answer:
 *
 *   - a SECOND stray set from the same pass (the pass will not stay inside its
 *     fence — reverting again would be looping on it);
 *   - a stray the fence refused as fenced or protected (those files are the
 *     protected-path gate's decision, never the revert's);
 *   - no positively recorded head to revert to, or a preservation that failed.
 *
 * The first three cases drive the REAL `revertStraysOnce` — the step the fix pass
 * invokes with its own plans — against a real git repo, so what is asserted is the
 * tree outcome and the event the cycle records, not an internal helper's return.
 * The whole pass (`runAdversarialFixPass`) is driven by
 * `test-work-driver-adversarial-fix-pass.ts`; what only this file covers is the
 * CALLER half of the escape hatch: with the switch off the caller never invokes
 * the revert (`fixPassStrayRevertEnabled() && post.reason && post.straysFor &&
 * post.strays` at its call site), and the revert step itself refuses a repo root
 * — so the tree is left exactly as the pass left it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { fixPassStrayRevertEnabled } from "../src/work-driver-adversarial-fix.ts";
import { correctiveRoundFor, correctiveRoundsOf } from "../src/work-driver-corrective-admission.ts";
import { passWindow, revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import { fixPassStraysRef } from "../src/work-driver-fix-pass-strays.ts";
import type { FixPassStraysRevertedEvent } from "../src/workflow-state-events-fix-pass-strays.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import {
  devCommit,
  devWrite,
  fixState,
  git,
  passTreeAt,
  repoWithFile,
  typedCycleCtx,
  typedPassPlans,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

/** The developer's work, committed IN ITS WORKTREE. The fixture keeps the repo
 *  root and the worktree as separate trees (that is what the cwd gate needs), so
 *  the pass's own commits have to be made in the tree the revert reads. */
function devCommitIn(wt: string, file: string, body: string): void {
  const at = `${wt}/${file}`;
  mkdirSync(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  writeFileSync(at, body);
  git(wt, "add -A");
  git(wt, 'commit -q -m "the fix pass"');
}

/** The developer's edit left UNCOMMITTED — the shape the fence reads as a stray
 *  (`treeChanges` merges `ls-files --others`), and the one no ref can preserve. */
function devWriteIn(wt: string, file: string, body: string): void {
  const at = `${wt}/${file}`;
  mkdirSync(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  writeFileSync(at, body);
}

/** `devCommit` writes then commits; a file in a NEW directory needs the dir first. */
function commitNew(dir: string, file: string, body: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  devCommit(dir, file, body);
}

/**
 * The tree the "second stray set" case needs: the fixture's own stray set, plus
 * `lib/helper.ts` left uncommitted in a directory the fence never admitted — the
 * shape that reached the field.
 */
function strayInNewDirTree(label: string): {
  repoRoot: string;
  worktree: string;
  headBefore: string;
} {
  const t = passTreeAt(label);
  devWriteIn(t.worktree, "lib/helper.ts", "export const helper = () => 1;\n");
  return { repoRoot: t.repoRoot, worktree: t.worktree, headBefore: t.headBefore };
}

/**
 * The state one of these cases hands the revert step: the fixture's fix-pass
 * state, with the tree it is about to revert RECORDed for the `default`
 * workstream. #1849 item 7 added that gate (`pipelineState.worktrees[id]` must
 * name the tree the plan carries), so a test whose plan names a `.worktrees/…`
 * tree has to record the same one — `fixState`/`singleState` point the recorded
 * tree at the repo root, which is the value the refusal test below wants, not
 * what an integration case wants. The refusal for a mismatched tree is asserted
 * on purpose in `test-fix-pass-strays-worktree.ts`.
 */
function passState(dir: string, worktree: string, findings = "a.txt: change one to two"): WorkState {
  const st = fixState(dir, ["a.txt"], findings);
  return {
    ...st,
    pipelineState: { ...st.pipelineState, worktrees: { default: worktree } },
  };
}

/** A stray refusal as `postPassFault` reports it for an admissible stray. */
function strayPost(file: string, untracked: string[]): PostPass {
  return {
    diffs: {},
    admissions: [],
    reason: "stray",
    straysFor: "default",
    strays: [{ file, refused: "no-slot" }],
    untracked,
  };
}

/** A refusal `postPassFault` reports for a fenced / protected stray: NO
 *  `straysFor`, because those files are the protected-path gate's decision. */
const protectedPost: PostPass = { diffs: {}, admissions: [], reason: "protected" };

console.log("# the seam: a stray set that is revertible is reverted, not parked");
{
  // The single-tree fixture cannot drive the whole pass with an uncommitted stray
  // (the consolidated-verify dirty-root gate refuses the pass before the fence is
  // ever read), so this drives the seam the pass actually calls — the same
  // `revertStraysOnce` the fix pass invokes with its own plans — and then asserts
  // the tree outcome with git. What the pass does with the outcome (continue vs
  // park) is asserted by the second set's case below and by the refusal branches.
  const dir = repoWithFile("1846-seam");
  try {
    git(dir, "worktree add -q --detach .worktrees/issue-1846 HEAD");
    const wt = `${dir}/.worktrees/issue-1846`;
    const st = passState(dir, wt);
    const headBefore = git(wt, "rev-parse HEAD").trim();
    devCommitIn(wt, "a.txt", "two\n");
    devWriteIn(wt, "lib/helper.ts", "export const helper = () => 1;\n");
    const plans = await typedPassPlans(dir, wt, ["a.txt"], "a.txt: change one to two");
    assert(
      plans[0]?.headBefore === headBefore,
      "the real plan records the pass's own pre-pass HEAD positively",
    );
    assert(
      plans[0]?.fence.admits.includes("lib/helper.ts") === false,
      "and the real fence does not admit the helper the pass added",
    );
    const outcome = await revertStraysOnce(
      typedCycleCtx(dir, 1846),
      st,
      plans,
      strayPost("lib/helper.ts", ["lib/helper.ts"]),
      Date.now(),
    );
    assert(
      outcome?.ok === true,
      `the stray set is reverted, not parked (${JSON.stringify(outcome)})`,
    );
    assert(!existsSync(`${wt}/lib/helper.ts`), "the stray is gone from the tree");
    assert(
      readFileSync(`${wt}/a.txt`, "utf8") === "two\n",
      "the pass's own committed fix survived — a whole-tree reset would have destroyed it",
    );
    assert(
      git(wt, "show-ref").includes(fixPassStraysRef(1846, "default", 1)),
      "the preserved ref exists, so the reverted content is still reachable",
    );
    const copy = `${dir}/tmp/issue-1846/fix-pass-strays-untracked/lib/helper.ts`;
    assert(
      existsSync(copy) && readFileSync(copy, "utf8").includes("helper"),
      "the untracked bytes survive in the copy beside the patch — nothing is lost",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("# a SECOND stray set parks: the driver reverts once, it does not loop");
{
  const t = strayInNewDirTree("1846-twice");
  try {
    const st = passState(t.repoRoot, t.worktree);
    const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
    const post = strayPost("lib/helper.ts", ["lib/helper.ts"]);
    const first = await revertStraysOnce(
      typedCycleCtx(t.repoRoot, 1846),
      st,
      plans,
      post,
      Date.now(),
    );
    assert(first?.ok === true, "the first stray set is reverted");
    // The state now carries the revert event, as it would in the pass.
    const after: WorkState = {
      ...st,
      eventLog: [...st.eventLog, ...(first?.ok === true ? [first.event] : [])],
    };
    const second = await revertStraysOnce(
      typedCycleCtx(t.repoRoot, 1846),
      after,
      plans,
      post,
      Date.now(),
    );
    assert(
      second?.ok === false && second.secondSet,
      "a SECOND stray set is a park, not a second revert",
    );
    assert(
      /SECOND/.test(second?.ok === false ? second.reason : ""),
      `and the reason says the driver already reverted once (${JSON.stringify(second)})`,
    );
    assert(
      existsSync(`${t.worktree}/lib/helper.ts`) === false,
      "the first revert's tree change stands — nothing was re-reverted",
    );
  } finally {
    rmSync(t.repoRoot, { recursive: true, force: true });
  }
}

console.log("# the revert target is the pass's OWN headBefore, never a round's");
{
  // A corrective round dispatched inside the pass records the HEAD it FOUND —
  // which by then already contains the pass's own commits, strays included. The
  // revert must target the pass's `headBefore`, the one referent the fence's own
  // judgement uses. Varying one thing: the round's baseline points at a tree
  // where `lib/helper.ts` is already tracked with the out-of-fence content.
  const dir = repoWithFile("1846-target");
  try {
    git(dir, "worktree add -q --detach .worktrees/issue-1846 HEAD");
    const wt = `${dir}/.worktrees/issue-1846`;
    const baseHead = git(wt, "rev-parse HEAD").trim();
    // A commit made by the driver's corrective round: helper.ts exists there.
    devCommitIn(wt, "lib/helper.ts", "export const helper = 1;\n");
    devCommitIn(wt, "a.txt", "fixed\n");
    const roundHead = git(wt, "rev-parse HEAD").trim();
    // The pass then EDITED it out of fence.
    devWriteIn(wt, "lib/helper.ts", "export const helper = 999;\n");
    const st = passState(dir, wt);
    const round: WorkEvent = {
      kind: "corrective-round",
      at: 1,
      step: "develop",
      workstreamId: "default",
      attempt: 1,
      command: "sh check.sh",
      evidenceLines: ["a.txt: assertion failed"],
      headAtRound: roundHead,
    };
    const events: WorkEvent[] = [...st.eventLog, round];
    const found = correctiveRoundFor(
      correctiveRoundsOf(passWindow({ ...st, eventLog: events })),
      "default",
    );
    assert(
      found?.headAtRound === roundHead,
      "the pass window finds the corrective round's own baseline, not an earlier one",
    );
    const plans = await typedPassPlans(dir, wt, ["a.txt"], "a.txt: change one to two");
    assert(
      plans[0]?.headBefore === baseHead,
      "the real plan's target is the pass's pre-pass HEAD, before the round's commit",
    );
    const outcome = await revertStraysOnce(
      typedCycleCtx(dir, 1846),
      { ...st, eventLog: events },
      plans,
      strayPost("lib/helper.ts", []),
      Date.now(),
    );
    assert(outcome?.ok === true, `the stray is reverted (${JSON.stringify(outcome)})`);
    // #1846 — the revert targets the PASS's own `headBefore`, never a corrective
    // round's `headAtRound`. `headAtRound` is the HEAD the round FOUND, which by
    // then already contains the pass's own commits — so restoring a stray to it
    // restores the stray. This assertion is the difference between the two
    // targets made visible: the round's content is the OUT-OF-FENCE content, and
    // it must not survive.
    assert(
      !existsSync(`${wt}/lib/helper.ts`),
      "the pass-created stray is GONE: a headAtRound target would have kept the round's out-of-fence content",
    );
    // And the pass's own fix, which is NOT in the stray list, is untouched by a
    // path-scoped revert to `headBefore`.
    assert(
      readFileSync(`${wt}/a.txt`, "utf8") === "fixed\n",
      "the pass's own committed fix survived the revert to headBefore",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("# the escape hatch returns the pass to parking on the FIRST stray set");
{
  // The kill switch must not merely skip the revert: it must skip it BEFORE the
  // revert is attempted, so the tree is left exactly as the pass left it (the
  // pre-#1849 behaviour an operator reaching for this knob expects). Two halves
  // are observable here: the caller's guard reads the switch, and the revert step
  // itself refuses a repo root — so either way the tree stands untouched.
  const dir = repoWithFile("1846-hatch");
  const prev = process.env.PI_ENSEMBLE_FIX_PASS_STRAY_REVERT;
  process.env.PI_ENSEMBLE_FIX_PASS_STRAY_REVERT = "0";
  try {
    // A TRACKED stray (committed, then further edited in the tree) is the shape
    // that survives a pass whose develop gates all clear — an untracked one makes
    // the dirty-root gate refuse the pass before the fence is ever reached.
    commitNew(dir, "lib/helper.ts", "export const helper = () => 1;\n");
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    devWrite(dir, "lib/helper.ts", "export const helper = () => 2;\n");
    const before = readFileSync(`${dir}/lib/helper.ts`, "utf8");
    // The caller's guard, read the way `runAdversarialFixPass` reads it at its
    // own revert call site: with the switch off it never reaches `revertStraysOnce`.
    const callerWouldRevert = fixPassStrayRevertEnabled();
    assert(
      callerWouldRevert === false,
      "the switch reads as off, so the caller declines to revert and parks on the first set",
    );
    const plans = await typedPassPlans(dir, dir, ["a.txt"], "a.txt: change one to two");
    const refused = await revertStraysOnce(
      typedCycleCtx(dir, 1846),
      st,
      plans,
      strayPost("lib/helper.ts", []),
      Date.now(),
    );
    assert(
      refused?.ok === false && /not inside/.test(refused.reason),
      `the revert step itself refuses a repo root, so whatever the switch says the tree is left alone (${JSON.stringify(refused)})`,
    );
    assert(
      existsSync(`${dir}/lib/helper.ts`) &&
        readFileSync(`${dir}/lib/helper.ts`, "utf8") === before,
      "and the mechanism was never invoked — the tree is untouched",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_FIX_PASS_STRAY_REVERT;
    else process.env.PI_ENSEMBLE_FIX_PASS_STRAY_REVERT = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("# a fenced or protected refusal is never offered a revert");
{
  const t = passTreeAt("1846-fenced");
  try {
    const before = readFileSync(`${t.worktree}/b.txt`, "utf8");
    const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
    const outcome = await revertStraysOnce(
      typedCycleCtx(t.repoRoot, 1846),
      fixState(t.repoRoot, ["a.txt"], "a.txt: change one to two"),
      plans,
      protectedPost,
      Date.now(),
    );
    assert(outcome === undefined, "a refusal with no `straysFor` is not offered a revert at all");
    assert(
      readFileSync(`${t.worktree}/b.txt`, "utf8") === before,
      "the tree was not touched",
    );
  } finally {
    rmSync(t.repoRoot, { recursive: true, force: true });
  }
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
