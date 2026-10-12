/**
 * work-driver-adversarial-fix — #1114: the adversarial gate reviews, the
 * develop step fixes.
 *
 * The adversarial step no longer edits anything. Each driver round is one
 * reportOnly review per workstream (adversarial.ts `reportOnly`). A parsed
 * ISSUES_FOUND / CRITICAL_ISSUES_FOUND at a non-terminal round routes that
 * workstream back to develop as a FIX PASS: the findings travel into the
 * developer prompt as data, the pass reuses the workstream's worktree, and
 * every develop gate runs on the result exactly as on a first pass. Then the
 * workstream returns to adversarial for a re-review. Approved workstreams are
 * neither re-developed nor re-reviewed.
 *
 * This module owns the event-log reading (round counts, pending fixes), the
 * per-round interpretation of a reportOnly result, and the fix pass itself.
 * The fence (scope, git reads) lives in work-driver-adversarial-fix-scope.ts.
 * Leaf for the adversarial step: it imports develop's topological core but
 * never the adversarial handlers, so there is no import cycle.
 */

import { type LoopAction, decideLoopAction } from "./adversarial-verdict.ts";
import { MAX_ROUNDS } from "./adversarial.ts";
import { roundComments } from "./comment-evidence.ts";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { runDevelopTopological } from "./work-develop-topological.ts";
import { defaultExec } from "./work-driver-adversarial-fix-git.ts";
import {
  type FixRequest,
  overlayWorkstreams,
  planFixPass,
  postPassFault,
} from "./work-driver-adversarial-fix-scope.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { beginDispatch } from "./work-driver-resume.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import { execp as argvExecp } from "./work-driver-verify.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

export { namedPaths } from "./work-driver-adversarial-fix-scope.ts";

/** Bound on the findings carried in an event / the fix prompt (state-file hygiene). */
export const FIX_FINDINGS_MAX = 4000;

/** A workstream id as the event log keys it (N=1 rounds carry no workstreamId). */
const keyOf = (workstreamId: string | undefined): string => workstreamId ?? "default";

export interface PendingFix {
  workstreamId: string;
  round: number;
  findings: string;
}

/**
 * The one verdict → action mapping for the review track. Both the live
 * interpretation of a reportOnly result and the rebuild of a single-workstream
 * verdict from the log consume it, so the thresholds cannot drift apart.
 */
export function actionFor(
  status: Parameters<typeof decideLoopAction>[0],
  round: number,
): LoopAction {
  return decideLoopAction(status, round, MAX_ROUNDS, true);
}

/**
 * The review track of one workstream, read from the cycle's event log:
 * `rounds` counts PARSED reviews only (an infra-failed round never counts
 * toward the cap). `needsReview` is true before the first parsed review, and
 * after a fix pass has been applied since the last review.
 */
export function reviewTrack(
  eventLog: readonly WorkEvent[],
  workstreamId: string,
): { rounds: number; needsReview: boolean } {
  let rounds = 0;
  let lastRound = -1;
  let lastApplied = -1;
  eventLog.forEach((e, i) => {
    if (e.kind === "adversarial-round" && keyOf(e.workstreamId) === workstreamId) {
      if (e.verdictParsed) {
        rounds++;
        lastRound = i;
      }
    } else if (e.kind === "adversarial-fix-applied" && e.workstreamId === workstreamId) {
      lastApplied = i;
    }
  });
  return { rounds, needsReview: rounds === 0 || lastApplied > lastRound };
}

/**
 * The workstreams this adversarial invocation reviews. A lens-fix re-review
 * reviews everything (the lens-fix changed the diff), and carries the final
 * round so the gate is decided rather than routed back into a fix loop.
 */
export function workstreamsToReview(state: WorkState, ids: readonly string[]): string[] {
  if (state.pipelineState.lastCompletedStep === "lens-fix") return [...ids];
  return ids.filter((id) => reviewTrack(state.eventLog, id).needsReview);
}

/** The round a workstream's next reportOnly review carries. */
export function reviewRoundFor(state: WorkState, workstreamId: string): number {
  if (state.pipelineState.lastCompletedStep === "lens-fix") return MAX_ROUNDS;
  return reviewTrack(state.eventLog, workstreamId).rounds + 1;
}

/** Fix requests not yet followed by an applied fix pass, in log order. */
export function pendingFixes(eventLog: readonly WorkEvent[]): PendingFix[] {
  const pending = new Map<string, PendingFix>();
  for (const e of eventLog) {
    if (e.kind === "adversarial-fix-requested") {
      pending.set(e.workstreamId, {
        workstreamId: e.workstreamId,
        round: e.round,
        findings: e.findings,
      });
    } else if (e.kind === "adversarial-fix-applied") {
      pending.delete(e.workstreamId);
    }
  }
  return [...pending.values()];
}

