/**
 * work-develop-run — #679: the per-workstream dispatch closure for runDevelop.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate). Owns the
 * shared dispatch logic for one workstream (memory-brief retrieval, the
 * developer + speculative-explore `Promise.allSettled` race, the completion
 * and `branch-completed` events, the case-1 sibling-injection) and
 * `runDependentWorkstreams` (the dependent-workstream phase: skip cascade,
 * deferred worktree creation from the dependency's post-commit SHA, base
 * resolution). The closure captures per-run state via `DevelopRunState` so
 * the caller shares it across both dispatch phases.
 *
 * `runDevelopTopological` — the #679 topological-dispatch core (independent
 * fan-out, failed/skipped detection, the safety net + verify gate) — lives
 * in work-develop-topological.ts.
 */
import path from "node:path";
import { buildMemoryBrief } from "./memory-brief.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  computeSkipCascade,
  createDependentWorktree,
  resolveDependentBase,
  topologicalDispatchOrder,
} from "./work-driver-dep-scheduler.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import {
  inlineDevelopPrompt,
  inlineSpeculativeExplorePrompt,
} from "./work-driver-prompts-early.ts";
import { clearDispatch } from "./work-driver-resume.ts";
import { applySafetyNet, hasAnyWorktreeEvidence } from "./work-driver-safety-net.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { writeState } from "./workflow-state.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/** Per-run mutable state shared by both dispatch phases. */
export interface DevelopRunState {
  ctx: DriverContext;
  /** The active issue list (NEEDS_WORK subset after explore). */
  activeIssues: number[];
  /** The scratch dir absolute path. */
  scratchAbs: string;
  /** The workstreams map (superset shape so the closure reads paths/scope without a cast). */
  workstreams: Record<
    string,
    | {
        id: string;
        scope: string;
        paths: string[];
        outOfScope: string[];
        dependsOn?: string[];
        integrationTest?: string;
      }
    | undefined
  >;
  /** All workstream ids (independent + dependent). */
  ids: string[];
  /** The dispatch function (ctx.dispatchFn ?? dispatchCore). */
  dispatch: NonNullable<DriverContext["dispatchFn"]>;
  /** Per-branch verdicts accumulated across both phases. */
  verdicts: Array<{ id: string; ok: boolean }>;
  /** Per-branch events (completion, speculative, branch-completed, dispatch-failed). */
  branchEvents: WorkEvent[];
  /** The current state (mutated by appendEvent for memory-inject events). */
  stateRef: { current: WorkState };
}

/** #753 — per-run state threaded into the dependent phase (always passed together). */
export interface DependentRunState {
  stateRef: { current: WorkState };
  /** The worktrees that exist as part of THIS cycle, keyed by workstream id
   * (the branch step's creations plus the dependents created so far).
   * #753 — the #545 same-issue dirty scan in `worktreeCreate` is unbounded
   * within a cycle: an earlier workstream of this same cycle (independent or
   * dependent) lives at `.worktrees/issue-<N>-<id>` and is legitimately dirty
   * while its own developer is still working. The scan must treat those as
   * in-flight work, not as a "leftover" — otherwise one sibling's uncommitted
   * work parks the whole cycle on a false positive. */
  inCycleWorktrees?: string[];
  depCompletedAtMap?: Record<string, number>;
  failureSource?: Record<string, "skipped" | "failed">;
}

/** #753 — the optional `extra` fields added to a failed dependent's
 * branch-completed event. Typed as `Partial` of the `branch-completed` union
 * member: the `satisfies` check in `recordBranchCompleted` keeps the spread
 * type-checking against that member, so a mistyped `extra` field is a
 * compile error, not a read-time surprise. (Nothing here protects readers —
 * the branch-completed event is the record; the typing protects writers.) */
export type BranchCompletedExtra = Partial<Extract<WorkEvent, { kind: "branch-completed" }>>;

/**
 * #753 — append the dirty-leftover cap-hit and return `true` (the caller
 * returns `parked: true` and short-circuits). This helper is the SINGLE
 * place that couples the cap-hit append to the park flag: the flag and the
 * append are one structural unit (no code path sets one without the other),
 * and the append lands at the event-log TAIL — the step router routes on the
 * tail, and the caller's short-circuit (work-develop-topological.ts) must
 * keep it there.
 *
 * `branchEvents` (the accumulated sibling events: completion + branch-completed
 * records from the independent phase and earlier dependents) is flushed to the
 * state BEFORE the cap-hit lands, so sibling results survive in the durable log
 * and the cap-hit is still the tail.
 */
export function parkDeferredLeftover(
  stateRef: { current: WorkState },
  leftoverPath: string,
  branchEvents?: WorkEvent[],
): boolean {
  stateRef.current = appendEvent(stateRef.current, ...(branchEvents ?? []), {
    kind: "cap-hit",
    at: Date.now(),
    cap: "deferred-creation:develop",
    reviewRound: stateRef.current.pipelineState.reviewRound,
    nextStep: "handoff",
  });
  return true;
}

