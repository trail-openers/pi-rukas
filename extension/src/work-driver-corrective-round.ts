/**
 * work-driver-corrective-round — #1667: the develop step's ONE corrective round.
 *
 * When the develop verify fails on specific, attributed assertion lines
 * (work-driver-corrective-decide.ts decides that), each failing workstream's
 * developer is dispatched in its OWN worktree with only its own lines, and the
 * whole develop verdict is taken again: the full outcome gate
 * (`verifyStepOutcome`: scope fence, fanout, protected paths, out-of-scope
 * paths, verify) runs on the corrected tree, not only the verify command. The
 * verdict is recorded by the same function the first pass uses
 * (work-driver-develop-verdict.ts), so a corrected cycle routes identically.
 *
 * Order is load-bearing, and each rule has a test:
 *   - the `corrective-round` records and the developers' dispatch-started marker
 *     are ONE persisted write, before any developer starts: a crash before it
 *     leaves neither, a crash after it leaves the round, so a resumed cycle
 *     counts it from the log (no second round);
 *   - every corrective developer runs to completion; one failure, rejection or
 *     timeout parks at verify-failed:develop with no re-verify;
 *   - a second failing verify parks exactly as a first one does today.
 *
 * Reuses the fix-pass shape (work-driver-adversarial-fix.ts): same worktrees,
 * same dispatch bound, same gates, findings in the prompt. It does NOT go
 * through runDevelopTopological, whose gate would run inside the round and
 * re-enter this trigger.
 */

import { developChildBoundMs } from "./spawn-child-bound.ts";
import { trace } from "./trace.ts";
import { classifyDevelopPass, crashedBranchCompleted } from "./work-develop-crash.ts";
import { runSymbolMergeRetry } from "./work-develop-symbol-merge.ts";
import { appendDevelopVerifyFailure } from "./work-develop-verify-failure.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { type CorrectiveDecision, decideCorrectiveRound } from "./work-driver-corrective-decide.ts";
import { correctiveDevelopPrompt, oneLine } from "./work-driver-corrective-prompt.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import {
  type DevelopGate,
  type DevelopVerdict,
  recordDevelopVerdict,
} from "./work-driver-develop-verdict.ts";
import { beginDispatch, clearDispatch, resumeEnabled } from "./work-driver-resume.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { type WorkEvent, type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/** Longest text one corrective developer's failure contributes; each is cut on its own. */
const ROUND_FAILURE_MAX = 300;
/** Most developer failures the parked round names; the rest are counted, never dropped silently. */
const ROUND_FAILURES_SHOWN = 4;

type Dispatch = NonNullable<DriverContext["dispatchFn"]>;
type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;
type RoundDecision = Extract<CorrectiveDecision, { round: true }>;
type Workstreams = NonNullable<WorkState["pipelineState"]["workstreams"]>;
type StateRef = { current: WorkState };

/** The develop step's shared inputs, as the verdict and the round both read them. */
interface RoundInputs {
  ctx: CycleContext;
  stateRef: StateRef;
  ids: string[];
  workstreams: Workstreams;
  verdicts: DevelopVerdict[];
  execFn: ExecFn;
  dispatch: Dispatch;
}

/**
 * What a failed develop verify does, in order: the #1323 sibling-symbol merge
 * (unchanged, first), then the one corrective round when the decision earns it,
 * then the verdict. The re-verify after a round is the second and last verify;
 * its failure parks exactly as the first one did.
 */
export async function onDevelopVerifyFailed(
  a: RoundInputs & { state: WorkState; gate: DevelopGate },
): Promise<WorkState> {
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
  for (const s of decision.skipped) trace(`work-driver: corrective round skipped ${s}`);
  trace(
    `work-driver: corrective develop round (${decision.source}) — ${decision.targets.map((t) => t.id).join(", ")}`,
  );
  const round = await runCorrectiveRound({ ...a, decision });
  if (round.failure !== undefined) {
    return appendDevelopVerifyFailure(round.state, {
      ...a.gate,
      failures: [...a.gate.failures, round.failure],
    });
  }
  return reverifyAfterRound({ ...a, state: round.state, verdicts: round.verdicts });
}

/**
 * Dispatch the round: write-ahead the `corrective-round` records together with
 * the developers' dispatch-started marker, then run each target's developer in
 * its own worktree. Returns the state with the round's completion events, and a
 * failure text when any developer did not complete (the caller parks on it
 * without re-verifying).
 */
