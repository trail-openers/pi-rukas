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
import {
  recordAcceptanceCoverage,
  runAcceptanceCoverageGate,
} from "./work-driver-acceptance-coverage.ts";
import { raiseConsolidationIncompleteCap } from "./work-driver-commit-completeness.ts";
import type { CommitPrRootInspect } from "./work-driver-commit-inspect.ts";
import { inspectCommitPrRoot } from "./work-driver-commit-inspect.ts";
import { commitPrRootFieldsOf } from "./work-driver-commit-inspect.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { recordFallbackDraftFact } from "./work-driver-draft-pr.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import type { IntegrateResult } from "./work-driver-integrate.ts";
import { parsePrNumber } from "./work-driver-merged.ts";
import { verifyConsolidation, verifyStepOutcome } from "./work-driver-verify.ts";
import { makeConsolidatedVerifySkippedEvent } from "./workflow-state-events-verify-flake.ts";
import type { ConsolidationVerdict } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

/** The successful, non-empty IntegrateResult — the only shape this function handles. */
type NonEmptyIntegrateResult = Extract<IntegrateResult, { ok: true; empty: false }>;

/** How many consolidation notes the state file keeps (#1153 round 3; newest win). */
const MAX_PERSISTED_NOTES = 20;

/**
 * The prior notes as a usable string list: a well-formed array, or `undefined`
 * for anything else. A legacy non-array on the field is not merged (there is
 * nothing to merge out of it) and is dropped by the bound below — it would
 * otherwise be spread into a list the renderer assumes is strings.
 */
function toNotes(prior: string[] | undefined): string[] | undefined {
  return Array.isArray(prior) ? prior : undefined;
}

/**
 * The post-dispatch gate sequence for an LLM-ops commit-pr fallback.
 * Extracted from work-driver-commit.ts to keep that file under the
 * AGENTS.md §12 500-line cap (#818).
 *
 * Records the root state, parses the PR number, runs the consolidation
 * completeness gate, and the outcome verification gate. Returns the
 * updated WorkState.
 *
 * Both commit-pr paths reach it: the LLM-ops fallback via `runCommitPrLocked`
 * and the mechanized path via `auditCommitPrFallback`'s no-fallback branch
 * (`work-driver-commit-pr-audit.ts`), so the consolidation notes below are
 * persisted for a mechanized commit-pr too.
 */
