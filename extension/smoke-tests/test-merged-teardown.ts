#!/usr/bin/env bun
/**
 * #2479 — the merged step's worktree teardown removes every tree the cycle OWNS,
 * on real git.
 *
 * `runMergedTeardown` used to derive removal names from the KEYS of
 * `pipelineState.worktrees` alone. Two kinds of tree survived a proven merge:
 * the integrate tree (recorded outside that map) and a fence merge's violator
 * tree — `runMergePrep` sets `worktrees[owner] = violatorWt` then deletes
 * `worktrees[violator]`, so the derived `issue-<N>-<owner>` removes the owner's
 * ORIGINAL tree while the violator's tree is named by no key at all.
 *
 * The positive set is pinned by per-path ATTEMPTED-REMOVAL counts from
 * `recordingExec()`'s call log — not merely that a removal happened — and the
 * negative arms by "no removal attempted" plus filesystem survival proved
 * against real `git worktree list`. A refused candidate additionally has to
 * announce itself: the refusal arms run with `PI_ENSEMBLE_DEBUG=1` and assert
 * the named refusal trace fired, because an absence alone is what a gather bug
 * produces too. The repo root is asserted to survive with HEAD on its start ref
 * in every case that could have touched it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { CycleContext } from "../src/work-driver-context.ts";
import { runMergedTeardown } from "../src/work-driver-merged-teardown.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assertEquals, assertFalse, assertTrue, finish } from "./lib/worktree-sweep-assert.ts";
import { makeSweepRepo, makeSweepWorktree, recordingExec } from "./lib/worktree-sweep-fixture.ts";

gitTestEnv();
for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[v];

const ISSUE = 9;

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitTestEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** True while git still lists `tree` as a worktree of `repo`. */
const listed = (repo: string, tree: string) =>
  git(repo, ["worktree", "list", "--porcelain"]).includes(`worktree ${tree}\n`);

/**
 * Run `body` with the debug trace on, capturing stderr, so a refusal can be
 * asserted by NAME rather than inferred from the absence of a removal.
 */
async function traced(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await withEnv({ PI_ENSEMBLE_DEBUG: "1" }, fn);
  } finally {
    process.stderr.write = real;
  }
  return captured;
}

/** The post-merge state: the driver's own trees are recorded on `next`. */
function nextState(ps: Partial<WorkState["pipelineState"]>, cap?: string): WorkState {
  const s = initialState(ISSUE, 1_000_000);
  s.pipelineState = { ...s.pipelineState, ...ps };
  return cap
    ? appendEvent(s, {
        kind: "cap-hit",
        at: 1_000_400,
        cap,
        reviewRound: 1,
        nextStep: "handoff",
      } as unknown as Parameters<typeof appendEvent>[1])
    : s;
}

/** A pre-merge state naming a tree the post-merge state does NOT name. */
function priorState(path: string): WorkState {
  const s = initialState(ISSUE, 999_000);
  s.pipelineState = { ...s.pipelineState, worktrees: { "pre-merge-only": path } };
  return s;
}