async function runCorrectiveRound(
  a: RoundInputs & { decision: RoundDecision; state: WorkState },
): Promise<{ state: WorkState; verdicts: DevelopVerdict[]; failure?: string }> {
  const { ctx, decision, ids } = a;
  const at = Date.now();
  const rounds: WorkEvent[] = decision.targets.map((t) => ({
    kind: "corrective-round",
    at,
    step: "develop",
    workstreamId: t.id,
    attempt: 1,
    command: decision.command,
    evidenceLines: t.lines.map(oneLine),
  }));
  const withRounds = appendEvent(
    {
      ...a.state,
      pipelineState: { ...a.state.pipelineState, currentStep: "develop" },
    },
    ...rounds,
  );
  // Write-ahead, ONE persisted write: beginDispatch persists the rounds and the
  // dispatch-started marker together. With resume off it persists nothing, so
  // the rounds still go to disk here, before the first developer runs.
  const label = ids.length > 1 ? `developer×${ids.length}` : "developer";
  const begun = await beginDispatch(ctx, withRounds, "develop", "developer", label, Date.now());
  let next = begun.state;
  if (!resumeEnabled()) await persistCycle(ctx, next);
  a.stateRef.current = next;

  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  const issues = activeIssuesOf(a.state);
  const ps = a.state.pipelineState;
  const settled = await Promise.allSettled(
    decision.targets.map(async (t) => {
      const devLabel = ids.length > 1 ? `developer[${t.id}]` : "developer";
      const ws: Workstreams[string] | undefined = a.workstreams[t.id];
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
      // Post-processing runs after the developer has run. If it throws, the work
      // is still in the worktree and the failure is named in the verify evidence;
      // no completion event is written for a pass that could not be read.
      try {
        const completion = await buildCompletionEvent(ctx, "develop", "developer", devLabel, res);
        const base = ps.workstreamBaseShas?.[t.id] ?? ps.baseSha;
        const verdict = await classifyDevelopPass({
          id: t.id,
          cwd: t.cwd,
          base,
          execFn: a.execFn,
          result: res,
        });
        return { kind: "done" as const, t, completion, verdict, ms: Date.now() - startedAt };
      } catch (err) {
        const { message, full } = describeRejection(err);
        trace(
          `work-driver: corrective developer ${t.id} finished but its result was not read: ${full}`,
        );
        return { kind: "unread" as const, id: t.id, message };
      }
    }),
  );

  const events: WorkEvent[] = [];
  const failures: string[] = [];
  // The corrective passes' verdicts, for the workstreams that completed a pass.
  const corrected: Array<{ id: string; ok: boolean; reason?: string }> = [];
  for (const [i, s] of settled.entries()) {
    const id = decision.targets[i]?.id ?? "?";
    if (s.status === "rejected") {
      // The full error goes to the trace; the event and the verify evidence carry its message.
      const { message, full } = describeRejection(s.reason);
      trace(`work-driver: corrective developer ${id} threw: ${full}`);
      failures.push(`corrective developer ${id} threw: ${message}`);
      events.push({
        kind: "dispatch-failed",
        step: "develop",
        role: "developer",
        jobId: begun.jobId,
        label: ids.length > 1 ? `developer[${id}]` : "developer",
        ms: Date.now() - at,
        at: Date.now(),
        exitCode: null,
        errorTail: `corrective developer ${id} threw: ${message}`.slice(0, 200),
      });
      continue;
    }
    if (s.value.kind === "unread") {
      failures.push(
        `corrective developer ${s.value.id} finished but its result was not read: ${s.value.message}`,
      );
      continue;
    }
    events.push(s.value.completion);
    corrected.push({ id, ok: s.value.verdict.ok, reason: s.value.verdict.reason });
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
  a.stateRef.current = next;
  const verdicts = refreshVerdicts(a.verdicts, corrected);
  if (failures.length === 0) return { state: next, verdicts };
  return { state: next, verdicts, failure: boundedRoundFailures(failures) };
}

/**
 * The develop verdicts after a corrective round. A workstream the round
 * dispatched takes its corrective pass's verdict in place of its first-pass one;
 * the rest keep theirs. Order and ids are the first pass's.
 */
export function refreshVerdicts(
  prior: DevelopVerdict[],
  corrected: ReadonlyArray<{ id: string; ok: boolean; reason?: string }>,
): DevelopVerdict[] {
  const fresh = new Map(corrected.map((c) => [c.id, c]));
  return prior.map((v) => {
    const c = fresh.get(v.id);
    if (c === undefined) return v;
    return { id: v.id, ok: c.ok, ...(c.reason !== undefined ? { reason: c.reason } : {}) };
  });
}

/**
 * The round's failures as verify evidence: each cut on its own, the first few
 * named, and an explicit `[+N more]` marker for the rest. The join is never cut.
 */
function boundedRoundFailures(failures: string[]): string {
  const shown = failures
    .slice(0, ROUND_FAILURES_SHOWN)
    .map((f) => (f.length > ROUND_FAILURE_MAX ? `${f.slice(0, ROUND_FAILURE_MAX)}…` : f));
  const more = failures.length - shown.length;
  return [...shown, ...(more > 0 ? [`[+${more} more]`] : [])].join("; ");
}

/** A rejected settle's message, and its full text (message and stack) for the trace. */
function describeRejection(reason: unknown): { message: string; full: string } {
  if (reason instanceof Error) {
    return { message: reason.message, full: `${reason.message}\n${reason.stack ?? ""}` };
  }
  return { message: String(reason), full: String(reason) };
}

/**
 * The develop verdict after the round: the full outcome gate again, then the
 * same recording as a first pass (recordDevelopVerdict). A failure here is the
 * second and final verdict, and it parks as the first failure did.
 */
async function reverifyAfterRound(a: RoundInputs & { state: WorkState }): Promise<WorkState> {
  const gate = await verifyStepOutcome(a.ctx, a.state, "develop");
  return recordDevelopVerdict({
    ctx: a.ctx,
    state: a.state,
    stateRef: a.stateRef,
    ids: a.ids,
    verdicts: a.verdicts,
    gate,
    execFn: a.execFn,
    dispatch: a.dispatch,
    onVerifyFailed: async (s, g) => appendDevelopVerifyFailure(s, g),
  });
}
