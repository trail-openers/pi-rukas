/**
 * work-driver-dep-scheduler — #679 case 2(a)/2(b): topological dispatch order
 * and deferred worktree creation for workstreams that declare `depends-on`.
 *
 * The plan-quality gate (planQualityReason) guarantees the depends-on graph
 * is a DAG — no cycles, no dangling references — BEFORE runDevelop runs.
 * This module therefore needs no cycle handling of its own; it only resolves
 * the full transitive closure of `dependsOn` so that a dependent workstream
 * is dispatched only AFTER its entire dependency chain has committed.
 *
 * Independent workstreams (no `dependsOn`) are dispatched in parallel as
 * before (`Promise.all` over the independent set). Dependent workstreams are
 * dispatched sequentially after their dependencies complete, in topological
 * order (A → B → C for a 3-deep chain). A workstream whose dependency
 * FAILED (dispatch threw, or the dependency's worktree has zero commits
 * ahead of its own base) is SKIPPED — recorded as `branch-completed` with
 * `ok: false` and a reason — because building on an empty or failed
 * dependency would produce an incoherent tree. There is no baseSha fallback:
 * a fallback to baseSha is exactly what produces the "dependent workstream
 * sees none of the dependency's work" failure the ticket fixes.
 *
 * The N=1 `default` path and plans with no `dependsOn` declarations are
 * byte-identical to the pre-#679 behaviour: every workstream is independent,
 * the independent set is all of them, and `Promise.all` runs as before.
 */

import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";
import { worktreeCreate, worktreePath } from "./worktree.ts";

/**
 * #679 — the dispatch order for a set of workstreams with a depends-on map.
 *
 * Returns `[independent, dependentOrdered]` where:
 * - `independent` — workstreams with no `dependsOn` (dispatched in parallel
 *   via `Promise.all` as before).
 * - `dependentOrdered` — workstreams with a non-empty `dependsOn`, in
 *   topological order: a workstream appears only AFTER all of its
 *   dependencies (direct and transitive) have appeared earlier in the list.
 *
 * The input graph is guaranteed a DAG (the plan-quality gate runs first),
 * so this always terminates. The transitive closure is resolved by
 * topological sort (Kahn's algorithm), not by repeatedly checking direct
 * `dependsOn` — a 3-deep chain A → B → C requires B to wait on A and C to
 * wait on B, which is the full closure, not just the direct edge.
 */
export function topologicalDispatchOrder(
  ids: string[],
  dependsOnMap: Record<string, string[]>,
): { independent: string[]; dependentOrdered: string[] } {
  const independent: string[] = [];
  const dependent: string[] = [];
  for (const id of ids) {
    const deps = dependsOnMap[id];
    if (deps && deps.length > 0) dependent.push(id);
    else independent.push(id);
  }
  // Kahn's algorithm on the dependent subgraph. The full graph is a DAG
  // (plan-quality gate guarantee), so the dependent subgraph is also a DAG
  // and this terminates with all nodes ordered.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of dependent) {
    inDegree.set(id, 0);
  }
  for (const id of dependent) {
    for (const dep of dependsOnMap[id] ?? []) {
      // Only count edges within the dependent subgraph: a dependent
      // workstream's dependency may be independent (in which case it's
      // already handled by the Promise.all), or dependent (in which case
      // the edge matters for ordering).
      if (dependent.includes(dep)) {
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        const existing = dependents.get(dep) ?? [];
        existing.push(id);
        dependents.set(dep, existing);
      }
    }
  }
  const queue: string[] = [];
  for (const id of dependent) {
    if ((inDegree.get(id) ?? 0) === 0) queue.push(id);
  }
  const ordered: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    ordered.push(node);
    for (const dependentOfNode of dependents.get(node) ?? []) {
      const remaining = (inDegree.get(dependentOfNode) ?? 0) - 1;
      inDegree.set(dependentOfNode, remaining);
      if (remaining === 0) queue.push(dependentOfNode);
    }
  }
  // A node that was never enqueued would mean a cycle in the dependent
  // subgraph — impossible (plan-quality gate guarantee), but degrade
  // gracefully: append it at the end so it's still dispatched (the
  // caller's dependency-failure skip will handle the empty-dep case).
  for (const id of dependent) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return { independent, dependentOrdered: ordered };
}

/**
 * #679 case 2(b) — the per-workstream effective base SHA for deferred
 * worktree creation.
 *
 * For an independent workstream this is the global baseSha. For a dependent
 * workstream it is its DIRECT dependency's post-commit HEAD SHA (resolved in
 * the dependency's worktree via `git rev-parse HEAD`). If the dependency's
 * dispatch failed or its worktree has zero commits ahead of its own base,
 * the dependent is SKIPPED (no worktree created, no dispatch) — recorded as
 * `branch-completed` with `ok: false` and a reason. There is no baseSha
 * fallback: building on baseSha when the dependency produced nothing is
 * exactly the incoherent-tree failure the ticket fixes.
 *
 * Returns `{ fromRef, skipReason }` — if `skipReason` is set, the caller
 * must NOT create the worktree or dispatch the developer for this workstream.
 */