async function testRemovesEveryOwnedTree() {
  console.log("\n1. the integrate tree and a fence-merge violator tree both go");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-merged-teardown");
  const wt = (name: string) => makeSweepWorktree(repoRoot, baseSha, name).path;
  const a = wt("issue-9-a");
  const orphan = wt("issue-9-owner");
  const violator = wt("issue-9-violator");
  const integrate = wt("issue-9-integrate");
  const foreign = wt("issue-9-foreign");

  const rec = recordingExec();
  const ctx = { repoRoot, issue: ISSUE, verifyExecFn: rec.exec } as unknown as CycleContext;
  // The fence-merge shape: the owner's key names the VIOLATOR's tree, and the
  // violator's own key is gone, so no derived name reaches `violator`.
  const next = nextState({
    worktrees: { a, owner: violator },
    integrateWorktree: integrate,
    branchName: "feature/issue-9",
  });
  // A wrong wiring (gathering from `state`) would remove this tree and not the
  // integrate tree, so seed the two arguments to differ.
  const state = priorState(orphan);

  await runMergedTeardown(ctx, state, next, true);

  assertFalse(listed(repoRoot, a), "a: the workstream tree is removed");
  assertFalse(listed(repoRoot, violator), "b: the tree the owner key names is removed");
  assertFalse(listed(repoRoot, orphan), "b: and the owner's orphaned tree too");
  assertFalse(listed(repoRoot, integrate), "c: the integrate tree is removed");
  assertTrue(listed(repoRoot, foreign), "d: a tree no record names is left alone");
  assertTrue(existsSync(join(repoRoot, ".git", "HEAD")), "d: the repo root survives");
  assertEquals(git(repoRoot, ["symbolic-ref", "--short", "HEAD"]), "main", "d: still on main");

  const attempted = (path: string) =>
    rec.calls.filter((c) => c.cmd.includes("worktree remove") && c.cmd.includes(path)).length;
  assertEquals(attempted(a), 1, "a: exactly one removal attempted");
  assertEquals(attempted(orphan), 1, "b: one attempted for the orphan");
  assertEquals(attempted(violator), 1, "b: one attempted for the violator");
  assertEquals(attempted(integrate), 1, "c: one attempted for the integrate tree");
  assertEquals(attempted(foreign), 0, "d: no removal attempted for an unrecorded tree");
  assertEquals(attempted(join(".worktrees", "pre-merge-only")), 0, "e: pre-merge keys gather nothing");
  assertEquals(rec.countMatching("worktree prune"), 1, "f: the admin records were pruned once");
  rmSync(repoRoot, { recursive: true, force: true });
}

