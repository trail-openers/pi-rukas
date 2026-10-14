/**
 * work-driver-integrate-cycle — the cycle's OWN worktrees, as the integrate
 * step sees them (#1170).
 *
 * The state file's `pipelineState.worktrees` records every worktree the
 * branch step and its dependents created for this cycle (the develop
 * trees). The integrate step must not read those as foreign leftovers: a
 * develop tree is tree-identical to the branch head after consolidation,
 * and the sibling scan's "unpushed commit" reading parked the cycle. They
 * are excluded from the sibling scan, but a DIRTY one still refuses — the
 * exclusion waives "this is a leftover", never "this holds uncommitted
 * work". Nothing here removes an in-cycle tree.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import { DirtyWorktreeError, type ExecFn, resolvePath } from "./worktree.ts";

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
      pipelineState?: { worktrees?: Record<string, string>; integrateWorktree?: string };
    };
    const ps = parsed.pipelineState ?? {};
    const paths = Object.values(ps.worktrees ?? {});
    if (ps.integrateWorktree !== undefined) paths.push(ps.integrateWorktree);
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
 * Refuse when any of the cycle's OTHER worktrees (not the integrate path
 * `abs`) holds uncommitted work. Fail-closed: an unreadable `git status`
 * in such a tree counts as holding work. Clean trees (tree-identical or
 * differing) pass — they are the cycle's own output, not leftovers. The
 * main working tree (`repoRoot`) is never a cycle tree and is skipped: the
 * integrate step handles it separately (the detach path).
 */
export async function refuseDirtyCycleTrees(
  execFn: ExecFn,
  cycleTrees: string[],
  abs: string,
  repoRoot: string,
): Promise<void> {
  const target = resolvePath(abs);
  const main = resolvePath(repoRoot);
  for (const p of cycleTrees) {
    if (resolvePath(p) === target || resolvePath(p) === main) continue;
    try {
      await fs.access(p);
    } catch {
      continue; // recorded but gone from disk — nothing to hold
    }
    let porcelain: string;
    try {
      ({ stdout: porcelain } = await execFn("git status --porcelain", {
        cwd: p,
        maxBuffer: 1024 * 1024,
      }));
    } catch (err) {
      throw new DirtyWorktreeError({
        path: p,
        uncommittedFiles: [`git status unreadable: ${(err as Error).message ?? String(err)}`],
        unpushedCommitCount: 0,
      });
    }
    const dirt = porcelain
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l);
    if (dirt.length > 0) {
      throw new DirtyWorktreeError({ path: p, uncommittedFiles: dirt, unpushedCommitCount: 0 });
    }
  }
}
