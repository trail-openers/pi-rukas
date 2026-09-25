/**
 * work-develop-run — #679: the per-workstream dispatch closure for runDevelop.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate). Owns the
 * shared dispatch logic for one workstream (memory-brief retrieval, the
 * developer + speculative-explore `Promise.allSettled` race, the completion
 * and `branch-completed` events, the case-1 sibling-injection) and
 * `runDependentWorkstreams` (the dependent-workstream phase: skip cascade,
 * deferred worktree creation from the dependency's post-commit SHA, base
 * resolution) — which since #799 lives in work-develop-dependent.ts (moved
 * VERBATIM for the 500-line gate headroom; the pointer below re-exports it,
 * and `parkDeferredLeftover` stays in this file). The closure captures per-run
 * state via `DevelopRunState` so the caller shares it across both dispatch
 * phases.
 *
 * `runDevelopTopological` — the #679 topological-dispatch core (independent
 * fan-out, failed/skipped detection, the safety net + verify gate) — lives
 * in work-develop-topological.ts.
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
import { clearDispatch } from "./work-driver-resume.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { scratchDir } from "./work-driver-workspace.ts";
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
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>;
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

/** #799 — the dependent phase moved to work-develop-dependent.ts (verbatim,
 * for 500-line headroom); re-exported so existing imports keep their path. */
export { runDependentWorkstreams } from "./work-develop-dependent.ts";
