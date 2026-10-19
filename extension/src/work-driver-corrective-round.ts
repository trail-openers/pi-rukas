/**
 * work-driver-corrective-round — #1667: the develop step's ONE corrective round.
 *
 * When the develop verify fails on specific, attributed assertion lines
 * (work-driver-corrective-decide.ts decides that), each failing workstream's
 * developer is dispatched in its OWN worktree with only its own lines, and the
 * whole develop verdict is taken again: the full outcome gate
 * (`verifyStepOutcome`: scope fence, fanout, protected paths, out-of-scope
 * paths, verify) runs on the corrected tree, not only the verify command.
 *
 * Order is load-bearing, and each rule has a test:
 *   - the `corrective-round` events are persisted BEFORE any developer starts,
 *     so a resumed cycle counts the round from the log (no second round);
 *   - every corrective developer runs to completion; one failure or timeout
 *     parks at verify-failed:develop with no re-verify;
 *   - a second failing verify parks exactly as a first one does today.
 *
 * Reuses the fix-pass shape (work-driver-adversarial-fix.ts): same worktrees,
 * same dispatch bound, same gates, findings in the prompt. It does NOT go
 * through runDevelopTopological, whose gate would run inside the round and
 * re-enter this trigger.
 */

import { recordCommentEvidence } from "./comment-evidence.ts";
import { developChildBoundMs } from "./spawn-child-bound.ts";
import { trace } from "./trace.ts";
import { classifyDevelopPass, crashedBranchCompleted } from "./work-develop-crash.ts";
import { runSymbolMergeRetry } from "./work-develop-symbol-merge.ts";
import { appendDevelopVerifyFailure } from "./work-develop-verify-failure.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { type CorrectiveDecision, decideCorrectiveRound } from "./work-driver-corrective-decide.ts";
import { correctiveDevelopPrompt } from "./work-driver-corrective-prompt.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { recordDevelopGateEvents } from "./work-driver-verify-events.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { type WorkEvent, type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

type DevelopGate = Awaited<ReturnType<typeof verifyStepOutcome>>;
type Dispatch = NonNullable<DriverContext["dispatchFn"]>;
type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;
type RoundDecision = Extract<CorrectiveDecision, { round: true }>;

/** Longest failure text a parked corrective round carries into the verify evidence. */
const ROUND_FAILURE_MAX = 600;

/**
 * What a failed develop verify does, in order: the #1323 sibling-symbol merge
 * (unchanged, first), then the one corrective round when the decision earns it,
 * then the verdict. The re-verify after a round is the second and last verify;
 * its failure parks exactly as the first one did.
 */
export async function onDevelopVerifyFailed(a: {
  ctx: CycleContext;
  state: WorkState;
  stateRef: { current: WorkState };
  ids: string[];
  workstreams: NonNullable<WorkState["pipelineState"]["workstreams"]>;
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>;
  gate: DevelopGate;
  execFn: ExecFn;
  dispatch: Dispatch;
}): Promise<WorkState> {
  const merged = await runSymbolMergeRetry(
    a.ctx,
    a.state,
    a.stateRef,
    a.ids,
    a.verdicts,
    a.gate,
    a.execFn,
    a.dispatch,
  );
  if (merged) return merged;
  const recorded = a.state.pipelineState.worktrees ?? {};
  const worktrees = Object.keys(recorded).length > 0 ? recorded : { default: a.ctx.repoRoot };
  const decision = decideCorrectiveRound(a.gate, {
    eventLog: a.state.eventLog,
    worktrees,
  });
  if (!decision.round) {
    trace(`work-driver: no corrective develop round — ${decision.reason}`);
    return appendDevelopVerifyFailure(a.state, a.gate);
  }
  trace(
    `work-driver: corrective develop round (${decision.source}) — ${decision.targets.map((t) => t.id).join(", ")}`,
  );
  const round = await runCorrectiveRound({
    ctx: a.ctx,
    state: a.state,
    decision,
    ids: a.ids,
    workstreams: a.workstreams,
    dispatch: a.dispatch,
    execFn: a.execFn,
  });
  if (round.failure !== undefined) {
    return appendDevelopVerifyFailure(round.state, {
      ...a.gate,
      failures: [...a.gate.failures, round.failure],
    });
  }
  return reverifyAfterRound(a.ctx, round.state, a.dispatch);
}

/**
 * Dispatch the round: write the `corrective-round` records, persist them, then
 * run each target's developer in its own worktree. Returns the state with the
 * round's completion events, and a failure text when any developer did not
 * complete (the caller parks on it without re-verifying).
 */
async function runCorrectiveRound(a: {
  ctx: CycleContext;
  state: WorkState;
  decision: RoundDecision;
  ids: string[];
  workstreams: NonNullable<WorkState["pipelineState"]["workstreams"]>;
  dispatch: Dispatch;
  execFn: ExecFn;
}): Promise<{ state: WorkState; failure?: string }> {
  const { ctx, decision, ids } = a;
  const ps = a.state.pipelineState;
  const at = Date.now();
  const rounds: WorkEvent[] = decision.targets.map((t) => ({
    kind: "corrective-round",
    at,
    step: "develop",
    workstreamId: t.id,
    attempt: 1,
    command: decision.command,
    evidenceLines: t.lines,
  }));
  const report = {
    step: "develop" as const,
    role: "driver",
    body: `corrective develop round (attempt 1, ${decision.source} evidence) ran \`${decision.command}\`; each developer was given its own failing lines:\n${decision.targets
      .flatMap((t) => t.lines.map((l) => `[${t.id}] ${l}`))
      .join("\n")}`,
    at,
  };
  let next = appendEvent(
    {
      ...a.state,
      pipelineState: {
        ...ps,
        currentStep: "develop",
        plumbReports: [...(ps.plumbReports ?? []), report],
      },
    },
    ...rounds,
  );
  // Write-ahead: the round is on disk before the first developer runs.
  await persistCycle(ctx, next);
  const label = ids.length > 1 ? `developer×${ids.length}` : "developer";
  const begun = await beginDispatch(ctx, next, "develop", "developer", label, Date.now());
  next = begun.state;

  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  const issues = activeIssuesOf(a.state);
  const settled = await Promise.allSettled(
    decision.targets.map(async (t) => {
      const devLabel = ids.length > 1 ? `developer[${t.id}]` : "developer";
      const ws = a.workstreams[t.id];
      const startedAt = Date.now();
      const res = await a.dispatch(
        ctx.host,
        {
          role: "developer",
          prompt: correctiveDevelopPrompt({
            issues,
            scratchDirAbs: scratchAbs,
            workstreamId: t.id,
            parallel: ids.length > 1 && t.id !== "default",
            scope: ws?.scope,
            paths: ws?.paths ?? [],
            command: decision.command,
            lines: t.lines,
          }),
          cwd: t.cwd,
        },
        {
          label: devLabel,
          childBoundMs: developChildBoundMs(),
          deck: {
            ...driverDeckOpts(ctx.issue, "develop", ids.length > 1 ? t.id : "default"),
            label: devLabel,
          },
          writeFence: { root: t.cwd, repo: ctx.repoRoot, scratch: scratchAbs },
        },
      );
      const completion = await buildCompletionEvent(ctx, "develop", "developer", devLabel, res);
      const base = ps.workstreamBaseShas?.[t.id] ?? ps.baseSha;
      const verdict = await classifyDevelopPass({
        id: t.id,
        cwd: t.cwd,
        base,
        execFn: a.execFn,
        result: res,
      });
      return { t, completion, verdict, ms: Date.now() - startedAt };
    }),
  );

  const events: WorkEvent[] = [];
  const failures: string[] = [];
  for (const [i, s] of settled.entries()) {
    const id = decision.targets[i]?.id ?? "?";
    if (s.status === "rejected") {
      failures.push(`corrective developer ${id} threw: ${String(s.reason).slice(0, 200)}`);
      continue;
    }
    events.push(s.value.completion);
    if (s.value.verdict.crashed) {
      events.push(
        crashedBranchCompleted({
          id,
          ms: s.value.ms,
          verdict: s.value.verdict,
        }),
      );
    }
    if (!s.value.verdict.ok) {
      failures.push(
        `corrective developer ${id} did not complete: ${s.value.verdict.reason ?? "developer did not complete ok"}`,
      );
    }
  }
  next = clearDispatch(appendEvent(next, ...events), begun.jobId);
  if (failures.length === 0) return { state: next };
  return {
    state: next,
    failure: failures.join("; ").slice(0, ROUND_FAILURE_MAX),
  };
}

/**
 * The develop verdict after the round: the full outcome gate again, then the
 * same recording and converge step a first-pass green takes. A failure here is
 * the second and final verdict, and it parks as the first failure did.
 */
async function reverifyAfterRound(
  ctx: CycleContext,
  state: WorkState,
  dispatch: Dispatch,
): Promise<WorkState> {
  const gate = await verifyStepOutcome(ctx, state, "develop");
  let next = recordCommentEvidence(state, gate.commentEvidence);
  next = recordDevelopGateEvents(next, gate);
  if (!gate.ok) return appendDevelopVerifyFailure(next, gate);
  if (gate.flakeRecovered) {
    next = appendEvent(next, {
      kind: "verify-flake-recovered",
      at: Date.now(),
      step: "develop",
    });
  }
  return runConvergeGateHandler(ctx, next, dispatch);
}
