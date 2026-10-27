#!/usr/bin/env bun
/**
 * #1846 — the fix pass's path-scoped revert of out-of-fence files.
 *
 * The field shape: a fix pass lands its fix, adds a small helper the fence does
 * not admit, and the cycle used to hand off with text telling a human to "revert
 * <files> in that worktree and land the rest by hand". The driver now does that
 * itself, so this test checks the three things that make doing so safe:
 *
 *   1. NOTHING IS LOST — after the revert the stray content is still reachable:
 *      tracked strays through the preserved ref, untracked ones through the copy
 *      written beside the patch.
 *   2. NOTHING ELSE MOVES — the pass's own committed fix survives byte for byte.
 *      A whole-tree reset would have destroyed it, which is exactly why this path
 *      is path-scoped and not `resetAndClean`.
 *   3. A REFUSAL LEAVES THE TREE ALONE — when preservation cannot run (no
 *      recorded pre-pass head, a cwd that is not a driver worktree), the tree is
 *      exactly as it arrived and the caller parks with a reason.
 *
 * Every assertion runs against a REAL git repo, not a stub: the guarantee under
 * test is "git can still read this content afterwards", which a stub answers by
 * construction.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { type GitExec, runGit } from "../src/work-develop-git.ts";import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { fixPassRevertNote, revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import {
  fixPassStraysPatchPath,
  fixPassStraysRef,
  revertFixPassStrays,
} from "../src/work-driver-fix-pass-strays.ts";
import type { FixPassStraysRevertedEvent } from "../src/workflow-state-events-fix-pass-strays.ts";
import type { WorkState } from "../src/workflow-state.ts";
import type { CorrectiveRoundEvent } from "../src/workflow-state-events-corrective.ts";
import {
  devCommit,
  devWrite,
  events,
  fixCtx,
  git,
  passTreeAt,
  repoWithFile,
  singleState,
  typedCycleCtx,
  typedPassPlans,
} from "./lib/adversarial-fix-fixtures.ts";

const realExecFile = promisify(execFile);

/** The argv-form executor the driver's own git transport wraps. */
const execFn: NonNullable<CycleContext["verifyExecFn"]> = (cmd, opts) =>
  realExecFile(cmd, opts?.argv ?? [], { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer });

const gitExec: GitExec = runGit(execFn);

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A worktree laid out the way the develop step lays one out: a repo at
 * `repoRoot`, the tree under `<repoRoot>/.worktrees/<id>` (the shape
 * `assertInsideWorktrees` demands), containing the base commit, the pass's own
 * in-scope commit, and the strays the fence refused. The shared fixture is
 * deliberately thin on assertions: this file's first case asserts on the refusals
 * it raises, so a broken layout has to surface as the rule under test failing.
 */
function passTree(): ReturnType<typeof passTreeAt> {
  return passTreeAt("1846-revert");
}

const req = (
  t: { repoRoot: string; worktree: string; headBefore: string },
  strays: string[],
  untracked: string[],
  headBefore: string | undefined = t.headBefore,
) => ({
  git: gitExec,
  worktree: t.worktree,
  // #1849 item 7 — the recorded tree matches the plan's tree, because every
  // case in THIS file is about what the revert does once it is allowed to run.
  // The mismatch case (a sibling's tree, or none recorded) is
  // `test-fix-pass-strays-worktree.ts`; leaving this absent would make every
  // case here fail on the target gate and assert nothing about its own rule.
  recordedWorktree: t.worktree,
  repoRoot: t.repoRoot,
  issue: 1846,
  workstreamId: "default",
  attempt: 1,
  headBefore,
  strays,
  untracked: new Set(untracked),
  scratchDir: `${t.repoRoot}/tmp/issue-1846`,
});

const STRAYS = ["helper.ts", "b.txt", "scratch-notes.md"];
const UNTRACKED = ["scratch-notes.md"];

