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
 *
 * It also judges the stale `issue-<N>-integrate` tree a re-entry is about to
 * replace: whether it is registered and recorded as this cycle's, whether it
 * holds work that refuses, and (#1173) which of its commits must be kept on a
 * backup ref before it goes.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import { assertSafeRef } from "./worktree-loss.ts";
import {
  DirtyWorktreeError,
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
 * force-removed. Every ignored entry is judged as loss except the regenerable
 * dependency trees and provisioned links that worktree-loss exempts (#1170).
 * The driver never builds in this tree (verify runs at repoRoot), so `target/`
 * or `dist/` here is operator or ops-fallback output, not re-entry residue.
 * Commits are judged against `ref` (the branch tip, else the base), so a re-entry whose HEAD is already
 * on the branch is not loss. `inspectWorktreeForLoss` reports an unreadable read as
 * `inspectError` (it never throws), so any such finding refuses with
 * `DirtyWorktreeError` BEFORE anything is removed (fail closed).
 *
 * #1173 — a finding whose ONLY content is commits goes to
 * `backupIntegrateHead`, the one place that decides whether those commits are
 * the cycle's own (kept on a backup ref, the tree replaced) or foreign (a tree
 * on another branch — refused). Refusing the cycle's own commits wedged every
 * re-entry. Returns the backup ref when one was written.
 */
export async function keepOrRefuseStaleIntegrateTree(
  execFn: ExecFn,
  repoRoot: string,
  abs: string,
  ref: string,
  branchName: string,
  issue: number,
): Promise<string | undefined> {
  const finding = await inspectWorktreeForLoss(execFn, repoRoot, abs, ref);
  if (finding === undefined) return undefined; // provably clean: nothing uncommitted, no unique commits
  // Every other loss channel is judged HERE, before the commits-only path.
  const onlyCommits =
    finding.uncommittedFiles.length === 0 &&
    finding.inspectError === undefined &&
    finding.notOwnWorktree !== true;
  if (!onlyCommits) throw new DirtyWorktreeError(finding);
  try {
    return await backupIntegrateHead(execFn, abs, ref, branchName, issue);
  } catch (err) {
    throw new DirtyWorktreeError({
      ...finding,
      inspectError: `its commits could not be kept on a backup ref: ${(err as Error).message ?? String(err)}`,
    });
  }
}

/**
 * #1173 — keep the stale integrate tree's commits before the tree is removed.
 * HEAD's commits that neither `ref` (the branch tip, else the base) nor
 * `origin/<branch>` already holds are written to
 * `refs/pi-rukas/integrate-backup/issue-<N>/<sha>` (keyed by SHA, so a repeat
 * re-entry rewrites the same ref). Only a detached HEAD or one on the cycle's
 * own branch is the cycle's work: a tree on another branch holding unique
 * commits throws. Returns the ref, or `undefined` when there was nothing to
 * keep. Throws when git cannot answer — the caller then removes nothing.
 */
export async function backupIntegrateHead(
  execFn: ExecFn,
  abs: string,
  ref: string,
  branchName: string,
  issue: number,
): Promise<string | undefined> {
  assertSafeRef(ref);
  const opts = { cwd: abs, maxBuffer: 64 * 1024 };
  const sha = (await execFn("git rev-parse --verify HEAD", opts)).stdout.trim();
  assertSafeRef(sha);
  const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(`${ref}..${sha}`)}`, opts);
  if (Number.parseInt(stdout.trim(), 10) === 0) return undefined;
  if (await headReachableFrom(execFn, abs, `origin/${branchName}`)) return undefined;
  const head = (await execFn("git rev-parse --symbolic-full-name HEAD", opts)).stdout.trim();
  if (head !== "HEAD" && head !== `refs/heads/${branchName}`) {
    throw new Error(`HEAD is on ${head}, not ${branchName} — not this cycle's work`);
  }
  const backup = `refs/pi-rukas/integrate-backup/issue-${issue}/${sha}`;
  await execFn(`git update-ref ${JSON.stringify(backup)} ${JSON.stringify(sha)}`, opts);
  trace(`work-driver: kept the stale integrate tree's unpushed commits on ${backup}`);
  return backup;
}

/**
 * True only when HEAD is provably an ancestor of `remoteRef` (any failure = false).
 * `remoteRef` is built from the branch name `ensureIntegrateWorktree` already
 * validated with `assertSafeRef`, so it is not re-validated here.
 */
async function headReachableFrom(execFn: ExecFn, abs: string, remoteRef: string): Promise<boolean> {
  try {
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

/**
 * #861 round 2 — the stale-tree ownership check. The state file (the cycle's
 * `.pi/work-state/<issue>.json`) records the branch step's worktree map
 * (id → path). If the integrate path appears in that map, the tree at that
 * path is driver-owned re-entry residue (this cycle created it). If it does
 * NOT appear, the tree is NOT this cycle's — it is operator residue the
 * driver must not silently destroy (a dirty one HALTS; a clean one is
 * pre-removed by the #475 target guard below).
 *
 * An unreadable state file returns false (the safe direction: the path is
 * then treated as NOT this cycle's, so a dirty one halts rather than being
 * silently destroyed; a clean one is pre-removed and the fresh creation
 * proceeds — the same shape as the "unregistered directory" case).
 */
export function isIntegrateTreeInCycle(cycleTrees: string[], abs: string): boolean {
  const target = resolvePath(abs);
  return cycleTrees.some((p) => resolvePath(p) === target);
}

/**
 * Whether the path is a REGISTERED worktree (`git worktree list --porcelain`
 * contains it). This is the driver's stale-tree discriminator: a registered
 * tree at the integrate path is driver-owned re-entry residue (an earlier
 * attempt of this same cycle created it), so it is force-replaced. A
 * directory that exists but is registered NOWHERE is not driver-owned
 * residue — it is left for the unconditional #475 target guard, which
 * refuses a dirty one.
 *
 * Unreadable list → false (the safe direction: the path, if anything is
 * there, is then left to the guard rather than force-removed).
 */
export async function isRegisteredWorktree(
  execFn: ExecFn,
  repoRoot: string,
  abs: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const target = resolvePath(abs);
    return stdout
      .split("\n")
      .some(
        (l) =>
          l.trim().startsWith("worktree ") &&
          resolvePath(l.trim().slice("worktree ".length)) === target,
      );
  } catch {
    return false;
  }
}