export interface ReviewReading {
  /** Whether this workstream's review produced a usable outcome (infra and rejections are not). */
  ok: boolean;
  /** The reviewer dispatch died or produced no readable verdict. */
  infra: boolean;
  /** A parsed non-terminal verdict: route this workstream to a fix pass. */
  fixRequested: boolean;
  /** Non-blocking findings this passing review carries forward. */
  passFindings?: string;
}

/**
 * Interpret one reportOnly review. Every review carries its round record
 * (#1114), so a successful dispatch without a parsed verdict is infra, never
 * an approval. The decision is `actionFor`, the same table the log rebuild uses.
 */
export function interpretReview(result: DispatchResult, reviewRound: number): ReviewReading {
  const ok = result.ok && !result.errorStop;
  if (!ok) return { ok: false, infra: false, fixRequested: false };
  const rec = result.adversarialRounds?.[0];
  if (!rec?.verdictParsed) return { ok: false, infra: true, fixRequested: false };
  const action = actionFor(rec.status, reviewRound);
  if (action === "fix") return { ok: true, infra: false, fixRequested: true };
  if (action === "reject") return { ok: false, infra: false, fixRequested: false };
  return {
    ok: true,
    infra: false,
    fixRequested: false,
    passFindings: rec.status === "APPROVED" ? undefined : result.text,
  };
}

/** The fix-requested events for the workstreams a review round routed back. */
export function fixRequestEvents(
  outcomes: ReadonlyArray<{
    id: string;
    fixRequested?: boolean;
    fixFindings?: string;
    records: Array<{ round: number }>;
  }>,
  at: number,
): WorkEvent[] {
  return outcomes
    .filter((o) => o.fixRequested)
    .map((o) => ({
      kind: "adversarial-fix-requested" as const,
      at,
      workstreamId: o.id,
      round: o.records[0]?.round ?? 0,
      findings: (o.fixFindings ?? "").slice(0, FIX_FINDINGS_MAX),
    }));
}

/**
 * Workstreams that keep a FINAL verdict from an earlier invocation: not run
 * again, their outcome re-emitted so the log stays complete. A single-workstream
 * cycle keeps no per-workstream outcome event, so its approval is recovered
 * from the rounds it already ran.
 */
export function survivorsOf(
  state: WorkState,
  ids: readonly string[],
  runSet: readonly string[],
  priorOutcomes: ReadonlyMap<string, string>,
): AdversarialOutcome[] {
  return ids
    .filter((id) => !runSet.includes(id))
    .flatMap((id) => {
      const prev =
        priorOutcomes.get(id) ??
        (ids.length === 1 ? lastReviewVerdict(state.eventLog, id) : undefined);
      if (prev !== "approved" && prev !== "rejected" && prev !== "skipped-empty-diff") return [];
      const findings = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
            e.kind === "adversarial-workstream-outcome" && e.workstreamId === id,
        )?.findings;
      return [
        {
          id,
          ok: prev === "approved" || prev === "skipped-empty-diff",
          rounds: 0,
          records: [],
          infra: false,
          threw: false,
          skipped: prev === "skipped-empty-diff",
          priorInfra: false,
          priorVerdict: prev,
          ...(prev === "approved" && findings ? { passFindings: findings } : {}),
        },
      ];
    });
}

/**
 * The verdict a single-workstream cycle's last parsed review reached. Such a
 * cycle keeps no per-workstream outcome event, so the log is the only record.
 */
function lastReviewVerdict(
  eventLog: readonly WorkEvent[],
  workstreamId: string,
): "approved" | "rejected" | undefined {
  const last = [...eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "adversarial-round" }> =>
        e.kind === "adversarial-round" && e.verdictParsed && keyOf(e.workstreamId) === workstreamId,
    );
  if (!last) return undefined;
  const action = actionFor(last.status, last.round);
  if (action === "pass") return "approved";
  if (action === "reject") return "rejected";
  return undefined;
}

/** Records the handoff report naming the rounds, the reason and the findings. */
function withFixPassReport(
  state: WorkState,
  pending: readonly PendingFix[],
  reason: string,
  now: number,
): WorkState {
  const rounds = pending.map((p) => `${p.workstreamId} round ${p.round}`).join(", ");
  const findings = pending
    .map((p) => p.findings)
    .join("\n---\n")
    .slice(0, FIX_FINDINGS_MAX);
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        {
          step: "develop",
          role: "driver",
          body: `adversarial fix pass (${rounds}) parked: ${reason}. The findings that triggered it:\n${findings}`,
          at: now,
        },
      ],
    },
  };
}

