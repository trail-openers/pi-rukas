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
import { type GitExec, runGit } from "../src/work-develop-git.ts";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { fixPassRevertNote, revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import {
  fixPassStraysPatchPath,
  fixPassStraysRef,
  revertFixPassStrays,
} from "../src/work-driver-fix-pass-strays.ts";
import type { WorkState } from "../src/workflow-state.ts";
import {
  devCommit,
  devWrite,
  git,
  repoWithFile,
  singleState,
} from "./lib/adversarial-fix-fixtures.ts";

const realExecFile = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The argv-form executor the driver's own git transport wraps. */
const execFn: NonNullable<DriverContext["verifyExecFn"]> = (cmd, opts) =>
  realExecFile(cmd, opts?.argv ?? [], { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer });

const gitExec: GitExec = runGit(execFn);

/**
 * A worktree laid out the way the develop step lays one out: a repo at
 * `repoRoot`, the tree under `<repoRoot>/.worktrees/<id>` (the shape
 * `assertInsideWorktrees` demands), containing the base commit, the pass's own
 * in-scope commit, and the strays the fence refused.
 */
function passTree(): {
  repoRoot: string;
  worktree: string;
  /** What `planFixPass` records positively before dispatching the pass. */
  headBefore: string;
  /** The HEAD after the pass's own in-scope commit — what a corrective round
   *  dispatched inside the pass would have recorded as its baseline. */
  headAtRound: string;
} {
  const repoRoot = repoWithFile("1846-revert");
  const worktree = `${repoRoot}/.worktrees/issue-1846`;
  git(repoRoot, "worktree add -q --detach .worktrees/issue-1846 HEAD");
  const headBefore = git(worktree, "rev-parse HEAD").trim();
  // The pass's own legitimate work, committed as a real fix pass commits. This is
  // the commit the revert MUST survive — it is the whole reason the revert is
  // path-scoped rather than a whole-tree reset.
  devCommit(worktree, "a.txt", "two\n");
  const headAtRound = git(worktree, "rev-parse HEAD").trim();
  // Stray 1 — a tracked file the pass created after its fix commit.
  devCommit(worktree, "helper.ts", "export const helper = () => 1;\n");
  // Stray 2 — a tracked file that existed before the pass and was edited.
  writeFileSync(`${worktree}/b.txt`, "hijacked\n");
  // Stray 3 — an untracked file, in no commit, so no ref can ever hold it.
  devWrite(worktree, "scratch-notes.md", "notes the pass should not have added\n");
  return { repoRoot, worktree, headBefore, headAtRound };
}

const req = (
  t: { repoRoot: string; worktree: string; headBefore: string },
  strays: string[],
  untracked: string[],
  headBefore: string | undefined = t.headBefore,
) => ({
  git: gitExec,
  worktree: t.worktree,
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
  // Revert to the head the pass itself reached (what a corrective round inside the
  // pass records): the in-scope fix stays, the strays after it do not.
  const res = await revertFixPassStrays(req(t, STRAYS, UNTRACKED, t.headAtRound));
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
      { file: "helper.ts", refused: "outside" },
      { file: "scratch-notes.md", refused: "outside" },
    ],
    untracked: ["scratch-notes.md"],
  };
  const ctx = {
    repoRoot: t.repoRoot,
    issue: 1846,
    verifyExecFn: execFn,
  } as unknown as DriverContext;
  const state: WorkState = singleState(t.worktree, []);
  const plans = [
    {
      id: "default",
      findings: [],
      fence: [],
      specSlots: [],
      worktree: t.worktree,
      base: t.headBefore,
      headBefore: t.headBefore,
      before: { names: ["a.txt"], diff: "", untracked: [] },
      outOfScope: [],
      protectedPaths: [],
      declared: [],
      named: [],
    },
  ];
  const first = await revertStraysOnce(ctx as never, state, plans, post, 1);
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
    const second = await revertStraysOnce(ctx as never, afterRevert, plans, post, 2);
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
  const skipped = await revertStraysOnce(ctx as never, state, plans, fenced, 3);
  assert(
    skipped === undefined,
    "a refusal with no `straysFor` (fenced / protected) is not offered a revert at all",
  );
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