console.log("# the happy path: strays reverted, the pass's own fix kept");
{
  const t = passTree();
  const keptBefore = readFileSync(`${t.worktree}/a.txt`, "utf8");
  // The revert targets the PASS's OWN pre-pass head — `plan.headBefore`, which is
  // what the fence judged the pass against. The in-scope fix stays (it is not a
  // stray path) and the strays after it do not.
  const res = await revertFixPassStrays(req(t, STRAYS, UNTRACKED));
  if ("reason" in res) {
    assert(false, `the revert succeeded — it refused: ${res.reason}`);
  } else {
    assert(true, "the revert succeeded");
    assert(
      readFileSync(`${t.worktree}/a.txt`, "utf8") === keptBefore,
      "the pass's own committed fix survived byte for byte — this is the whole reason the revert is path-scoped and not a whole-tree reset",
    );
    assert(
      !existsSync(`${t.worktree}/helper.ts`),
      "the tracked stray the pass created is gone from the tree",
    );
    assert(
      readFileSync(`${t.worktree}/b.txt`, "utf8") === "one\n",
      "the tracked stray that predated the pass is restored to its pre-pass content",
    );
    assert(
      !existsSync(`${t.worktree}/scratch-notes.md`),
      "the untracked stray is removed from the tree",
    );
    assert(res.paths.length === 3, "every stray is disclosed");
    assert(
      res.preservedRef === fixPassStraysRef(1846, "default", 1),
      `the preserved ref is the durable fix-pass namespace (${res.preservedRef})`,
    );
    assert(
      res.patchPath === fixPassStraysPatchPath(`${t.repoRoot}/tmp/issue-1846`, 1846, "default", 1),
      "the patch path is the fixed per-attempt name",
    );
    assert(
      git(t.worktree, `show ${res.preservedRef}:helper.ts`).trim() ===
        "export const helper = () => 1;",
      "the reverted tracked stray is still readable through the preserved ref",
    );
    // The ref preserves what git HELD. `b.txt` was edited and left uncommitted,
    // so no ref holds "hijacked" — its bytes are the patch's job, and the patch
    // is checked below. `helper.ts` was committed, so the ref is its record. This
    // split is exactly why the two preservation forms exist and neither alone
    // would do.
    const patchText = readFileSync(res.patchPath, "utf8");
    assert(
      patchText.includes("hijacked"),
      "the uncommitted edit to a tracked stray is recorded in the patch (no ref can hold an uncommitted change)",
    );
    const copy = `${t.repoRoot}/tmp/issue-1846/fix-pass-strays-untracked/scratch-notes.md`;
    assert(
      existsSync(copy) && readFileSync(copy, "utf8").includes("should not have added"),
      "the untracked stray's bytes survive in the copy beside the patch (no commit ever held it)",
    );
    assert(
      existsSync(res.patchPath) && readFileSync(res.patchPath, "utf8").length > 0,
      "the patch was written",
    );
    assert(
      git(t.worktree, "log -1 --format=%s").trim() === "revert out-of-fence fix-pass files",
      "the revert is one driver commit, so every later reader sees one diff",
    );
    assert(
      git(t.worktree, "status --porcelain").trim() === "",
      "the tree is clean after the revert",
    );
    // The revert is ONE new commit on top of the pass's own history: the base,
    // the in-scope fix and the stray commit are all still reachable, and the
    // strays were never reset away underneath us.
    assert(
      git(t.worktree, "rev-list --count HEAD").trim() === "4",
      "nothing was reset — the pass's history is intact and the revert is one commit on top",
    );
  }
}