function parkFixPass(
  state: WorkState,
  pending: readonly PendingFix[],
  reason: string,
  now: number,
): WorkState {
  return appendEvent(withFixPassReport(state, pending, reason, now), {
    kind: "cap-hit",
    at: Date.now(),
    cap: "verify-failed:develop",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: `adversarial fix pass: ${reason}`,
  });
}

/**
 * The develop fix pass for the pending workstreams. Reuses their worktrees;
 * named finding paths widen a declared fence for this pass only; all develop
 * gates run unchanged. Parks like a first develop failure: a failed gate or
 * dispatch, a no-op pass, a change outside the fence, or a removed origin/main
 * comment. Every pre-pass read fails closed (see the scope module).
 */
export async function runAdversarialFixPass(
  ctx: DriverContext,
  state: WorkState,
  pending: PendingFix[],
  now: number,
): Promise<WorkState> {
  const ps: PipelineState = state.pipelineState;
  const execFn = ctx.verifyExecFn ?? defaultExec;
  const requests: FixRequest[] = pending.map((p) => ({
    workstreamId: p.workstreamId,
    findings: p.findings,
  }));
  const planned = await planFixPass(execFn, ctx.repoRoot, ps, requests);
  if (!planned.ok) return parkFixPass(state, pending, planned.reason, now);
  const plans = planned.value;
  for (const p of plans) {
    if (p.widened.length > 0)
      trace(`work-driver: fix pass ${p.id} widened by ${p.widened.join(", ")}`);
  }
  const ids = plans.map((p) => p.id);
  const passWorkstreams = overlayWorkstreams(ps.workstreams, plans);

  // The develop step receives the overlay as a parameter; the write-ahead and
  // the persisted pipeline carry the ORIGINAL workstreams.
  const startLen = state.eventLog.length;
  const stepped = appendEvent(
    { ...state, pipelineState: { ...ps, currentStep: "develop" } },
    { kind: "step-started", step: "develop", at: now },
  );
  const begun = await beginDispatch(
    ctx.repoRoot,
    stepped,
    "develop",
    "developer",
    ids.length > 1 ? `developer×${ids.length}` : "developer",
    Date.now(),
  );
  const passed = await runDevelopTopological(
    ctx,
    begun.state,
    ids,
    passWorkstreams,
    activeIssuesOf(state),
    ctx.dispatchFn ?? dispatchCore,
    // Develop's git checks pass argv: the shell-string executor drops it.
    ctx.verifyExecFn ?? argvExecp,
    now,
    begun.jobId,
  );
  const restored: WorkState = {
    ...passed,
    pipelineState: { ...passed.pipelineState, workstreams: ps.workstreams },
  };
  const failed = restored.eventLog
    .slice(startLen)
    .some(
      (e) =>
        e.kind === "cap-hit" ||
        e.kind === "dispatch-failed" ||
        (e.kind === "branch-completed" && !e.ok) ||
        (e.kind === "branches-converged" && e.verdicts.some((v) => !v.ok)),
    );
  // A failed gate that already recorded its own cap routes through that cap.
  // Any other failed tail (a bare branches-converged verdict, say) would fall
  // through nextStep to the linear table, so it parks explicitly here.
  if (failed) {
    const tail = restored.eventLog[restored.eventLog.length - 1];
    if (tail?.kind === "cap-hit")
      return withFixPassReport(restored, pending, "a develop gate failed on the fix pass", now);
    return parkFixPass(restored, pending, "a develop gate failed on the fix pass", now);
  }

  const post = await postPassFault(execFn, plans, ps.baseSha ?? "");
  if (post.reason) return parkFixPass(restored, pending, post.reason, now);
  for (const p of plans) {
    const lost = await roundComments(
      post.diffs[p.id] ?? "",
      undefined,
      p.worktree,
      verifyTimeoutMs(),
      ctx.verifyExecFn,
    );
    // A check that could not run reads NOT CHECKED, never silence (AGENTS.md §7).
    if (!lost.ok) {
      return parkFixPass(
        restored,
        pending,
        `comment retention could not be checked for ${p.id} (NOT CHECKED) — the fix pass is not cleared`,
        now,
      );
    }
    if (lost.lost.length > 0) {
      return parkFixPass(
        restored,
        pending,
        `the fix pass removed ${lost.lost.length} origin/main comment line(s) in ${p.id}`,
        now,
      );
    }
  }
  const applied: WorkEvent[] = pending.map((p) => ({
    kind: "adversarial-fix-applied" as const,
    at: Date.now(),
    workstreamId: p.workstreamId,
    round: p.round,
  }));
  return appendEvent(restored, ...applied);
}
