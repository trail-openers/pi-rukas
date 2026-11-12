/**
 * Shared on-disk layout for the #2200 child-deletion tests.
 *
 *   base/
 *     wt/                       the fenced worktree (the child's cwd)
 *     scratch/                  the cycle scratch dir
 *     pi-rukas-child-own/       the child's OWN per-spawn temp dir (PI_ENSEMBLE_CHILD_TMP)
 *     tmp/                      the SHARED temp root — never a delete target
 *       other-session-run/      another run's dir under it
 *     pi-rukas-child-sibling/   another child's per-child temp root
 *     pi-rukas-review-other/    a harness-owned tree (a live reviewer checkout)
 *
 * The "shared temp root" is a directory of its own rather than the machine's
 * temp dir: the rule must refuse a shared root whatever it is called, and these
 * tests must never delete outside their own tree. The layout lives under the
 * repo's gitignored `tmp/` (as `write-fence-fixture.ts` does), not beside the
 * test: the exit hook does not fire when the runner's bound kills the process,
 * and a tree left inside the tracked tree would show in `git status`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DeletionFixture {
  base: string;
  wt: string;
  scratch: string;
  childTmp: string;
  sharedTmp: string;
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
  for (const dir of [wt, scratch, childTmp, sharedTmp, siblingTmp, harnessTree, foreignRun]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const p of [
    path.join(wt, "keep.txt"),
    path.join(scratch, "notes.txt"),
    path.join(childTmp, "probe.txt"),
    path.join(foreignRun, "payload"),
    path.join(siblingTmp, "other-child.txt"),
    path.join(harnessTree, "review-tree.txt"),
  ]) {
    writeFileSync(p, "x");
  }
  return { base, wt, scratch, childTmp, sharedTmp, siblingTmp, harnessTree, foreignRun };
}