async function testGateRefusals() {
  console.log("\n2. every refusal is a skip, never a removal, and never a failure");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-merged-gate");
  const wt = (name: string) => makeSweepWorktree(repoRoot, baseSha, name).path;

  // a. a traversal key: the derived name is `<repo>/.worktrees/../../..`.
  const traversal = wt("issue-9-traversal-victim");
  // b. the repo-root fallback shape `worktrees = { default: repoRoot }`.
  // c. an integrate tree a prior step already removed.
  const gone = wt("issue-9-integrate");
  rmSync(gone, { recursive: true, force: true });
  // d. a plain directory at `.worktrees/<name>` — not a worktree of this repo.
  const plain = join(repoRoot, ".worktrees", "issue-9-plain");
  mkdirSync(plain);
  // e. a symlink at `.worktrees/<name>` pointing OUTSIDE the tree. It is laid
  // down LAST: `git worktree add` refuses a target whose parent is a symlink, so
  // the escape is proved on the listing rather than by adding into it.
  const outside = join(repoRoot, "escape", "issue-9-outside");
  mkdirSync(join(repoRoot, "escape"), { recursive: true });
  git(repoRoot, ["worktree", "add", "--detach", outside, baseSha]);
  const link = join(repoRoot, ".worktrees", "issue-9-link");
  symlinkSync(outside, link);

  const rec = recordingExec();
  const ctx = { repoRoot, issue: ISSUE, verifyExecFn: rec.exec } as unknown as CycleContext;
  const log = await traced(async () => {
    await runMergedTeardown(
      ctx,
      nextState({}),
      nextState({
        worktrees: { "../..": "", default: repoRoot, p: plain, l: link },
        integrateWorktree: gone,
      }),
      true,
    );
  });

  // Substring-free helpers: the negative arms must not be satisfiable by a
  // needle that merely happens to appear in some other candidate's path.
  const removalLines = () =>
    rec.calls
      .map((c) => (c.argv ? [c.cmd, ...c.argv].join(" ") : c.cmd))
      .filter((l) => l.includes("worktree remove"));
  const attempted = (needle: string) => removalLines().filter((l) => l.includes(needle)).length;
  // A removal attempt carries the target as `git worktree remove --force
  // <JSON.stringify(realPath)>`, so matching the quoted argument is the only
  // form that cannot match a neighbouring path by substring.
  const attemptedPath = (path: string) => attempted(`remove ${JSON.stringify(path)}`);
  // Substring-free: a traversal attempt would carry the literal `..` component
  // into the quoted path, so the whole transcript is scanned, not one call.
  assertEquals(
    removalLines().filter((l) => l.includes("..")).length,
    0,
    "a: no traversal removal was attempted",
  );
  assertTrue(listed(repoRoot, traversal), "a: the tree the traversal key could have reached is intact");
  assertTrue(existsSync(join(repoRoot, ".git", "HEAD")), "a: the repo root survived it");
  assertEquals(attemptedPath(repoRoot), 0, "b: no removal attempted for the repo-root fallback");
  assertEquals(git(repoRoot, ["symbolic-ref", "--short", "HEAD"]), "main", "b: still on main");
  assertEquals(attempted("issue-9-integrate"), 0, "c: an absent integrate tree is skipped, not an error");
  assertTrue(existsSync(plain), "d: the plain directory is untouched");
  assertEquals(attemptedPath(plain), 0, "d: and no removal was attempted for it");
  assertTrue(existsSync(outside), "e: the symlink's target tree is intact");
  assertEquals(attemptedPath(link), 0, "e: the symlink itself was never a removal target");
  assertEquals(rec.countMatching("worktree remove"), 0, "not one removal was attempted");
  // Every refusal above has to have actually FIRED, by name. An absence of
  // removal is also what a gather bug produces, so the arms are pinned on the
  // named trace the gate writes (the removal is a no-op either way — this only
  // proves which branch ran). Containment is gate 1; the rest are gate 2's own
  // reasons. `../..` resolves OUT of `.worktrees/`, so containment is the only
  // branch that can refuse it; the symlink resolves to the foreign tree, which
  // containment also refuses — gate 2 would call it `not-our-worktree`.
  const refused = (path: string, reason: string) =>
    log.includes(`merged-teardown: skipped ${path}: ${reason}`);
  // The `../..` key gathers TWO candidates: the derived name collapses to
  // `<repoRoot>/.worktrees`, and the map value is the empty string, so it
  // contributes nothing. Both refusals are asserted.
  assertTrue(
    refused(join(repoRoot, ".worktrees"), "containment"),
    "a: the traversal key was refused by containment, not dropped by gathering",
  );
  assertTrue(
    refused(repoRoot, "containment"),
    "b: the repo-root fallback was refused by containment, not dropped by gathering",
  );
  assertTrue(
    refused(gone, "unresolvable"),
    "c: the absent integrate tree was refused as unresolvable, not silently gathered away",
  );
  assertTrue(
    refused(plain, "not-our-worktree"),
    "d: the plain directory was refused as not our worktree",
  );
  assertTrue(
    refused(link, "containment"),
    "e: the symlink was refused by containment, not dropped by gathering",
  );
  rmSync(repoRoot, { recursive: true, force: true });
}

