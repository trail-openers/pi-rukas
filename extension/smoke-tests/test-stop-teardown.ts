#!/usr/bin/env bun
/**
 * The stop teardown (`work-driver-stop-teardown.ts`) through real git: a stopped
 * cycle removes every tree it recorded, keeps work no local branch holds on one
 * `refs/pi-rukas/stop-salvage/issue-<N>/<tree>/<sha>` ref, keeps a tree whose
 * salvage failed, and the handoff it runs inside names only trees that still exist.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CycleContext } from "../src/work-driver-context.ts";
import { worktreeList } from "../src/work-driver-explain-consolidation.ts";
import { commitPrConsolidationSteps } from "../src/work-driver-handoff-recovery-commit-pr.ts";
import { genericRecoveryLines } from "../src/work-driver-handoff-recovery-tree.ts";
import { withoutRemovedTrees } from "../src/work-driver-handoff-snapshot.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { noDiffEvidence } from "../src/work-driver-lens-fix-commit.ts";
import { runStopTeardown } from "../src/work-driver-stop-teardown.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { fakePi, mkFakeForge } from "./lib/handoff-provenance-fixtures.ts";
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

function commitIn(tree: string, file: string, content: string, force = false): string {
  mkdirSync(join(tree, file, ".."), { recursive: true });
  writeFileSync(join(tree, file), content);
  git(tree, ["add", ...(force ? ["-f"] : []), file]);
  git(tree, ["commit", "-qm", `edit ${file}`]);
  return git(tree, ["rev-parse", "HEAD"]);
}

const refsUnder = (repo: string, prefix: string) =>
  git(repo, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean);
const listed = (repo: string, tree: string) =>
  git(repo, ["worktree", "list", "--porcelain"]).includes(`worktree ${tree}\n`);

function stateWith(ps: Partial<WorkState["pipelineState"]>, cap = "lens-fix-not-integrated") {
  const s = initialState(ISSUE, 1_000_000);
  s.pipelineState = { ...s.pipelineState, ...ps };
  return appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap,
    reviewRound: 1,
    nextStep: "handoff",
    ...(ps.worktrees?.default
      ? {
          lensWorktreePath: ps.worktrees.default,
          evidence: noDiffEvidence(ps.worktrees.default, "b", 0),
        }
      : {}),
  } as Parameters<typeof appendEvent>[1]);
}

async function testSalvageAndRemove() {
  console.log("\n1. every recorded tree is removed; unbranched work lands on one ref");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-stop-teardown");
  const wt = (name: string) => makeSweepWorktree(repoRoot, baseSha, name).path;
  // a. detached commit + tracked edit + untracked file + edited tracked-ignored file
  const dflt = wt("issue-9-default");
  commitIn(dflt, "node_modules/keep.js", "v1\n", true);
  const headA = commitIn(dflt, "a.txt", "committed\n");
  writeFileSync(join(dflt, "base.txt"), "edited\n");
  writeFileSync(join(dflt, "untracked"), "u\n");
  writeFileSync(join(dflt, "node_modules", "keep.js"), "v2\n");
  writeFileSync(join(dflt, "node_modules", "staged.js"), "s\n");
  git(dflt, ["add", "-f", "node_modules/staged.js"]);
  // b. clean tree on a local branch that holds its commits
  const onBranch = wt("issue-9-b");
  git(onBranch, ["switch", "-qc", "side"]);
  commitIn(onBranch, "b.txt", "b\n");
  // c. detached commit whose patch the feature branch already carries
  const picked = wt("issue-9-c");
  const x = commitIn(picked, "c.txt", "c\n");
  const pick = git(repoRoot, ["commit-tree", `${x}^{tree}`, "-p", baseSha, "-m", "pick"]);
  git(repoRoot, ["update-ref", "refs/heads/feature/issue-9", pick]);
  // d. integrate tree, and an owner's original tree no key names any more
  const integrate = wt("issue-9-integrate");
  const orphan = wt("issue-9-owner");
  const violator = wt("issue-9-violator");
  // e. an earlier stop of a same-named tree left a ref at another SHA
  const clash = wt("issue-9-clash");
  const oldRef = `refs/pi-rukas/stop-salvage/issue-9/issue-9-clash/${baseSha}`;
  git(repoRoot, ["update-ref", oldRef, baseSha]);
  commitIn(clash, "e.txt", "e\n");
  // f. a bare ref at the tree's own name: the salvage ref cannot be written
  const df = wt("issue-9-df");
  commitIn(df, "f.txt", "f\n");
  git(repoRoot, ["update-ref", "refs/pi-rukas/stop-salvage/issue-9/issue-9-df", baseSha]);

  const rec = recordingExec();
  const ctx = { repoRoot, issue: ISSUE, verifyExecFn: rec.exec } as unknown as CycleContext;
  const worktrees = { default: dflt, b: onBranch, c: picked, owner: violator, clash, df };
  const torn = await runStopTeardown(
    ctx,
    stateWith({
      worktrees: { ...worktrees, x: repoRoot },
      integrateWorktree: integrate,
      branchName: "feature/issue-9",
    }),
  );

  const aRefs = refsUnder(repoRoot, "refs/pi-rukas/stop-salvage/issue-9/issue-9-default/");
  assertFalse(listed(repoRoot, dflt), "a: the dirty detached tree is removed");
  assertEquals(aRefs.length, 1, "a: exactly one stop-salvage ref holds it");
  const ref = aRefs[0] ?? "";
  assertEquals(git(repoRoot, ["rev-parse", `${ref}~1`]), headA, "a: on top of the pre-stop HEAD");
  assertEquals(git(repoRoot, ["show", `${ref}:untracked`]), "u", "a: the untracked file is in it");
  assertEquals(git(repoRoot, ["show", `${ref}:base.txt`]), "edited", "a: the tracked edit too");
  assertEquals(
    git(repoRoot, ["show", `${ref}:node_modules/keep.js`]),
    "v2",
    "a: and the edit to a tracked file that matches .gitignore",
  );
  assertEquals(
    git(repoRoot, ["show", `${ref}:node_modules/staged.js`]),
    "s",
    "a: and an ignored file that is only staged",
  );
  assertFalse(listed(repoRoot, onBranch), "b: a tree whose commits a branch holds is removed");
  assertEquals(
    refsUnder(repoRoot, "refs/pi-rukas/stop-salvage/issue-9/issue-9-b/").length,
    0,
    "b: with no ref",
  );
  assertFalse(listed(repoRoot, picked), "c: a consolidated tree is removed");
  assertEquals(
    refsUnder(repoRoot, "refs/pi-rukas/stop-salvage/issue-9/issue-9-c/").length,
    0,
    "c: its patch is on the branch, so no ref",
  );
  assertFalse(listed(repoRoot, integrate), "d: the integrate tree is removed");
  assertFalse(listed(repoRoot, orphan), "d: the orphaned owner tree is removed");
  assertFalse(listed(repoRoot, violator), "d: the tree the key now names is removed");
  assertTrue(existsSync(join(repoRoot, ".git", "HEAD")), "d: the repo root is untouched");
  assertEquals(git(repoRoot, ["symbolic-ref", "--short", "HEAD"]), "main", "d: still on main");
  assertFalse(listed(repoRoot, clash), "e: a tree whose name has an older ref is removed");
  const clashRefs = refsUnder(repoRoot, "refs/pi-rukas/stop-salvage/issue-9/issue-9-clash/");
  assertEquals(clashRefs.length, 2, "e: a second ref is added beside the first");
  assertEquals(git(repoRoot, ["rev-parse", oldRef]), baseSha, "e: the first is unchanged");
  assertTrue(listed(repoRoot, df), "f: a tree whose ref could not be written is kept");
  assertTrue(torn.retained.includes(df), "f: and named as retained");
  assertEquals(
    rec.calls.filter((c) => c.cmd.includes("worktree remove") && c.cmd.includes(df)).length,
    0,
    "f: no removal was attempted for it",
  );
  assertEquals(torn.retained.length, 1, "only the failed tree is retained");
  assertEquals(torn.salvaged.length, 2, "two refs were written (a and e)");
  assertTrue(torn.removed.includes(dflt), "removed names the recorded path");
}

async function testGate() {
  console.log("\n2. a vanished path, a plain directory and an empty map are no-ops");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-stop-gate");
  const gone = makeSweepWorktree(repoRoot, baseSha, "issue-9-gone").path;
  rmSync(gone, { recursive: true, force: true });
  const plain = join(repoRoot, ".worktrees", "issue-9-plain");
  mkdirSync(plain);
  const rec = recordingExec();
  const ctx = { repoRoot, issue: ISSUE, verifyExecFn: rec.exec } as unknown as CycleContext;
  const stale = await runStopTeardown(
    ctx,
    stateWith({ worktrees: { a: gone, p: plain, r: "/no/such" } }),
  );
  assertEquals(
    JSON.stringify(stale),
    JSON.stringify({ retained: [], removed: [], salvaged: [] }),
    "nothing retained or removed",
  );
  assertTrue(existsSync(plain), "the plain directory is untouched");
  const empty = await runStopTeardown(ctx, stateWith({ worktrees: {} }));
  assertEquals(empty.removed.length + empty.retained.length, 0, "an empty map tears down nothing");
  assertEquals(rec.calls.length, 0, "and runs no git at all");
  const integrate = makeSweepWorktree(repoRoot, baseSha, "issue-9-integrate").path;
  const held = await runStopTeardown(
    ctx,
    stateWith({ integrateWorktree: integrate }, "integration-worktree-violation"),
  );
  assertTrue(listed(repoRoot, integrate), "m: that cap keeps the integrate tree it names");
  assertEquals(held.removed.length, 0, "m: nothing removed");
}

async function handoffOver(cap: string) {
  const { repoRoot, baseSha } = makeSweepRepo(`pi-rukas-stop-handoff-${cap}`);
  const tree = makeSweepWorktree(repoRoot, baseSha, "issue-9-default").path;
  commitIn(tree, "work.txt", "work\n");
  const { forge } = mkFakeForge({ issueLabels: ["needs-human-attention"] });
  const ctx = {
    host: fakePi,
    repoRoot,
    issue: ISSUE,
    forge,
    dispatchFn: async () => ({
      role: "ops",
      ok: true,
      text: "HANDOFF-RESULT: comment=https://github.com/acme/widget/issues/9#issuecomment-1 label=applied",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    }),
  } as unknown as CycleContext;
  const out = await runHandoff(
    ctx,
    stateWith({ worktrees: { default: tree }, baseSha }, cap),
    2_000_000,
  );
  const emitted = out.eventLog.find((e) => e.kind === "handoff-emitted");
  const body = emitted?.kind === "handoff-emitted" ? emitted.body : "";
  return { repoRoot, tree, out, body };
}

async function testHandoff() {
  console.log("\n3. the handoff names only trees that exist when it is written");
  const { repoRoot, tree, out, body } = await handoffOver("lens-fix-not-integrated");
  const snap = out.pipelineState.handoffSnapshot;
  const refs = refsUnder(repoRoot, "refs/pi-rukas/stop-salvage/issue-9/");
  assertFalse(existsSync(tree), "h: the lens tree is removed");
  assertEquals(refs.length, 1, "h: its commit is on one stop-salvage ref");
  // The render rewrites the repo root to `<repo>`, so the tree is matched by its tail.
  assertFalse(
    body.includes(".worktrees/issue-9-default"),
    "h: the body never names the removed tree",
  );
  assertTrue(body.includes(refs[0] ?? "<none>"), "h: the body names the ref");
  assertFalse(
    (snap?.committedWork ?? []).some((w) => w.path === tree),
    "h: committedWork names no removed tree",
  );
  assertTrue(
    snap?.removedWorktrees?.includes(tree) === true,
    "h: the snapshot records the removal",
  );

  console.log("\n4. a provider park keeps its trees for the resume");
  const park = await handoffOver("provider-unavailable");
  assertTrue(existsSync(park.tree), "i: the tree is still on disk");
  assertEquals(
    park.out.pipelineState.handoffSnapshot?.retainedWorktrees,
    undefined,
    "i: teardown did not run",
  );
  assertEquals(
    park.out.pipelineState.handoffSnapshot?.stopSalvage,
    undefined,
    "i: no salvage recorded",
  );
  assertEquals(
    refsUnder(park.repoRoot, "refs/pi-rukas/stop-salvage/").length,
    0,
    "i: no ref written",
  );

  console.log("\n5. PI_ENSEMBLE_WORKTREE_TEARDOWN=0 is a total no-op");
  process.env.PI_ENSEMBLE_WORKTREE_TEARDOWN = "0";
  try {
    const off = await handoffOver("lens-fix-not-integrated");
    assertTrue(existsSync(off.tree), "j: the tree is still on disk");
    assertEquals(
      refsUnder(off.repoRoot, "refs/pi-rukas/stop-salvage/").length,
      0,
      "j: no ref written",
    );
    assertEquals(
      off.out.pipelineState.handoffSnapshot?.retainedWorktrees,
      undefined,
      "j: nothing recorded",
    );
  } finally {
    Reflect.deleteProperty(process.env, "PI_ENSEMBLE_WORKTREE_TEARDOWN");
  }
}

function testRecoveryFromRef() {
  console.log("\n6. with every tree removed, recovery starts from the stop-salvage ref");
  const ref = "refs/pi-rukas/stop-salvage/issue-9/issue-9-default/abc";
  const s = stateWith({ worktrees: { default: "/r/.worktrees/issue-9-default" }, branchName: "b" });
  s.pipelineState.handoffSnapshot = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: true,
    branchPushed: false,
    capturedAt: 1,
    retainedWorktrees: [],
    stopSalvage: [ref],
  };
  const lines = genericRecoveryLines(s);
  assertTrue(lines.includes(`git log --oneline ${ref} --not --branches`), "l: inspect the ref");
  assertTrue(lines.includes(`git switch -c b-salvage ${ref}`), "l: take it over from the ref");
  assertFalse(lines.includes("git status"), "l: no repo-root commands for work that is not there");
  assertFalse(
    lines.some((l) => l.includes("worktree changes are kept")),
    "l: the discard step names no worktree",
  );
  const kept = "/r/.worktrees/issue-9-kept";
  const snap = s.pipelineState.handoffSnapshot;
  if (snap) snap.retainedWorktrees = [kept];
  s.pipelineState.worktrees = { default: "/r/.worktrees/issue-9-default", kept };
  const mixed = genericRecoveryLines(s);
  assertTrue(mixed.includes(`git -C ${kept} status`), "n: the retained tree is inspected");
  assertTrue(
    mixed.includes(`git switch -c b-salvage ${ref}`),
    "n: and the removed tree's ref is still taken over",
  );

  console.log(
    "\n8. consolidation recovery and explains never send the operator into a removed tree",
  );
  const gone = "/r/.worktrees/issue-9-a";
  const c = stateWith(
    { worktrees: { a: gone }, baseSha: "base1" },
    "commit-pr-incomplete-consolidation",
  );
  c.pipelineState.incompleteConsolidation = [{ id: "a", paths: ["a.ts"] }];
  const aRef = "refs/pi-rukas/stop-salvage/issue-9/issue-9-a/abc";
  c.pipelineState.handoffSnapshot = {
    ...(snap as NonNullable<typeof snap>),
    retainedWorktrees: [],
    stopSalvage: [aRef],
    removedWorktrees: [gone],
  };
  const steps = commitPrConsolidationSteps(c, ISSUE).flatMap((st) => st.lines);
  assertFalse(
    steps.some((l) => l.includes(".worktrees/issue-9-a")),
    "o: no command runs in the removed tree",
  );
  assertTrue(
    steps.some((l) => l.startsWith(`git diff --binary base1 ${aRef} |`)),
    "o: its work is applied from the ref",
  );
  assertFalse(worktreeList(c).includes(gone), "o: the explain's worktree list skips it");
  const scrubbed = withoutRemovedTrees(c.pipelineState, `${gone} and ${gone}b, ${gone}.`);
  assertEquals(
    scrubbed,
    `(a worktree the handoff removed) and ${gone}b, (a worktree the handoff removed).`,
    "o: the evidence scrub replaces whole removed paths only",
  );
}

function testDocs() {
  console.log("\n7. both worktree knobs are documented");
  const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "configuration.md"), "utf8");
  for (const knob of ["PI_ENSEMBLE_WORKTREE_SWEEP", "PI_ENSEMBLE_WORKTREE_TEARDOWN"]) {
    assertTrue(doc.includes(`| \`${knob}\` |`), `k: docs/configuration.md has a ${knob} row`);
  }
}

await testSalvageAndRemove();
await testGate();
await testHandoff();
testRecoveryFromRef();
testDocs();
finish();