export async function resolveDependentBase(
  execFn: ExecFn,
  repoRoot: string,
  issue: number,
  dependentId: string,
  dependsOn: string[],
  worktrees: Record<string, string>,
  workstreamBaseShas: Record<string, string>,
  globalBaseSha: string | undefined,
): Promise<{
  fromRef: string | undefined;
  skipReason: string | undefined;
  baseSha: string | undefined;
}> {
  // The dependent's base is its DIRECT dependency's post-commit HEAD. For
  // multiple depends-on entries, use the FIRST one (the plan-quality gate
  // does not enforce a single-dep constraint; the first is the declared
  // primary). The transitive chain is handled by the topological order
  // itself — B's base is A's post-commit SHA, C's base is B's post-commit
  // SHA, etc.
  const primaryDep = dependsOn[0];
  if (!primaryDep) {
    return {
      fromRef: globalBaseSha,
      skipReason: undefined,
      baseSha: globalBaseSha,
    };
  }
  const depWorktree = worktrees[primaryDep];
  if (!depWorktree) {
    return {
      fromRef: undefined,
      skipReason: `dependency ${primaryDep} has no worktree (it was skipped or failed)`,
      baseSha: undefined,
    };
  }
  // Resolve the dependency's post-commit HEAD SHA.
  let depHeadSha = "";
  try {
    const { stdout } = await execFn("git rev-parse HEAD", {
      cwd: depWorktree,
      maxBuffer: 64 * 1024,
    });
    depHeadSha = stdout.trim();
  } catch (err) {
    return {
      fromRef: undefined,
      skipReason: `could not resolve dependency ${primaryDep}'s HEAD SHA: ${(err as Error).message?.slice(0, 120)}`,
      baseSha: undefined,
    };
  }
  if (!depHeadSha) {
    return {
      fromRef: undefined,
      skipReason: `dependency ${primaryDep}'s worktree has no HEAD (empty or corrupted)`,
      baseSha: undefined,
    };
  }
  // Check whether the dependency actually produced work: its worktree must
  // have at least one commit ahead of ITS OWN base (the dependency's base,
  // not the global baseSha — the dependency may itself be a dependent).
  const depBase = workstreamBaseShas[primaryDep] ?? globalBaseSha;
  if (depBase && /^[0-9a-f]{40}$/.test(depBase)) {
    let ahead = 0;
    try {
      const { stdout } = await execFn(`git rev-list --count ${depBase}..HEAD`, {
        cwd: depWorktree,
        maxBuffer: 64 * 1024,
      });
      ahead = Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      // Not evidence either way — treat as 0 (skip the dependent).
      ahead = 0;
    }
    if (ahead === 0) {
      return {
        fromRef: undefined,
        skipReason: `dependency ${primaryDep} produced zero commits ahead of its own base — building on it would produce an incoherent tree (no baseSha fallback by design)`,
        baseSha: undefined,
      };
    }
  }
  return {
    fromRef: depHeadSha,
    skipReason: undefined,
    baseSha: depHeadSha,
  };
}

/**
 * #679 case 2(b) — create the dependent workstream's worktree from the
 * dependency's post-commit SHA (deferred creation, after the dependency's
 * developer dispatch has committed). Uses the same `worktreeCreate`
 * primitive as the branch step, just with a different `fromRef` and later
 * timing. The worktree name follows the same convention as the branch step:
 * `issue-<N>-<id>` under `.worktrees/`.
 *
 * Returns the created worktree's absolute path, or `undefined` if the
 * worktree could not be created (the caller records the failure and skips
 * the developer dispatch).
 */
export async function createDependentWorktree(
  execFn: ExecFn,
  repoRoot: string,
  issue: number,
  dependentId: string,
  fromRef: string,
): Promise<string | undefined> {
  const name = `issue-${issue}-${dependentId}`;
  try {
    const result = await worktreeCreate(execFn, {
      repoRoot,
      name,
      fromRef,
    });
    trace(
      `work-driver: deferred worktree created for ${dependentId} @ ${fromRef.slice(0, 8)} (${result.path})`,
    );
    return result.path;
  } catch (err) {
    trace(
      `work-driver: deferred worktree creation failed for ${dependentId}: ${(err as Error).message?.slice(0, 200)}`,
    );
    return undefined;
  }
}

/**
 * #679 — the workstream ids that should be skipped (not dispatched) because
 * their dependency chain has a failure. Computed AFTER the independent set
 * resolves and the dependent set resolves in topological order: a dependent
 * whose dependency was skipped (or failed) is itself skipped, and so on down
 * the chain.
 *
 * Returns a map `{ [workstreamId]: skipReason }` for each workstream that
 * should be skipped. The caller records `branch-completed` with `ok: false`
 * and the reason for each skipped workstream.
 */
export function computeSkipCascade(
  dependentOrdered: string[],
  dependsOnMap: Record<string, string[]>,
  failedOrSkipped: Set<string>,
): Map<string, string> {
  const skips = new Map<string, string>();
  for (const id of dependentOrdered) {
    const deps = dependsOnMap[id] ?? [];
    const failedDep = deps.find((d) => failedOrSkipped.has(d) || skips.has(d));
    if (failedDep) {
      skips.set(id, `dependency ${failedDep} was skipped or failed`);
    }
  }
  return skips;
}

/** Re-export for the caller (runDevelop) to construct the worktree path. */
export { worktreePath };

/**
 * #679 — the `WorkState` shape needed by the scheduler: only the fields
 * it reads, so the module stays decoupled from the full state type.
 */
export interface DepSchedulerState {
  pipelineState: WorkState["pipelineState"];
}
