/**
 * work-develop-run — #679: the per-workstream dispatch closure for runDevelop.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate). Owns the
 * shared dispatch logic for one workstream: memory-brief retrieval, the
 * developer + speculative-explore `Promise.allSettled` race, the completion
 * event, the `branch-completed` event, and the case-1 sibling-injection
 * (informational only — the scope-fanout gate reads `workstream.paths` from
 * state, never the prompt text). The closure captures per-run state via
 * `DevelopRunState` so the caller shares it across both dispatch phases.
 */
import path from "node:path";
import { buildMemoryBrief } from "./memory-brief.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import {
  inlineDevelopPrompt,
  inlineSpeculativeExplorePrompt,
} from "./work-driver-prompts-early.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

import {
  computeSkipCascade,
  createDependentWorktree,
  resolveDependentBase,
} from "./work-driver-dep-scheduler.ts";

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
 * itself skipped. Returns the updated worktrees and workstreamBaseShas.
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
): Promise<{ worktrees: Record<string, string>; workstreamBaseShas: Record<string, string> }> {
  const wtRef = { worktrees, workstreamBaseShas };
  for (const id of ids) {
    const ws = workstreams[id];
    const dependsOn = ws?.dependsOn ?? [];
    const skips = computeSkipCascade([id], dependsOnMap, failedOrSkipped);
    const skipReason = skips.get(id);
    if (skipReason) {
      trace(`work-driver: skipping dependent workstream ${id} — ${skipReason}`);
      failedOrSkipped.add(id);
      verdicts.push({ id, ok: false });
      if (allIds.length > 1) {
        branchEvents.push({
          kind: "branch-completed",
          step: "develop",
          workstreamId: id,
          ok: false,
          ms: 0,
          at: Date.now(),
          error: skipReason,
        });
      }
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
      verdicts.push({ id, ok: false });
      if (allIds.length > 1) {
        branchEvents.push({
          kind: "branch-completed",
          step: "develop",
          workstreamId: id,
          ok: false,
          ms: 0,
          at: Date.now(),
          error: depResult.skipReason ?? "could not resolve dependency's post-commit SHA",
        });
      }
      continue;
    }
    const createdPath = await createDependentWorktree(
      execFn,
      ctx.repoRoot,
      ctx.issue,
      id,
      depResult.fromRef,
    );
    if (!createdPath) {
      failedOrSkipped.add(id);
      verdicts.push({ id, ok: false });
      if (allIds.length > 1) {
        branchEvents.push({
          kind: "branch-completed",
          step: "develop",
          workstreamId: id,
          ok: false,
          ms: 0,
          at: Date.now(),
          error: `deferred worktree creation failed for ${id}`,
        });
      }
      continue;
    }
    wtRef.worktrees = { ...wtRef.worktrees, [id]: createdPath };
    const depBaseSha = depResult.baseSha ?? depResult.fromRef;
    if (depBaseSha) wtRef.workstreamBaseShas = { ...wtRef.workstreamBaseShas, [id]: depBaseSha };
    await runOneWorkstream(id, createdPath);
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
  return wtRef;
}
