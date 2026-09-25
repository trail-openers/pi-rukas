/**
 * work-develop-dependent — #679: the dependent-workstream phase of
 * runDevelop.
 *
 * Moved VERBATIM from work-develop-run.ts (the 500-line gate headroom for
 * the #799 F2 step-notice wiring): `runDependentWorkstreams` (sequential
 * topological dispatch of `dependsOn` workstreams, deferred worktree
 * creation from the dependency's post-commit SHA, the park-on-dirty-leftover
 * coupling) and its one helper `parkDeferredLeftover` (the
 * cap-hit + park-flag structural unit). No behaviour change — the import
 * paths below are the union of both files' imports, and `work-develop-run.ts`
 * re-exports both names so existing imports keep their path.
 */
import { trace } from "./trace.ts";
import type { BranchCompletedExtra, DependentRunState } from "./work-develop-run.ts";
import { parkDeferredLeftover } from "./work-develop-run.ts"; /**
 * #679 — run all dependent workstreams sequentially in topological order.
 * Each dependent's worktree is created (deferred) from its dependency's
 * post-commit SHA. A dependent whose dependency failed/was skipped is
 * itself skipped. Returns the updated worktrees and workstreamBaseShas,
 * plus `parked` when a dirty-leftover refusal appended its cap-hit mid-step
 * (the caller must not append further events or run the safety-net/verify
 * gates — the cap-hit must remain the step's tail event so the step router
 * routes the cycle to handoff on it instead of appending a duplicate
 * generic cap on the branches-converged verdict). A `create-error` (the
 * non-dirty class) does NOT park: it is recorded and the remaining
 * dependents keep processing (the PR7 branches-converged router halts the
 * cycle at the tail, unchanged).
 */