/** Create the per-workstream dispatch closure (captures `stateRef` for memory-inject events). */
export function makeRunOneWorkstream(
  s: DevelopRunState,
): (id: string, cwd: string) => Promise<{ id: string; ok: boolean }> {
  return async (id: string, cwd: string) => {
    const { ctx, activeIssues, scratchAbs, workstreams, ids, dispatch } = s;
    // The speculative-explore knob is a global env var, not per-run state,
    // so the closure reads it directly (the caller does not thread it).
    const speculativeOn = process.env.PI_ENSEMBLE_SPECULATIVE_EXPLORE === "1";
    const ws = workstreams[id];
    const startedAt = Date.now();
    const developerLabel = ids.length > 1 ? `developer[${id}]` : "developer";
    const speculativeContextPath = path.join(scratchAbs, `speculative-${id}.md`);
    // #679 case 1 — sibling workstreams for the informational injection.
    // Gated on N>1 and workstreamId !== "default" (the existing `parallel`
    // framing gate). The N=1 default path passes nothing → byte-identical.
    // This is INFORMATIONAL ONLY — the scope-fanout gate in
    // work-driver-verify-develop.ts reads `workstream.paths` from state,
    // never the prompt text.
    const isParallel = ids.length > 1 && id !== "default";
    const siblingWorkstreams = isParallel
      ? ids
          .filter((other) => other !== id)
          .map((other) => {
            const o = workstreams[other];
            return o ? { id: other, scope: o.scope, paths: o.paths } : undefined;
          })
          .filter((x): x is { id: string; scope: string; paths: string[] } => x !== undefined)
      : undefined;
    try {
      // Fire developer + (optional) speculative explore CONCURRENTLY;
      // allSettled so one failing does not abort the other.
      // #422 — prior memory about the files this workstream will touch.
      // Never fatal: any vipune problem degrades to an empty brief.
      const brief = await buildMemoryBrief(ws?.paths ?? [], {
        cwd: ctx.repoRoot,
        timeoutMs: 8000,
      });
      // #751 — resolve the project's verify command ONCE PER WORKSTREAM, from
      // the same source the develop-verify gate uses (verifyCmdFor at
      // work-driver-verify-develop.ts:292). Thread it into the prompt as a
      // plain string so the developer's self-check and the driver's gate
      // can never diverge; the gate itself is unchanged — it still runs and
      // still disbelieves the developer's claim.
      const verifyCmd = await verifyCmdFor(ctx.repoRoot);
      s.stateRef.current = appendEvent(s.stateRef.current, {
        kind: "memory-inject",
        at: Date.now(),
        step: "develop",
        queries: brief.queries,
        hits: brief.hits.length,
        emptyBrief: brief.emptyBrief,
        ids: brief.hits.map((h: { id: string }) => h.id),
      });

      const [developerSettled, speculativeSettled] = await Promise.allSettled([
        dispatch(
          ctx.pi,
          {
            role: "developer",
            prompt: inlineDevelopPrompt(
              activeIssues,
              scratchAbs,
              ws,
              ids.length > 1 ? id : undefined,
              speculativeOn ? speculativeContextPath : undefined,
              brief.text,
              siblingWorkstreams,
              verifyCmd,
            ),
            cwd,
          },
          { label: developerLabel },
        ),
        speculativeOn
          ? dispatch(
              ctx.pi,
              {
                role: "explore",
                prompt: inlineSpeculativeExplorePrompt(
                  activeIssues,
                  ws,
                  speculativeContextPath,
                  scratchAbs,
                ),
                cwd,
              },
              {
                label: ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative",
              },
            )
          : Promise.resolve(null),
      ]);
      // Record the speculative outcome (best-effort observability;
      // failure is non-fatal — the developer ran on whatever context
      // Step 1's explore + the scratch file provided).
      if (speculativeSettled.status === "fulfilled" && speculativeSettled.value !== null) {
        const specEvent = await buildCompletionEvent(
          ctx,
          "develop",
          "explore",
          ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative",
          speculativeSettled.value,
        );
        s.branchEvents.push(specEvent);
      } else if (speculativeSettled.status === "rejected") {
        trace(
          `work-driver: speculative explore for workstream ${id} threw: ${(speculativeSettled.reason as Error).message?.slice(-200)}`,
        );
      }
      if (developerSettled.status === "rejected") {
        throw developerSettled.reason;
      }
      const res = developerSettled.value;
      const ok = res.ok && !res.errorStop;
      const completionEvent = await buildCompletionEvent(
        ctx,
        "develop",
        "developer",
        developerLabel,
        res,
      );
      s.branchEvents.push(completionEvent);
      if (ids.length > 1) {
        s.branchEvents.push({
          kind: "branch-completed",
          step: "develop",
          workstreamId: id,
          ok,
          ms: Date.now() - startedAt,
          at: Date.now(),
        });
      }
      s.verdicts.push({ id, ok });
      return { id, ok };
    } catch (err) {
      const errMsg = (err as Error).message?.slice(0, 200);
      s.branchEvents.push({
        kind: "dispatch-failed",
        step: "develop",
        role: "developer",
        jobId: "unknown",
        label: developerLabel,
        ms: Date.now() - startedAt,
        at: Date.now(),
        errorTail: errMsg,
      });
      if (ids.length > 1) {
        s.branchEvents.push({
          kind: "branch-completed",
          step: "develop",
          workstreamId: id,
          ok: false,
          ms: Date.now() - startedAt,
          at: Date.now(),
          error: errMsg,
        });
      }
      s.verdicts.push({ id, ok: false });
      return { id, ok: false };
    }
  };
}

/**
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
  return { ...wtRef, parked: false };
}
