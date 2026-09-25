/**
 * work-driver-commit-pr-events — the event sequence for a successful
 * mechanized commit-pr. Extracted from work-driver-commit.ts to keep
 * that file under the AGENTS.md §12 500-line cap (the #782 flake-recovery
 * event added ~20 lines to the event block).
 *
 * The caller (mechanizedCommitPr) passes the already-PR-created state; this
 * builder appends the event sequence (flake-recovery, step-started,
 * driver-completion) and persists the commitPrRoot / commitShas /
 * consolidationCompleteness fields.
 */

import { trace } from "./trace.ts";
import { raiseConsolidationIncompleteCap } from "./work-driver-commit-completeness.ts";
import type { CommitPrRootInspect } from "./work-driver-commit-inspect.ts";
import { inspectCommitPrRoot } from "./work-driver-commit-inspect.ts";
import { commitPrRootFieldsOf } from "./work-driver-commit-inspect.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import type { IntegrateResult } from "./work-driver-integrate.ts";
import { parsePrNumber } from "./work-driver-merged.ts";
import { verifyConsolidation, verifyStepOutcome } from "./work-driver-verify.ts";
import type { ConsolidationVerdict } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

/** The successful, non-empty IntegrateResult — the only shape this function handles. */
type NonEmptyIntegrateResult = Extract<IntegrateResult, { ok: true; empty: false }>;

/**
 * The post-dispatch gate sequence for an LLM-ops commit-pr fallback.
 * Extracted from work-driver-commit.ts to keep that file under the
 * AGENTS.md §12 500-line cap (#818).
 *
 * Records the root state, parses the PR number, runs the consolidation
 * completeness gate, and the outcome verification gate. Returns the
 * updated WorkState.
 */
export async function runCommitPrPostDispatchGates(
  ctx: DriverContext,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  next: WorkState,
): Promise<WorkState> {
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const rootState = await inspectCommitPrRoot(execFn, ctx.repoRoot);
  let state: WorkState = {
    ...next,
    pipelineState: { ...next.pipelineState, ...commitPrRootFieldsOf(rootState) },
  };
  const prNumber = parsePrNumber(last.summary);
  if (prNumber !== undefined) {
    state = { ...state, pipelineState: { ...state.pipelineState, prNumber } };
  }
  if (state.pipelineState.consolidationCompleteness?.droppedPaths.length) {
    return raiseConsolidationIncompleteCap(state);
  }
  const consolidationCheck = await verifyConsolidation(ctx, state);
  if (consolidationCheck.missing.length > 0) {
    trace(
      `work-driver: commit-pr partial-consolidation detected — missing workstreams: ${consolidationCheck.missing.map((m) => m.id).join(", ")}`,
    );
    // #875 — compute the per-workstream `dirty` flag ONCE at gate time
    // (worktree porcelain: modified + untracked) and persist it on each
    // uncovered verdict. The handoff renderers read ONLY the persisted
    // flag — no live git call at render time. An unreadable worktree
    // cannot prove anything, so it is recorded dirty (the conservative
    // side — the worktree may indeed hold uncommitted work).
    const ps = state.pipelineState;
    const worktrees = ps.worktrees ?? {};
    let dirtyCache: Record<string, boolean> | null = null;
    const dirtyOf = async (id: string): Promise<boolean> => {
      if (dirtyCache === null) {
        const cache: Record<string, boolean> = {};
        for (const mid of consolidationCheck.missing.map((m) => m.id)) {
          const wt = worktrees[mid];
          let porcelain: string | undefined;
          if (wt) {
            try {
              const { stdout } = await execFn("git status --porcelain", {
                cwd: wt,
                maxBuffer: 1024 * 1024,
              });
              porcelain = stdout;
            } catch {
              porcelain = undefined;
            }
          }
          cache[mid] = porcelain === undefined ? true : porcelain.trim().length > 0;
        }
        dirtyCache = cache;
      }
      return dirtyCache[id] ?? true;
    };
    const verdicts: ConsolidationVerdict[] = [];
    for (const v of consolidationCheck.verdicts) {
      if (v.status !== "uncovered") {
        verdicts.push(v);
        continue;
      }
      verdicts.push({ ...v, dirty: await dirtyOf(v.id) });
    }
    state = {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        incompleteConsolidation: { verdicts, filesPresent: consolidationCheck.filesPresent },
      },
    };
    return appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "commit-pr-incomplete-consolidation",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  const gate = await verifyStepOutcome(ctx, state, "commit-pr");
  if (gate.adoptedPrNumber !== undefined) {
    state = {
      ...state,
      pipelineState: { ...state.pipelineState, prNumber: gate.adoptedPrNumber },
    };
  }
  if (!gate.ok) {
    trace(`work-driver: verify-failed:commit-pr — ${gate.failures.join(" | ")}`);
    const commitPrFlake = state.eventLog.some((e) => e.kind === "verify-flake-recovered");
    state = {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        verifyEvidence: {
          step: "commit-pr",
          failures: gate.failures,
          at: Date.now(),
          ...(commitPrFlake ? { retries: 1, recovered: false } : {}),
        },
      },
    };
    state = appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "verify-failed:commit-pr",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  return state;
}

/**
 * Append the event sequence for a successful mechanized commit-pr and
 * persist the pipelineState fields. Returns the updated WorkState.
 *
 * #782 — the flake-recovery event (verify-flake-recovered, step: "commit-pr")
 * is prepended to the sequence when `commitPrFlakeEvidence` is set (the
 * consolidated verify's single bounded re-run recovered from a flake).
 */
export function finalizeCommitPrState(
  state: WorkState,
  now: number,
  startedAt: number,
  ids: string[],
  branchName: string,
  prNumber: number,
  res: NonEmptyIntegrateResult,
  rootState: CommitPrRootInspect,
  commitPrFlakeEvidence: string | undefined,
): WorkState {
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "commit-pr" } },
    { kind: "step-started", step: "commit-pr", at: now },
  );
  // #782 — the commit-pr consolidated verify recovered from a flake: emit
  // the audit trail BEFORE the dispatch-completion event so the ordering
  // in the event log matches the temporal order.
  if (commitPrFlakeEvidence !== undefined) {
    next = appendEvent(next, {
      kind: "verify-flake-recovered",
      at: Date.now(),
      step: "commit-pr",
      evidenceTail: commitPrFlakeEvidence,
    });
  }
  // Via the shared builder (work-driver-events.ts): unique jobId — the old
  // inline literal "mechanized" appeared twice per fan-out cycle, making
  // jobId useless as a correlation key (census 2026-09-09).
  next = appendEvent(
    next,
    synthesizeDriverCompletion({
      step: "commit-pr",
      label: "driver:commit-pr",
      summary: `Mechanized commit-pr: consolidated ${ids.length} worktree(s), committed, pushed ${branchName}, opened PR.\npr: ${prNumber}`,
      startedAt,
      now: Date.now(),
    }),
  );
  // #453 — persist cherry-picked commit SHAs so resume can skip them.
  const commitShas = res.commitShas;
  // #728 — also persist the intended-vs-actual completeness diagnostic when
  // the cherry-pick path produced one (see work-driver-commit-completeness.ts).
  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      ...(rootState.ok
        ? { commitPrRoot: rootState.state, commitPrRootError: undefined }
        : { commitPrRoot: undefined, commitPrRootError: rootState.error }),
      ...(commitShas ? { commitShas } : {}),
      ...(res.completeness ? { consolidationCompleteness: res.completeness } : {}),
    },
  };
}