console.log("# no recorded pre-pass HEAD: refuse, and leave the tree exactly as found");
{
  const t = passTree();
  const dirtyBefore = git(t.worktree, "status --porcelain");
  const helperBefore = readFileSync(`${t.worktree}/helper.ts`, "utf8");
  const bBefore = readFileSync(`${t.worktree}/b.txt`, "utf8");
  const res = await revertFixPassStrays({
    ...req(t, STRAYS, UNTRACKED),
    headBefore: undefined, // the pass recorded no usable head
  });
  assert("reason" in res, "the revert refuses");
  assert(
    /no usable pre-pass HEAD/.test("reason" in res ? res.reason : ""),
    `the refusal says why — there is no "back to" (${JSON.stringify(res)})`,
  );
  assert(
    git(t.worktree, "status --porcelain") === dirtyBefore,
    "the tree is byte-identical to how it arrived",
  );
  assert(
    readFileSync(`${t.worktree}/helper.ts`, "utf8") === helperBefore,
    "the stray the pass created was NOT deleted",
  );
  assert(
    readFileSync(`${t.worktree}/b.txt`, "utf8") === bBefore,
    "the edited stray was NOT restored",
  );
  assert(
    existsSync(`${t.repoRoot}/tmp/issue-1846/fix-pass-strays-untracked/scratch-notes.md`) === false,
    "nothing was copied to the scratch dir for a revert that never ran",
  );
  // `show-ref` exits 1 for a ref that does not exist, so ask for it and accept
  // either outcome rather than letting a fixture helper throw on the good case.
  const refListed = git(t.worktree, "show-ref").includes(fixPassStraysRef(1846, "default", 1));
  assert(!refListed, "no preserved ref was created for a revert that never happened");
}

console.log("# the cwd gate: a tree that is not a driver worktree is refused");
{
  const t = passTree();
  const res = await revertFixPassStrays({ ...req(t, ["a.txt"], []), worktree: t.repoRoot });
  assert("reason" in res, "a revert outside a driver worktree refuses");
  assert(
    /not inside/.test("reason" in res ? res.reason : ""),
    `and names the worktree gate (${JSON.stringify(res)})`,
  );
  assert(
    readFileSync(`${t.repoRoot}/a.txt`, "utf8") === "one\n",
    "the repo root's file is untouched — the gate ran before any git did",
  );
}

console.log("# the patch name is per attempt, so a later record cannot clobber an earlier one");
{
  const t = passTree();
  const scratch = `${t.repoRoot}/tmp/issue-1846`;
  assert(
    fixPassStraysPatchPath(scratch, 1846, "default", 1) !==
      fixPassStraysPatchPath(scratch, 1846, "default", 2),
    "the attempt number is part of the name",
  );
  assert(
    fixPassStraysPatchPath(scratch, 1846, "default", 1).startsWith(scratch),
    "and the patch stays inside the scratch dir",
  );
}

console.log("# the step: one revert per pass; a SECOND stray set parks instead");
{
  const t = passTree();
  const post: PostPass = {
    diffs: {},
    admissions: [],
    straysFor: "default",
    strays: [
      { file: "helper.ts", refused: "no-slot", revertible: true },
      { file: "scratch-notes.md", refused: "no-slot", revertible: true },
    ],
    untracked: ["scratch-notes.md"],
  };
  const ctx = typedCycleCtx(t.repoRoot, 1846);
  const state: WorkState = singleState(t.worktree, []);
  const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
  const first = await revertStraysOnce(ctx, state, plans, post, 1);
  assert(
    first?.ok === true,
    `the first stray set is reverted, not parked (${JSON.stringify(first)})`,
  );
  if (first?.ok === true) {
    const note = fixPassRevertNote(first.event);
    assert(
      note.includes("helper.ts") &&
        note.includes(first.event.preservedRef) &&
        note.includes(first.event.patchPath),
      `the disclosure names the paths AND where they are preserved (${note})`,
    );
    // The SAME pass producing a second set must park, not revert again.
    const afterRevert: WorkState = { ...state, eventLog: [first.event] };
    const second = await revertStraysOnce(ctx, afterRevert, plans, post, 2);
    assert(
      second?.ok === false && second.secondSet,
      "a SECOND stray set parks — the driver reverts once per pass, it does not loop",
    );
    assert(
      /SECOND/.test(second?.ok === false ? second.reason : ""),
      `and the park reason says so (${JSON.stringify(second)})`,
    );
  }
  // A refusal the fence reached for a PROTECTED or fenced file never reaches here.
  const fenced: PostPass = { ...post, straysFor: undefined, strays: undefined };
  const skipped = await revertStraysOnce(ctx, state, plans, fenced, 3);
  assert(
    skipped === undefined,
    "a refusal with no `straysFor` (fenced / protected) is not offered a revert at all",
  );
}