async function testCapShapeAndMergeProven() {
  console.log("\n3. lastCapShape is not consulted, and mergeProven does not gate removal");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-merged-caps");
  const wt = (name: string) => makeSweepWorktree(repoRoot, baseSha, name).path;

  // The integrate tree goes even though an earlier cap-hit in the log was an
  // integration-worktree violation (the stop teardown keeps that tree; a proven
  // merge has no resume to keep it for).
  const held = wt("issue-9-integrate");
  const recHeld = recordingExec();
  const ctx = { repoRoot, issue: ISSUE, verifyExecFn: recHeld.exec } as unknown as CycleContext;
  await runMergedTeardown(
    ctx,
    nextState({}),
    nextState({ integrateWorktree: held }, "integration-worktree-violation"),
    true,
  );
  assertFalse(listed(repoRoot, held), "a: that cap shape does not keep the integrate tree");

  // An unrelated LATER cap must not spare it either — the gate is a whole-log
  // reverse scan, so an unrelated hit is exactly what would hide a tree.
  const late = wt("issue-9-integrate-late");
  await runMergedTeardown(
    ctx,
    nextState({}),
    nextState({ integrateWorktree: late }, "token-budget"),
    true,
  );
  assertFalse(listed(repoRoot, late), "b: an unrelated later cap does not keep it either");

  // The worktree half is not gated by `mergeProven`: an unproven merge removes
  // the same set.
  const unproven = { a: wt("issue-9-a"), owner: wt("issue-9-violator") };
  const integrate2 = wt("issue-9-integrate2");
  const recUnproven = recordingExec();
  await runMergedTeardown(
    { repoRoot, issue: ISSUE, verifyExecFn: recUnproven.exec } as unknown as CycleContext,
    nextState({}),
    nextState({ worktrees: unproven, integrateWorktree: integrate2 }),
    false,
  );
  for (const tree of [unproven.a, unproven.owner, integrate2]) {
    assertFalse(listed(repoRoot, tree), "c: an unproven merge still removed every tree");
  }
  const unprovenRemovals = recUnproven.countMatching("worktree remove");
  const recProven = recordingExec();
  const provenWt = wt("issue-9-a");
  const provenViolator = wt("issue-9-violator");
  const provenIntegrate = wt("issue-9-integrate2");
  await runMergedTeardown(
    { repoRoot, issue: ISSUE, verifyExecFn: recProven.exec } as unknown as CycleContext,
    nextState({}),
    nextState({
      worktrees: { a: provenWt, owner: provenViolator },
      integrateWorktree: provenIntegrate,
    }),
    true,
  );
  assertEquals(
    unprovenRemovals,
    recProven.countMatching("worktree remove"),
    "c: identical removal count whether or not the merge was proven",
  );
  assertEquals(unprovenRemovals, 3, "c: all three trees attempted, on both arms");
  for (const tree of [provenWt, provenViolator, provenIntegrate]) {
    assertFalse(listed(repoRoot, tree), "c: and gone from the listing on the proven arm too");
  }
  rmSync(repoRoot, { recursive: true, force: true });
}

async function testEmptySetIssuesNoGit() {
  console.log("\n4. a cycle that owns no tree issues no git at all");
  const { repoRoot } = makeSweepRepo("pi-rukas-merged-empty");
  // Each arm runs on its own recorder, so the count below is one teardown's,
  // not the sum of three.
  const run = (next: WorkState) => {
    const r = recordingExec();
    return {
      calls: r.calls,
      run: runMergedTeardown(
        { repoRoot, issue: ISSUE, verifyExecFn: r.exec } as unknown as CycleContext,
        nextState({}),
        next,
        // Unproven, so the backup-REF half (the one `mergeProven` gates) stays
        // out of this count — "no git at all" here is a claim about the worktree
        // half, which is ungated and so is exercised on both arms above.
        false,
      ),
    };
  };
  const arms = [
    run(nextState({ worktrees: {} })),
    run(nextState({})),
    run(nextState({ worktrees: { a: "" } })),
  ];
  await Promise.all(arms.map((a) => a.run));
  for (const arm of arms) {
    // The worktree half returns at `targets.size === 0`, before the lock and
    // before any git call, so it issues zero commands — whatever the other
    // arguments do.
    assertEquals(arm.calls.length, 0, "an empty candidate set runs no git command whatsoever");
  }
  rmSync(repoRoot, { recursive: true, force: true });
}

try {
  await testRemovesEveryOwnedTree();
  await testGateRefusals();
  await testCapShapeAndMergeProven();
  await testEmptySetIssuesNoGit();
} finally {
  finish();
}
