/**
 * work-develop-run — #679: the per-workstream dispatch closure for runDevelop.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate). Owns the
 * shared dispatch logic for one workstream (memory-brief retrieval, the
 * developer + speculative-explore race, the completion and `branch-completed`
 * events, the case-1 sibling-injection) and
 * `runDependentWorkstreams` (the dependent-workstream phase: skip cascade,
 * deferred worktree creation from the dependency's post-commit SHA, base
 * resolution) — since #799 in work-develop-dependent.ts (moved VERBATIM for the
 * 500-line gate headroom; the pointer below re-exports it, and
 * `parkDeferredLeftover` stays here). The closure captures per-run state via
 * `DevelopRunState` so the caller shares it across both dispatch phases.
 *
 * `runDevelopTopological` (#679: the topological-dispatch core — independent
 * fan-out, failed/skipped detection, the safety net + verify gate) lives in
 * work-develop-topological.ts.
 */ import fs from "node:fs";
import path from "node:path";
import { buildMemoryBrief } from "./memory-brief.ts";
import { developChildBoundMs } from "./spawn-child-bound.ts";
import { trace } from "./trace.ts";
import {
  type CrashVerdict,
  type DevelopPassResult,
  classifyDevelopPass,
  crashedBranchCompleted,
} from "./work-develop-crash.ts";
import type { WorkstreamVerdict } from "./work-develop-verdict-source.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { continuePrNote } from "./work-driver-continue-pr-guard.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import {
  developFixPassFits,
  reviewFixDispatchBoundMs,
  reviewLoopActive,
  traceFixPassBoundKill,
} from "./work-driver-lens-fix-budget.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import {
  inlineDevelopPrompt,
  inlineSpeculativeExplorePrompt,
} from "./work-driver-prompts-early.ts";
import { clearDispatch } from "./work-driver-resume.ts";
import { interruptedDevelopNote } from "./work-driver-retry-context.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { fastVerifyCmdFor } from "./work-driver-verify-fast.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/** Per-run mutable state shared by both dispatch phases. */
export interface DevelopRunState {
  ctx: CycleContext;
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
        /** #1114 — the adversarial findings a fix pass resolves (absent on a first pass). */
        fixFindings?: string;
      }
    | undefined
  >;
  /** All workstream ids (independent + dependent). */
  ids: string[];
  /** #1742/#1644 — the shared budget-park marker. A review-loop fix pass
   *  whose remaining budget cannot fit `MIN_USEFUL_MS.develop` marks this
   *  INSTEAD of dispatching (zero dispatches), and the topological caller
   *  short-circuits the safety-net/verify gates on it — the same shape the
   *  deferred-leftover park uses: flush the sibling events, then land the
   *  `lens-review-timeout` cap-hit as the TAIL the step router reads. #1774:
   *  REQUIRED — the mark and the caller's short-circuit are one mechanism. */
  budgetPark: { at?: number };
  /** The dispatch function (ctx.dispatchFn ?? dispatchCore). */
  dispatch: NonNullable<DriverContext["dispatchFn"]>;
  /** #838 — the deck tag for this workstream's dispatch rows (the
   *  workstream id when N>1, "default" for the single-workstream shape);
   *  the deck option itself is composed inside the closure from the cycle
   *  key + step. */
  deckTagFor: (id: string) => string;
  /** #1403 — the executor the crash classification reads each worktree with
   *  (the step's own `verifyExecFn`, so the fan-out and its gates describe the
   *  same tree). */
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  /** #1403 — resolves the base a workstream's worktree is described against:
   *  its own entry in `workstreamBaseShas`, else the cycle's global base. The
   *  ONE base resolution the step has (the classify path calls it at classify
   *  time, so a dependent classified after its own entry landed is described
   *  against ITS base, not the global one). */
  baseFor: (id: string) => string | undefined;
  /** #1403 — the classify seam: the topological step supplies the one shared
   *  across both dispatch phases (its base resolution + executor); a test
   *  injects a fake tree. Absent → the closure calls `classifyDevelopPass`
   *  itself with `baseFor` and `execFn`. */
  classifyPass?: (args: {
    id: string;
    cwd: string;
    base: string | undefined;
    execFn: NonNullable<DriverContext["verifyExecFn"]>;
    result: DevelopPassResult;
  }) => Promise<CrashVerdict>;
  /** Per-branch verdicts accumulated across both phases. */
  verdicts: WorkstreamVerdict[];
  /** Per-branch events (completion, speculative, branch-completed, dispatch-failed). */
  branchEvents: WorkEvent[];
  /** #1016 — persists a `branch-completed` as its workstream finishes (the
   *  crash-resume record). */
  emitBranchCompleted: (ev: WorkEvent) => void;
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
  /** #1016 — dependents whose green survived a crash: kept, never re-dispatched. */
  kept?: ReadonlySet<string>;
  /** #1016 — dependents whose unsaved work blocks their dispatch (id → reason). */
  refused?: Record<string, string>;
  /** #1016 — persists a dependent's branch-completed (incl. the kept re-record). */
  emitBranchCompleted?: (ev: WorkEvent) => void;
  /** #1016 — persists a non-event state change (dependent worktree paths). */
  updateState?: (fn: (s: WorkState) => WorkState) => void;
  /** #1016 — waits for every queued state write before a direct write. */
  flushState?: () => Promise<void>;
  /** #1403 — the executor the dependent phase's classification reads with (the
   *  same one the independent fan-out uses). */
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  /** #1403 — resolves each workstream's effective base (see
   *  `DevelopRunState.baseFor`): the shared map plus the global fallback. */
  baseFor: (id: string) => string | undefined;
  /** #1016 — the one-shot retry reset for a failed dependent. */
  resetFor?: (
    id: string,
    cwd: string,
    base: string | undefined,
  ) => Promise<{ attempt: number; patch?: string }>;
  /** #1016 — driver notes (saved patches), surfaced in the handoff. */
  notes?: string[];
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