console.log("# the revert counter is per pass and per workstream, not per cycle");
{
  // A sibling workstream's revert, or a revert from an EARLIER fix pass, must
  // not spend this pass's one attempt: the whole eventLog is not the window.
  const t = passTree();
  const ctx = typedCycleCtx(t.repoRoot, 1846);
  const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
  const post: PostPass = {
    diffs: {},
    admissions: [],
    straysFor: "default",
    strays: [{ file: "helper.ts", refused: "no-slot", revertible: true }],
    untracked: [],
  };
  const otherPassRevert: FixPassStraysRevertedEvent = {    kind: "fix-pass-strays-reverted",
    at: 1,
    // A DIFFERENT workstream's revert — this pass has reverted nothing.
    workstreamId: "sibling",
    paths: ["other.ts"],
    preservedRef: "refs/pi-rukas/fix-pass-strays/1846-sibling-1",
    patchPath: "/tmp/x.patch",
  };
  const state = singleState(t.worktree, [otherPassRevert]);
  const outcome = await revertStraysOnce(ctx, state, plans, post, 1);
  assert(
    outcome?.ok === true,
    `a sibling workstream's revert does not spend this workstream's attempt (${JSON.stringify(outcome)})`,
  );
  // And a revert recorded BEFORE this pass's own request event is an earlier
  // pass's business, not this pass's budget. The two reverts run in the SAME
  // tree, because the pass window is a slice of one log: the first revert
  // restores the stray the second one is about to refuse, which is exactly what
  // a driver that reverted in pass 1 and re-ran the fixer in pass 2 does.
  const t2 = passTree();
  const own = await revertStraysOnce(
    typedCycleCtx(t2.repoRoot, 1846),
    singleState(t2.worktree, []),
    await typedPassPlans(t2.repoRoot, t2.worktree, ["a.txt"], "a.txt: fix it"),
    post,
    1,
  );
  assert(own?.ok === true, "the fixture's first revert of its own pass succeeds");
  // The pass's developer goes back to work and produces the stray again — as a
  // TRACKED stray, i.e. the pass committed it, which is the shape the fence
  // reports for a file the fixer committed before the post-pass read.
  devCommit(t2.worktree, "helper.ts", "export const helper = () => 1;\n");
  if (own?.ok === true) {
    // Now a NEW pass starts: its request event follows the old revert, and the
    // same stray set is revertible again.
    const reopened: WorkState = {
      ...singleState(t2.worktree, []),
      eventLog: events(
        own.event,
        {
          kind: "adversarial-fix-requested",
          at: 2,
          workstreamId: "default",
          round: 2,
          findings: "a.txt: fix it",
        },
      ),
    };
    const again = await revertStraysOnce(
      typedCycleCtx(t2.repoRoot, 1846),
      reopened,
      await typedPassPlans(t2.repoRoot, t2.worktree, ["a.txt"], "a.txt: fix it"),
      post,
      2,
    );
    assert(
      again?.ok === true,
      `a revert from an EARLIER pass does not spend this pass's attempt (${JSON.stringify(again)})`,
    );
  }
}