export async function runCommitPrPostDispatchGates(
  ctx: CycleContext,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  next: WorkState,
): Promise<WorkState> {
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const rootState = await inspectCommitPrRoot(execFn, ctx.repoRoot);
  let state: WorkState = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      ...commitPrRootFieldsOf(rootState),
    },
  };
  const prNumber = parsePrNumber(last.summary);
  if (prNumber !== undefined) {
    state = { ...state, pipelineState: { ...state.pipelineState, prNumber } };
    // #1292 — the draft fact, once the number is known: what the forge says.
    state = await recordFallbackDraftFact(ctx, state, prNumber, execFn);
  }
  if (state.pipelineState.consolidationCompleteness?.droppedPaths.length) {
    return raiseConsolidationIncompleteCap(state);
  }
  const consolidationCheck = await verifyConsolidation(ctx, state);
  for (const note of consolidationCheck.notes) trace(`work-driver: ${note}`);
  // #1153 — notes are the record of checks that DID NOT RUN, so they persist
  // on pipelineState for the handoff renderer. A clean run (the check ran and
  // produced no notes) CLEARS any stale notes: without this, notes from an
  // earlier commit-pr attempt survive into a cycle whose consolidation is
  // genuinely clean, and the handoff tells the operator a check was skipped
  // that in fact ran.
  //
  // The predicate is `priorNotes !== undefined`, not `priorNotes?.length`: a
  // state file written before the validator guarded this field can carry a
  // non-array (the validator reports it, and a resumed cycle still runs this
  // gate). `?.length` is falsy for `"a note"`, which would leave that value on
  // the field of a cycle the gate just called clean — the exact stale-note
  // shape the clear exists to remove. Anything present, of any shape, goes.
  //
  // The key is DELETED, not assigned `undefined`: the state's real life is
  // JSON on disk. An assigned-undefined key drops out of `JSON.stringify` so
  // the round trip happens to agree, but in memory the object still reports
  // `"consolidationNotes" in pipelineState`, which is what the tolerant readers
  // and the validator's presence check look at. Deleting is the honest shape.
  const priorNotes = state.pipelineState.consolidationNotes;
  if (consolidationCheck.notes.length > 0) {
    // #1153 round 3 — the PERSISTED list is bounded too, not just the rendered
    // one (`MAX_RENDERED_NOTES` in the handoff markdown). A cycle that re-enters
    // commit-pr with a broken git state appends a fresh note each time, and the
    // state file has no other bound. Newest 20 is kept: the newest notes
    // describe the state the operator is being handed off on, and the render
    // bound keeps the oldest of those visible in the comment.
    const merged = [...new Set([...(toNotes(priorNotes) ?? []), ...consolidationCheck.notes])];
    state = {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        consolidationNotes: merged.slice(-MAX_PERSISTED_NOTES),
      },
    };
  } else if (priorNotes !== undefined) {
    const { consolidationNotes: _cleared, ...rest } = state.pipelineState;
    state = { ...state, pipelineState: rest };
  }
  if (consolidationCheck.missing.length > 0) {
    trace(
      `work-driver: commit-pr partial-consolidation detected — missing workstreams: ${consolidationCheck.missing.map((m) => m.id).join(", ")}`,
    );
    // #875 — compute the per-workstream `dirty` flag ONCE at gate time
    // (worktree porcelain: modified + untracked, same `--untracked-files=all`
    // as work-driver-verify.ts — bare `--porcelain` collapses a wholly-
    // untracked directory to one `?? dir/` line) and persist it on each
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
              const { stdout } = await execFn("git status --porcelain --untracked-files=all", {
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
        incompleteConsolidation: {
          verdicts,
          filesPresent: consolidationCheck.filesPresent,
        },
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
          origin: "outcome-gate",
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
    return state;
  }
  // #1137 — the whole-issue acceptance-coverage check, ONCE on the
  // consolidated diff (never per workstream — the per-workstream review is
  // scoped to its own paths by the adversarial prompt). A criterion no
  // workstream delivered is flagged here, after the PR is open, so the
  // operator sees exactly what was not delivered. The gate degrades to a
  // skip (scope unknown) when it cannot read the diff or no criteria are
  // recorded — it never fails on whole-issue criteria it could not judge.
  const coverage = await runAcceptanceCoverageGate(ctx, state);
  return coverage ? recordAcceptanceCoverage(state, coverage) : state;
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
  /** A second round: the commits were pushed onto a PR that was already open. */
  prAlreadyOpen = false,
): WorkState {
  let next = appendEvent(
    {
      ...state,
      pipelineState: { ...state.pipelineState, currentStep: "commit-pr" },
    },
    { kind: "step-started", step: "commit-pr", at: now },
  );
  // #1240 — the commit-pr consolidated verify skipped its run because the
  // committed integration tree is the tree develop already judged. Emitted
  // alongside (not instead of) the flake marker: they describe different
  // facts, and the skip's absence is the only evidence a run happened.
  if (res.verifySkipped !== undefined) {
    next = appendEvent(
      next,
      makeConsolidatedVerifySkippedEvent("commit-pr", res.verifySkipped, ids.length),
    );
  }
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
  // #1404 — the gate was red and the cycle pushed: every failing test is red
  // at the cycle's base commit too. Recorded as a plumbing report, not an
  // event: `plumbReportSection` already renders that field in the handoff, and
  // appending to the event log here would move the tail `nextStep()` routes on.
  // The followup path (a PR already open) builds NO body at all, so on that
  // exit this record is the only place the pre-existing names survive.
  if (
    res.preExistingOnly === true &&
    res.preExistingFailures &&
    res.preExistingFailures.length > 0
  ) {
    const body = `commit-pr consolidated verify failed on ${res.preExistingFailures.length} test(s) that also fail at the cycle's base commit, so the push proceeded: ${res.preExistingFailures.join(", ")}. These are gate failures owned by the base commit, not by this change — fix the gate at the base (or the host it runs on) or the next cycle parks here too.`;
    const prior = next.pipelineState.plumbReports ?? [];
    if (!prior.some((r) => r.body === body)) {
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          plumbReports: [...prior, { step: "commit-pr", role: "driver", body, at: Date.now() }],
        },
      };
    }
  }
  // Via the shared builder (work-driver-events.ts): unique jobId — the old
  // inline literal "mechanized" appeared twice per fan-out cycle, making
  // jobId useless as a correlation key (census 2026-09-09).
  // #1240 — the skip is named in the summary as well as in the event: the
  // step's operator-facing line is the thing a reader scans when a commit-pr
  // came back fast, and "it was quick, or it skipped" must have one answer.
  const skipNote =
    res.verifySkipped === undefined
      ? ""
      : `\nconsolidated verify skipped: tree ${res.verifySkipped.treeHash} already passed in ${res.verifySkipped.worktree}`;
  next = appendEvent(
    next,
    synthesizeDriverCompletion({
      step: "commit-pr",
      label: "driver:commit-pr",
      summary: `Mechanized commit-pr: consolidated ${ids.length} worktree(s), committed, pushed ${branchName}, ${prAlreadyOpen ? `updated open PR #${prNumber}` : "opened PR"}.${skipNote}\npr: ${prNumber}`,
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