/** The develop note: continue-PR (#1468) then the interrupted-attempt note. */
export function developNote(state: WorkState): string | undefined {
  const cp = state.pipelineState.continuedPr;
  const parts = [cp && continuePrNote(cp), interruptedDevelopNote(state)].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Create the per-workstream dispatch closure (captures `stateRef` for memory-inject events). */
export function makeRunOneWorkstream(
  s: DevelopRunState,
): (id: string, cwd: string) => Promise<WorkstreamVerdict> {
  return async (id: string, cwd: string) => {
    const { ctx, activeIssues, scratchAbs, workstreams, ids, dispatch, deckTagFor } = s;
    // The speculative-explore knob is a global env var, not per-run state,
    // so the closure reads it directly (the caller does not thread it).
    const speculativeOn = process.env.PI_ENSEMBLE_SPECULATIVE_EXPLORE === "1";
    const ws = workstreams[id];
    const startedAt = Date.now();
    const developerLabel = ids.length > 1 ? `developer[${id}]` : "developer";
    // #1416 — a develop dispatch that IS a review fix pass (the adversarial
    // gate threads `fixFindings` for a rejected workstream, or the lens loop
    // re-reviews after a lens-fix) runs under the same 90-minute review-loop
    // budget the widget prints. A fix pass is the other half of the fix loop;
    // leaving it unbounded is the bug the lens-fix dispatch had.
    const isReviewFixPass =
      Boolean(ws?.fixFindings) &&
      (s.stateRef.current.pipelineState.lastCompletedStep === "lens-fix" ||
        reviewLoopActive(s.stateRef.current));
    const reviewFixBoundMs = isReviewFixPass
      ? reviewFixDispatchBoundMs(s.stateRef.current, "lens-fix", startedAt)
      : undefined;
    // #1644 — the fix pass was BOUND but never PARKED: with the budget spent
    // it dispatched anyway under the 60-second floor and was killed to produce
    // nothing. Refuse it the way the lens-fix refuses itself: zero dispatches,
    // and the cap (named for this refused step) lands at the event tail via
    // the topological caller's short-circuit.
    if (isReviewFixPass && !developFixPassFits(s.stateRef.current, startedAt)) {
      s.budgetPark.at = startedAt;
      const reason =
        "lens-review-timeout: the review-loop budget cannot fit the develop fix pass — not dispatched";
      // #1774 — `noRetry`: a clock reading, not transient — settled, not retried.
      s.verdicts.push({ id, ok: false, reason, noRetry: true });
      // #1742 (MINOR 2) — the refusal is recorded like every other develop
      // failure (#753: "record for EVERY plan size — the N>1 guard made a
      // single-workstream failure completely silent"). The step short-circuits
      // before the verify gates, so this is the only thing the state file will
      // ever say about this workstream; its dependents' skip events join it in
      // the same flush the deferred-leftover park uses.
      s.branchEvents.push({
        kind: "branch-completed",
        step: "develop",
        workstreamId: id,
        ok: false,
        ms: 0,
        at: startedAt,
        error: reason,
      } satisfies Extract<WorkEvent, { kind: "branch-completed" }>);
      return { id, ok: false, reason, noRetry: true };
    }
    const speculativeContextPath = path.join(scratchAbs, `speculative-${id}.md`);
    // #679 case 1 — sibling workstreams for the informational injection.
    // Gated on N>1 and workstreamId !== "default" (the existing `parallel`
    // framing gate). The N=1 default path passes nothing → byte-identical.
    // This is INFORMATIONAL ONLY — the scope-fanout gate in
    // work-driver-verify-develop.ts reads `workstream.paths` from state,
    // never the prompt text.
    // #1016 — per-completion persistence: every develop caller supplies emitBranchCompleted.
    const emitCompleted = (ev: WorkEvent): void => s.emitBranchCompleted(ev);
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
      const fastVerifyCmd = await fastVerifyCmdFor(ctx.repoRoot); // #1324
      s.stateRef.current = appendEvent(s.stateRef.current, {
        kind: "memory-inject",
        at: Date.now(),
        step: "develop",
        queries: brief.queries,
        hits: brief.hits.length,
        emptyBrief: brief.emptyBrief,
        ids: brief.hits.map((h: { id: string }) => h.id),
      });

      // #1078: siblings are written as issue-body-<N>.txt in the primary's dir by the
      // explore writer (work-driver-explore-run.ts) but not tracked in state — derive
      // and existence-check each (may be gone by develop time; falls back to re-fetch).
      // The bare legacy issue-body.txt is never written in multi-issue mode.
      const artifact = s.stateRef.current.pipelineState.issueBodyArtifact;
      const artifactPaths: string[] = [];
      if (artifact) {
        const candidates = [artifact];
        if (activeIssues.length > 1) {
          // The explore writer names every active issue `issue-body-<N>.txt`
          // in the primary's dir; the primary's state-tracked file may still
          // carry the legacy bare name (single-issue cycles, resumed state),
          // so `artifact` itself is the primary's candidate — skip it here
          // instead of deriving a phantom `issue-body-<primary>.txt`.
          for (const n of activeIssues) {
            if (n === ctx.issue) continue;
            candidates.push(path.join(path.dirname(artifact), `issue-body-${n}.txt`));
          }
        }
        // fs.existsSync returns false (never throws) on any stat failure, so
        // a path that is gone or unreadable simply degrades to the re-fetch
        // line for that issue.
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) artifactPaths.push(candidate);
        }
      }
      if (artifact && artifactPaths.length === 0) {
        trace(
          `work-driver: issue body artifact missing at develop time, falling back to re-fetch: ${artifact}`,
        );
      }
      // An empty array (artifact tracked but all files gone) is a meaningful
      // "checked, none present" state; the prompt guard treats it as absent
      // and falls back to the re-fetch line.
      const issueBodyArtifactPaths = artifactPaths;
      const [developerSettled, speculativeSettled] = await Promise.allSettled([
        dispatch(
          ctx.host,
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
              issueBodyArtifactPaths,
              ws?.fixFindings,
              developNote(s.stateRef.current),
              fastVerifyCmd,
              // #1676 — the protected paths the plan persisted, annotated beside the fence.
              {
                deferredProtected: s.stateRef.current.pipelineState.deferredProtected ?? [],
              },
            ),
            cwd,
          },
          {
            label: developerLabel,
            ...(reviewFixBoundMs !== undefined ? { timeoutMs: reviewFixBoundMs } : {}),
            // #1560 — the per-child run bound (policy: develop 90 min).
            childBoundMs: developChildBoundMs(),
            // #838 — the developer row's deck entry (row label `#<issue>
            // develop · <workstream>` — display only; the job label above is
            // what the cap checkpoint's `developer[<id>]` parse sees).
            deck: {
              ...driverDeckOpts(ctx.issue, "develop", deckTagFor(id)),
              label: developerLabel,
            },
            // #1655 — the developer writes only inside its worktree; the scratch
            // dir is its other allowed home. The speculative explore is read-only.
            writeFence: { root: cwd, repo: ctx.repoRoot, scratch: scratchAbs },
          },
        ),
        speculativeOn
          ? dispatch(
              ctx.host,
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
                deck: {
                  ...driverDeckOpts(ctx.issue, "develop", deckTagFor(`${id}:speculative`)),
                  label: ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative",
                },
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
      traceFixPassBoundKill(isReviewFixPass, res.killCause, reviewFixBoundMs);
      const completionEvent = await buildCompletionEvent(
        ctx,
        "develop",
        "developer",
        developerLabel,
        res,
      );
      s.branchEvents.push(completionEvent);
      // #1403 — the pass is classified against the WORKTREE, not only against
      // the child's own claim. Pre-fix this was `res.ok && !res.errorStop`, so
      // a child whose engine printed `the engine stopped unexpectedly (exit
      // code 1)` and exited non-zero fell onto the ordinary failure path with
      // a reason drawn from the completion event's tail — nothing said it had
      // crashed, and nothing named the work it left uncommitted.
      const verdict = await (s.classifyPass ?? classifyDevelopPass)({
        id,
        cwd,
        base: s.baseFor(id),
        execFn: s.execFn,
        result: res,
      });
      const ok = verdict.ok;
      // A crash gets its own structured branch-completed record whether or not
      // the fan-out is multi-workstream: the crash is the finding, and for
      // N=1 (every real cycle measured on this host) suppressing the event by
      // `ids.length > 1` is what made it invisible to every later reader.
      if (verdict.crashed) {
        emitCompleted(crashedBranchCompleted({ id, ms: Date.now() - startedAt, verdict }));
      } else if (ids.length > 1) {
        emitCompleted({
          kind: "branch-completed",
          step: "develop",
          workstreamId: id,
          ok,
          ms: Date.now() - startedAt,
          at: Date.now(),
        });
      }
      // #1016 — a first-pass failure carries its reason into the verdicts.
      const tail = "errorTail" in completionEvent ? completionEvent.errorTail : undefined;
      const reason = ok ? undefined : (verdict.reason ?? tail ?? "developer did not complete ok");
      s.verdicts.push(ok ? { id, ok } : { id, ok, reason });
      return ok ? { id, ok } : { id, ok, reason };
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
        emitCompleted({
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
