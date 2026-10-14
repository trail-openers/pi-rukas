/**
 * work-driver-integrate-cycle — the cycle's OWN worktrees, as the integrate
 * step sees them (#1170).
 *
 * The state file's `pipelineState.worktrees` records every worktree the
 * branch step and its dependents created for this cycle (the develop
 * trees). The integrate step must not read those as foreign leftovers: a
 * develop tree is tree-identical to the branch head after consolidation,
 * and the sibling scan's "unpushed commit" reading parked the cycle. They
 * are excluded from the sibling scan, but a tree that holds work still
 * refuses — the exclusion waives "this is a leftover", never "this holds
 * work". Nothing here removes an in-cycle tree.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import { assertSafeRef } from "./worktree-loss.ts";
import {
  DirtyWorktreeError,
  type DirtyWorktreeFinding,
  type ExecFn,
  inspectWorktreeForLoss,
  resolvePath,
} from "./worktree.ts";

/**
 * Every worktree path the cycle's state file records (the branch step's
 * worktree map plus the integrate tree). An unreadable or absent state file
 * returns `[]` — the safe direction: the develop trees then stay in the
 * sibling scan, which is the pre-#1170 behaviour.
 */
export async function readCycleWorktreePaths(stateFile: string | undefined): Promise<string[]> {
  if (!stateFile) return [];
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as {
      pipelineState?: { worktrees?: Record<string, unknown>; integrateWorktree?: unknown };
    };
    const ps = parsed.pipelineState ?? {};
    const paths = Object.values(ps.worktrees ?? {}).filter(
      (p): p is string => typeof p === "string",
    );
    if (typeof ps.integrateWorktree === "string") paths.push(ps.integrateWorktree);
    return paths;
  } catch (err) {
    // Reads as "no recorded cycle trees" (the safe direction for the
    // sibling scan), but the operator must be able to tell it from "none".
    trace(
      `work-driver: integrate-tree cycle check — could not read state file ${stateFile}: ${(err as Error).message ?? String(err)}`,
    );
    return [];
  }
}

/**
 * #1170 — the stale integrate tree is inspected before it is removed.
 *
 * The driver-owned stale `issue-<N>-integrate` tree is about to be
 * force-removed. Its work product is committed on the branch, so the judgement
 * is tracked modifications, untracked files and unpushed commits — ignored
 * entries are NOT judged (`ignoredIsLoss: false`). Otherwise regenerable build
 * output the ops fallback left there (`target/`, `dist/`) would wedge every
 * re-entry until an operator cleaned it by hand (#1170 follow-up). Commits are judged against
 * `ref` (the branch tip, else the base), so a re-entry whose HEAD is already
 * on the branch is not loss. A commit that is on neither the local branch nor
 * `remoteRef` (`origin/<branch>`) is unpushed work and refuses. Any finding —
 * or an inspect that throws — refuses with `DirtyWorktreeError` BEFORE anything
 * is removed (fail closed).
 */
export async function refuseLossyStaleIntegrateTree(
  execFn: ExecFn,
  repoRoot: string,
  abs: string,
  ref: string,
  remoteRef: string,
): Promise<void> {
  let finding: DirtyWorktreeFinding | undefined;
  try {
    finding = await inspectWorktreeForLoss(execFn, repoRoot, abs, ref, { ignoredIsLoss: false });
  } catch (err) {
    finding = {
      path: abs,
      uncommittedFiles: [],
      unpushedCommitCount: 0,
      inspectError: err instanceof Error ? err.message : String(err),
    };
  }
  if (
    finding !== undefined &&
    finding.uncommittedFiles.length === 0 &&
    finding.inspectError === undefined &&
    finding.notOwnWorktree !== true &&
    (await headReachableFrom(execFn, abs, remoteRef))
  ) {
    return; // every commit HEAD has is already on origin/<branch>
  }
  if (finding !== undefined) throw new DirtyWorktreeError(finding);
}

/** True only when HEAD is provably an ancestor of `remoteRef` (any failure = false). */
async function headReachableFrom(execFn: ExecFn, abs: string, remoteRef: string): Promise<boolean> {
  try {
    assertSafeRef(remoteRef);
    await execFn(`git merge-base --is-ancestor HEAD ${JSON.stringify(remoteRef)}`, {
      cwd: abs,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse when any of the cycle's OTHER worktrees (not the integrate path
 * `abs`) holds work: uncommitted or ignored-non-regenerable entries, an
 * unreadable tree, or a directory that is not its own worktree. A tree that
 * differs from the base only by its own commits is the cycle's output and
 * passes. The main working tree (`repoRoot`) is never a cycle tree and is
 * skipped: the integrate step handles it separately (the detach path).
 * `inspectWorktreeForLoss` is the single no-loss definition (#1170).
 */
export async function refuseDirtyCycleTrees(
  execFn: ExecFn,
  cycleTrees: string[],
  abs: string,
  repoRoot: string,
  baseSha: string,
): Promise<void> {
  const target = resolvePath(abs);
  const main = resolvePath(repoRoot);
  for (const p of cycleTrees) {
    if (resolvePath(p) === target || resolvePath(p) === main) continue;
    // Ignored entries are not refused here: in-cycle trees are never removed,
    // so an ignored build artefact (target/) is not a reason to stop the
    // integration. Tracked/untracked work, unreadable trees and foreign
    // directories still refuse.
    const finding = await inspectWorktreeForLoss(execFn, repoRoot, p, baseSha, {
      ignoredIsLoss: false,
    });
    if (finding === undefined) continue;
    // Tree-differs alone is the cycle's own output (a develop commit) — only
    // work the finding actually holds refuses here.
    if (
      finding.uncommittedFiles.length > 0 ||
      finding.inspectError !== undefined ||
      finding.notOwnWorktree === true
    ) {
      throw new DirtyWorktreeError(finding);
    }
  }
}
