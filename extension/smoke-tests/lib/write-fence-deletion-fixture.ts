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
 *       pi-rukas-Q1/              the per-child dir a spawn hands the walk as its seed
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
 * The layout lives under extension/smoke-tests/tmp/, not beside the test: the exit hook
 * does not fire when the runner's bound kills the process, and a tree left inside the
 * tracked tree would show in git status. That path is NOT git-ignored by anything this
 * repository commits — the committed .gitignore covers the root-level tmp-dash pattern,
 * and extension/tmp/ appears only in a per-clone .git/info/exclude — so a run whose
 * cleanup was skipped leaves an untracked tree there. The path is outside every directory
 * the write fence, the deletion rule and the repo's gates judge, which is why it is still
 * the right place for the scratch; an operator who wants a leftover tree out of git status
 * adds the ignore to their own clone.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./env-scope.ts";

/**
 * A HOME/TMPDIR pair the deletion rows are written against, with the temp root UNDER the
 * home (what macOS publishes, and what an operator who parks scratch at ~/tmp has), so a
 * row cannot pass by having its temp root fall outside the home it names.
 */
export function deletionHost(base: string): { HOME: string; TMPDIR: string } {
  return { HOME: base, TMPDIR: path.join(base, "tmp") };
}

/**
 * Run body with HOME and TMPDIR pinned to host, restoring both afterwards.
 *
 * Every deletion row reads its verdict from process.env behind the row's back, twice over:
 * os.homedir() is the passwd home the rule refuses beside the env's HOME, and os.tmpdir()
 * is the seed of the ancestor walk in forbiddenWorkingDirectories. A row that leaves either
 * to the runner is judged against whatever host ran it, so the same row can be green under
 * a temp root outside the home and red under one inside it. Both variables are pinned for
 * the whole file (the test files open with withDeletionHost) and again for any block that
 * passes its own HOME/TMPDIR to the rule, so a verdict is a function of the row's own env
 * object alone.
 */
export function withDeletionHost<T>(host: { HOME: string; TMPDIR: string }, body: () => Promise<T>): Promise<T> {
  return withEnv({ HOME: host.HOME, TMPDIR: host.TMPDIR }, async () => {
    await body();
  });
}

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
  /** Pass as `deletionRootsFrom`'s `spawnTempRoot` for the containment row: the temp root the walk
   *  is seeded from, so the ancestor it adds is this tree's PARENT. For the shape a real spawn
   *  hands the walk, use `spawnChildDir` instead. */
  spawnTempRoot: string;
  /**
   * The seed a REAL spawn hands the walk. `spawn-support.ts` mkdtemps each child's per-child temp
   * dir as `pi-rukas-<random>` under `os.tmpdir()`, so the walk's seed is that dir and the ancestor
   * it climbs is its parent, the temp root. Injecting the temp root itself asks the walk to climb
   * one level above anything a spawn does, which is a shape no dispatch reaches.
   */
  spawnChildDir: string;
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
  // The per-child dir the walk is seeded from, carrying the basename the spawn layer really gives
  // one (`mkdtemp(os.tmpdir() + "/pi-rukas-")`). A row that seeds the walk here judges the shape
  // every spawn has — the seed's parent — rather than the tree above it.
  const spawnChildDir = path.join(spawnTempRoot, "pi-rukas-Q1");
  for (const dir of [
    wt,
    scratch,
    childTmp,
    sharedTmp,
    sharedRuns,
    foreignRunUnderRuns,
    spawnTempRoot,
    spawnChildDir,
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
    path.join(spawnChildDir, "prompt.txt"),
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
    spawnChildDir,
    siblingTmp,
    harnessTree,
    foreignRun,
  };
}