console.log("# the revert target is the pass's OWN headBefore, never a round's headAtRound");
{
  // PM decision #1846-2, the direction the first round got wrong. The fence
  // computes the strays from the pass's delta at `plan.headBefore`, while a
  // corrective round's `headAtRound` is recorded AFTER that round's commits — so
  // restoring a stray to its `headAtRound` content keeps the stray. Here the
  // pass commits a fix (`a.txt`) and a stray (`helper.ts`), a corrective round
  // is then recorded at the HEAD the round found, and the revert must still
  // delete the stray while keeping the fix.
  const t = passTree();
  const keptBefore = readFileSync(`${t.worktree}/a.txt`, "utf8");
  const strayBefore = readFileSync(`${t.worktree}/helper.ts`, "utf8");
  // The stray this case judges is `b.txt`: it EXISTS at the pass's pre-pass head
  // and was EDITED out of fence. That is the shape in which a `headAtRound`
  // target quietly keeps the stray — a checkout restores content rather than
  // deleting the file — so it is the load-bearing path here. (`helper.ts` is the
  // pass-created shape, covered by the happy-path case above; it stays in the
  // list so the two shapes are reverted in one commit, as the field reports
  // them.)
  //
  // `headAtRound` is what a corrective round dispatched INSIDE the pass records:
  // the HEAD it found, which by then already contains the pass's commits — so a
  // revert aimed at it can never delete or roll back anything the pass itself
  // wrote. That is the trap this case exists for, and the fixture proves it
  // first: the stray commit and the hijacked `b.txt` are both AFTER the head
  // below, and a real `git checkout <headAtRound> -- <stray>` restores them.
  const strayAtRound = git(t.worktree, `ls-tree -r --name-only ${t.headAtRound}`);
  assert(
    t.headAtRound !== t.headBefore,
    "the round's head is a different commit from the pass's own pre-pass head",
  );
  assert(
    !strayAtRound.includes("helper.ts"),
    "the fixture is the trap: headAtRound is the HEAD the round FOUND, before the stray commit",
  );
  // The round's own extra commit records the pass's work — this is the head the
  // old code preferred, and a revert to it leaves `helper.ts` in the tree and
  // `b.txt` hijacked. The pass then edits `b.txt` further, which is the state
  // the fence reads.
  const roundBase = `${t.worktree}/round-base.ts`;
  writeFileSync(roundBase, "export const r = 1;\n");
  git(t.worktree, "add -A");
  git(t.worktree, 'commit -q -m "the corrective round\'s commit"');
  const recordedRoundHead = git(t.worktree, "rev-parse HEAD").trim();
  devWrite(t.worktree, "b.txt", "hijacked again\n");
  // The proof, read from git rather than asserted in prose: at the head the round
  // recorded, the stray still EXISTS and the other stray is still hijacked.
  assert(
    git(t.worktree, `ls-tree -r --name-only ${recordedRoundHead}`).includes("helper.ts"),
    "the trap holds: at the round's head the pass-created stray is in the tree",
  );
  assert(
    git(t.worktree, `show ${recordedRoundHead}:b.txt`).includes("hijacked"),
    "and the round's head still records the out-of-fence content of the other stray",
  );
  const round: CorrectiveRoundEvent = {
    kind: "corrective-round",
    at: 1,
    step: "develop",
    workstreamId: "default",
    attempt: 1,
    command: "sh check.sh",
    evidenceLines: ["b.txt:12 expected one"],
    headAtRound: recordedRoundHead,
  };
  const ctx = typedCycleCtx(t.repoRoot, 1846);
  const state: WorkState = singleState(t.worktree, events(round));
  const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
  const post: PostPass = {
    diffs: {},
    admissions: [],
    straysFor: "default",
    strays: [
      { file: "helper.ts", refused: "no-slot", revertible: true },
      { file: "b.txt", refused: "no-slot", revertible: true },
    ],
    untracked: [],
  };
  const outcome = await revertStraysOnce(ctx, state, plans, post, 1);
  assert(outcome?.ok === true, `the stray set is reverted (${JSON.stringify(outcome)})`);
  assert(
    existsSync(`${t.worktree}/helper.ts`) === false,
    "the pass-created stray is GONE — at the round's head it is in the tree, so a headAtRound revert could not delete it",
  );
  assert(
    existsSync(`${t.worktree}/round-base.ts`),
    "the corrective round's own commit is untouched — the revert path list holds only strays",
  );
  assert(
    readFileSync(`${t.worktree}/b.txt`, "utf8") === "one\n",
    "the edited stray is restored to its headBefore content — a headAtRound target would have kept the out-of-fence lines",
  );
  assert(
    readFileSync(`${t.worktree}/a.txt`, "utf8") === keptBefore,
    "and the fix file is kept — a per-path revert touches only the stray paths",
  );
  // The fixture's last guarantee: the revert's preserved ref is the pre-revert
  // HEAD, so the content the revert deleted is still reachable through it. If
  // this ever fails, the case above proved nothing about where the bytes are.
  assert(
    git(t.worktree, `show ${outcome?.ok === true ? outcome.event.preservedRef : ""}:helper.ts`).trim() ===
      strayBefore.trim(),
    "the deleted stray's bytes are still readable through the preserved ref",
  );
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