import type { DriverContext } from "./work-driver-context.ts";
import {
  computeSkipCascade,
  createDependentWorktree,
  resolveDependentBase,
} from "./work-driver-dep-scheduler.ts";
import { armStepNotice } from "./work-driver-step-notice.ts";
import { writeState } from "./workflow-state.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
export async function runDependentWorkstreams(
  ctx: DriverContext,
  ids: string[],
  workstreams: NonNullable<WorkState["pipelineState"]["workstreams"]>,
  dependsOnMap: Record<string, string[]>,
  failedOrSkipped: Set<string>,
  verdicts: Array<{ id: string; ok: boolean }>,
  branchEvents: WorkEvent[],
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  worktrees: Record<string, string>,
  workstreamBaseShas: Record<string, string>,
  globalBaseSha: string | undefined,
  allIds: string[],
  runOneWorkstream: (id: string, cwd: string) => Promise<{ id: string; ok: boolean }>,
  /** #753 — the per-run state (in-cycle worktrees, park flag, dep-completion timestamps, failure source). */
  run: DependentRunState,
): Promise<{
  worktrees: Record<string, string>;
  workstreamBaseShas: Record<string, string>;
  parked: boolean;
}> {
  const wtRef = { worktrees, workstreamBaseShas };
  const { stateRef, inCycleWorktrees, depCompletedAtMap, failureSource } = run;
  // #799 F2 — the dependent phase's wall-clock span (fire-once, above healthy band).
  const cancelPhaseNotice = armStepNotice({
    state: stateRef.current,
    step: "develop (dependent)",
    startedAt: Date.now(),
  });
  // #753 — one place for the base shape of a failed dependent's branch-completed
  // event (the `ok: false, ms: 0` contract); each failure site supplies its own
  // error text and any additional fields (the typed `extra` keeps the cast safe).
  // #753 (six-lens LOW) — the object literal type-checks directly against the
  // `branch-completed` union member (a failed dependent's branch-completed
  // event), so the `as WorkEvent` cast the spread made necessary is gone:
  // `satisfies` keeps the union member's type-check while letting the
  // optional `extra` fields widen as the union allows.
  const recordBranchCompleted = (id: string, error: string, extra?: BranchCompletedExtra) => {
    const ev = {
      kind: "branch-completed",
      step: "develop",
      workstreamId: id,
      ok: false,
      ms: 0,
      at: Date.now(),
      error,
      ...(extra ?? {}),
    } satisfies Extract<WorkEvent, { kind: "branch-completed" }>;
    branchEvents.push(ev);
  };
  for (const id of ids) {
    const ws = workstreams[id];
    const dependsOn = ws?.dependsOn ?? [];
    // #753 — the FIRST declared dependency is the declared primary (same
    // doctrine as `resolveDependentBase`); multi-dep workstreams record that
    // primary's completion timestamp.
    const depCompletedAt = depCompletedAtMap?.[dependsOn[0] ?? ""];
    const skips = computeSkipCascade([id], dependsOnMap, failedOrSkipped, failureSource);
    const skipReason = skips.get(id);
    if (skipReason) {
      trace(`work-driver: skipping dependent workstream ${id} — ${skipReason}`);
      failedOrSkipped.add(id);
      if (failureSource) failureSource[id] = failureSource[id] ?? "skipped";
      verdicts.push({ id, ok: false });
      // #753 — record for EVERY plan size (the N>1 guard made a single-workstream failure completely silent).
      recordBranchCompleted(
        id,
        skipReason,
        depCompletedAt !== undefined ? { depCompletedAt } : undefined,
      );
      continue;
    }
    const depResult = await resolveDependentBase(
      execFn,
      ctx.repoRoot,
      ctx.issue,
      id,
      dependsOn,
      wtRef.worktrees,
      wtRef.workstreamBaseShas,
      globalBaseSha,
    );
    if (depResult.skipReason || !depResult.fromRef) {
      trace(
        `work-driver: skipping dependent workstream ${id} — ${depResult.skipReason ?? "no fromRef"}`,
      );
      failedOrSkipped.add(id);
      if (failureSource) failureSource[id] = failureSource[id] ?? "skipped";
      verdicts.push({ id, ok: false });
      recordBranchCompleted(
        id,
        depResult.skipReason ?? "could not resolve dependency's post-commit SHA",
        depCompletedAt !== undefined ? { depCompletedAt } : undefined,
      );
      continue;
    }
    const created = await createDependentWorktree(
      execFn,
      ctx.repoRoot,
      ctx.issue,
      id,
      depResult.fromRef,
      inCycleWorktrees,
    );
    if (created.path === undefined) {
      failedOrSkipped.add(id);
      if (failureSource) failureSource[id] = "failed";
      verdicts.push({ id, ok: false });
      // #753 — the underlying git error is recorded on the event (not a hand-written literal), plus the deferral context.
      const dep = dependsOn[0] ?? "";
      const isDirty = created.failure.class === "dirty-leftover";
      const depCompletedAtField = depCompletedAt !== undefined ? { depCompletedAt } : {};
      recordBranchCompleted(
        id,
        isDirty
          ? `deferred worktree creation refused for ${id} — dirty or retained same-issue leftover at ${created.failure.leftoverPath ?? "(path unknown)"}; parking the cycle (uncommitted work must not be force-removed)`
          : `deferred worktree creation failed for ${id}: ${created.failure.error?.slice(0, 200) ?? "unknown error"}`,
        {
          ...depCompletedAtField,
          deferredCreation: {
            waitedFor: dep,
            resolvedBaseRef: depResult.fromRef,
            failure: isDirty
              ? {
                  class: "dirty-leftover" as const,
                  leftoverPath: created.failure.leftoverPath ?? "",
                  error: created.failure.error,
                }
              : {
                  class: "create-error" as const,
                  gitCommand: created.failure.gitCommand,
                  exitStatus: created.failure.exitStatus,
                  stderr: created.failure.stderr,
                  error: created.failure.error,
                },
          },
        },
      );
      if (isDirty) {
        // #753 — a DirtyWorktreeError (a dirty or retained same-issue leftover) is the finding. PARK with it stated.
        // parkDeferredLeftover appends the cap-hit AND returns the flag in one
        // step — the flag and the append are one structural unit (the MEDIUM
        // finding: they were previously coupled only by a comment). The
        // sibling workstreams' branch-completed events are flushed to stateRef
        // (and persisted) BEFORE the cap-hit lands, so the cap-hit is still
        // the tail the step router routes on, while the independent phase's
        // results stay in the durable log instead of surviving only in child
        // transcripts.
        const leftoverPath = created.failure.leftoverPath ?? "(path unknown)";
        const parked = parkDeferredLeftover(stateRef, leftoverPath, branchEvents);
        await writeState(ctx.repoRoot, stateRef.current);
        cancelPhaseNotice();
        trace(
          `work-driver: PARK — deferred worktree creation for ${id} refused by dirty leftover at ${leftoverPath}; parking the cycle (no force-remove)`,
        );
        return { ...wtRef, parked };
      }
      // #753 — a create-error (transient git failure) is NOT a park. Record
      // it and keep processing the remaining dependents (the pre-#753
      // behaviour a review round flagged: the old code `continue`d, and the
      // halt dropped their per-workstream recording). A dependent whose own
      // dependency chain is intact can still create and dispatch, and each
      // failure is recorded. Terminal routing is unchanged: the PR7
      // branches-converged router halts on ANY failed verdict + HALT policy,
      // so a failed workstream is never silently skipped downstream.
      continue;
    }
    const createdPath = created.path;
    wtRef.worktrees = { ...wtRef.worktrees, [id]: createdPath };
    // #753 — the dependent's worktree is now part of this cycle; a LATER
    // dependent's deferred creation must not treat it as a same-issue
    // leftover (it is in-flight work, not residue).
    if (inCycleWorktrees) inCycleWorktrees.push(createdPath);
    const depBaseSha = depResult.baseSha ?? depResult.fromRef;
    if (depBaseSha) wtRef.workstreamBaseShas = { ...wtRef.workstreamBaseShas, [id]: depBaseSha };
    await runOneWorkstream(id, createdPath);
    // #753 — the dependent's completion is the timestamp its own dependents record.
    if (depCompletedAtMap) depCompletedAtMap[id] = Date.now();
    // #679 — after this workstream dispatches, check if it actually produced
    // commits ahead of its base. If it produced NOTHING (the case-2(c)
    // falsely-ok shape: the dispatch exited 0 but the tree is empty), any
    // downstream dependents must be skipped: building a worktree on a
    // dependency that shipped nothing is the incoherent-tree failure this
    // ticket fixes. Fail-safe: an unreadable count also blocks downstream.
    const ownBase = wtRef.workstreamBaseShas[id] ?? globalBaseSha;
    if (typeof ownBase === "string" && /^[0-9a-f]{40}$/.test(ownBase)) {
      try {
        const { stdout } = await execFn(`git rev-list --count ${ownBase}..HEAD`, {
          cwd: createdPath,
          maxBuffer: 64 * 1024,
        });
        if (Number.parseInt(stdout.trim(), 10) === 0) failedOrSkipped.add(id);
      } catch {
        failedOrSkipped.add(id);
      }
    } else {
      failedOrSkipped.add(id);
    }
  }
  cancelPhaseNotice();
  return { ...wtRef, parked: false };
}
