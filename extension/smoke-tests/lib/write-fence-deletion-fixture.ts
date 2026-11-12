/**
 * Shared on-disk layout for the #2200 child-deletion tests.
 *
 *   base/
 *     wt/                       the fenced worktree (the child's cwd)
 *     scratch/                  the cycle scratch dir
 *     pi-rukas-child-own/       the child's OWN per-spawn temp dir (PI_ENSEMBLE_CHILD_TMP)
 *     tmp/                      the SHARED temp root — never a delete target
 *       other-session-run/        another run's dir under it
 *     pi-rukas-child-sibling/   another child's per-child temp root
 *     pi-rukas-review-other/    a harness-owned tree (a live reviewer checkout)
 *   rules/
 *     runs/                     a shared root no basename rule recognises
 *       other-run/                an ops cwd one `..` from that root
 *     spawntmp/                 the SYNTHETIC spawn temp root, injected as `spawnTempRoot`
 *       pi-rukas-child-A/         a per-run dir under it — the walk's seed
 *
 * The "shared temp root" is a directory of its own rather than the machine's
 * temp dir: the rule must refuse a shared root whatever it is called, and these
 * tests must never delete outside their own tree. `rules/` exists for the
 * opposite reason — it is the pair of trees that let one row observe the
 * ancestor walk and nothing else. `runs/` is a shared root whose name no temp
 * rule knows and whose location refuses nothing; `spawntmp/` is passed to
 * `deletionRootsFrom` as the spawn layer's temp root, so the walk has a root to
 * climb from without the suite ever writing to (or risking the deletion of) the
 * machine's real one.
 *
 * The layout lives under the repo's gitignored `tmp/` (as `write-fence-fixture.ts`
 * does), not beside the test: the exit hook does not fire when the runner's bound
 * kills the process, and a tree left inside the tracked tree would show in
 * `git status`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DeletionFixture {
  base: string;
  wt: string;
  scratch: string;
  childTmp: string;
  sharedTmp: string;
  /** A shared root whose name no temp-dir rule recognises — the containment row's subject. */
  sharedRuns: string;
  /** A run dir under `sharedRuns`; an ops cwd that reaches that root with `..`. */
  foreignRunUnderRuns: string;
  /** Pass as `deletionRootsFrom`'s `spawnTempRoot`: the tree the walk is seeded from. */
  spawnTempRoot: string;
  /** A per-run dir under `spawnTempRoot` — the seed the ancestor walk climbs from. */
  tempRunSibling: string;
  siblingTmp: string;
  harnessTree: string;
  foreignRun: string;
}

export function buildDeletionFixture(tag: string): DeletionFixture {
  const scratchParent = path.join(import.meta.dirname, "..", "tmp", "issue-2200");
  mkdirSync(scratchParent, { recursive: true });
  const base = mkdtempSync(path.join(scratchParent, `${tag}-`));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const wt = path.join(base, "wt");
  const scratch = path.join(base, "scratch");
  const childTmp = path.join(base, "pi-rukas-child-own");
  const sharedTmp = path.join(base, "tmp");
  const siblingTmp = path.join(base, "pi-rukas-child-sibling");
  const harnessTree = path.join(base, "pi-rukas-review-other");
  const foreignRun = path.join(sharedTmp, "other-session-run");
  // The two trees the containment row aims the RULE at, built below one dir of their own rather
  // than under `base`. Two reasons, both about where a tree sits rather than what it is: the rule
  // refuses a directory whose NAME is a temp root's, and the whole fixture lives under a dir
  // called `tmp`; and the ancestor walk climbs the seed's PARENT into the forbidden set for its
  // whole subtree, so a temp root parked among the other scratch trees would put every one of
  // them — this suite's own `wt` among them — behind a refusal no row asked for.
  const ruleTrees = path.join(scratchParent, `${tag}-rules`);
  process.on("exit", () => rmSync(ruleTrees, { recursive: true, force: true }));
  // A shared root no basename rule recognises (`runs`, not `tmp`, not what this env calls its temp
  // dir), sharing a parent with the synthetic temp root. So the ONLY thing that can refuse a cwd
  // standing under it is the ancestor walk — and deleting the walk takes that row red, which is
  // the whole reason for building the tree this way. The `tmp`-named root above cannot serve: the
  // basename heuristic refuses that cwd before containment is ever consulted.
  const sharedRuns = path.join(ruleTrees, "runs");
  // One level BELOW `runs/`, so the cwd is a working directory and `runs/` is the thing standing
  // between it and the temp root: a cwd standing IN `runs/` is refused as that root's own parent
  // (which it is) and the row would no longer say whether the walk ran.
  const foreignRunUnderRuns = path.join(sharedRuns, "build", "other-run");
  const spawnTempRoot = path.join(ruleTrees, "spawntmp");
  const tempRunSibling = path.join(spawnTempRoot, "pi-rukas-child-A");
  for (const dir of [
    wt,
    scratch,
    childTmp,
    sharedTmp,
    sharedRuns,
    foreignRunUnderRuns,
    spawnTempRoot,
    tempRunSibling,
    siblingTmp,
    harnessTree,
    foreignRun,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const p of [
    path.join(wt, "keep.txt"),
    path.join(scratch, "notes.txt"),
    path.join(childTmp, "probe.txt"),
    path.join(foreignRun, "payload"),
    path.join(foreignRunUnderRuns, "payload"),
    path.join(tempRunSibling, "prompt.txt"),
    path.join(siblingTmp, "other-child.txt"),
    path.join(harnessTree, "review-tree.txt"),
  ]) {
    writeFileSync(p, "x");
  }
  return {
    base,
    wt,
    scratch,
    childTmp,
    sharedTmp,
    sharedRuns,
    foreignRunUnderRuns,
    spawnTempRoot,
    tempRunSibling,
    siblingTmp,
    harnessTree,
    foreignRun,
  };
}
