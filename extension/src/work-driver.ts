/**
 * /work driver — the deterministic orchestrator for compiled /work cycles.
 * Code-as-orchestrator: owns step transitions (#393), dispatches via
 * `dispatchCore()` (ownerKind:driver), persists to `.pi/work-state/` via
 * `persistCycle()`, surfaces progress via `notifyAgent()`.
 * All 9 steps wired; each implementation lives in `work-driver-<step>.ts`.
 */
import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import { runArtifactSweep } from "./work-driver-artifact-sweep.ts";
import { checkAttentionLabel } from "./work-driver-attention.ts";
import { checkpointCapedDispatch } from "./work-driver-cap-checkpoint.ts";
import {
  type CycleContext,
  type DriverContext,
  DriverNotImplementedError,
  STEP_ORDINAL,
  nextStep,
} from "./work-driver-context.ts";
import { enterCycle } from "./work-driver-cycle-entry.ts";
import { acquireWorkDeckHeader, headerToken } from "./work-driver-deck-header.ts";
import { countPriorStepStarts } from "./work-driver-diff.ts";
import { reportFinalState } from "./work-driver-final-state.ts";
import { interruptIfRequested, recordStepCrash } from "./work-driver-interrupt.ts";
import {
  clearFooter,
  emitStepCompleted,
  emitStepFailed,
  emitStepStarted,
  updateFooter,
} from "./work-driver-lifecycle.ts";
import { recordProtectedGrant } from "./work-driver-protected-grant.ts";
import { claimCycle } from "./work-driver-registry.ts";
import {
  attemptReattach,
  attemptReattachInResume,
  classifyRunningState,
  clearForResume,
  explainRefusal,
  explainResume,
  resolveReattach,
  resumeEnabled,
} from "./work-driver-resume-reattach.ts";
import { reenterInterrupted } from "./work-driver-resume.ts";
import { runStep } from "./work-driver-run-step.ts";
import { interruptedAfter, interruptedByShutdown, sessionEnding } from "./work-driver-shutdown.ts";
import { routeStepOutcome } from "./work-driver-step-router.ts";
import { deliverTerminalLine } from "./work-driver-terminal-delivery.ts";
import { scratchDir, setupWorkspaceTmp, teardownWorkspaceTmp } from "./work-driver-workspace.ts";
import { runWorktreeSweep } from "./work-driver-worktree-sweep.ts";
import * as workWidget from "./work-widget.ts";
import { validateDiscriminants } from "./workflow-state-validate.ts";
import { type WorkEvent, appendEvent } from "./workflow-state.ts";
import {
  type WorkState,
  type WorkStep,
  detectInconsistencies,
  initialState,
  persistCycle,
  readState,
  workStateDir,
} from "./workflow-state.ts";

export { DriverNotImplementedError } from "./work-driver-context.ts";

/** Outcome of a `runWorkDriver` call: `{started: true}` or `{started: false; reason}`. */
export type DriverOutcome = { started: true } | { started: false; reason: string };
/**
 * Run one /work cycle: read/create state, loop over steps via `nextStep()`,
 * persist after every transition, surface outcome via `pi.sendUserMessage`.
 * Fire-and-forget: callers start via `void runWorkDriver().catch(reportFatal)`.
 */
export async function runWorkDriver(ctx: DriverContext): Promise<DriverOutcome> {
  if (sessionEnding()) {
    const reason = "the session is shutting down";
    trace(`work-driver: /work #${ctx.issue} not started — ${reason}`);
    notifyAgent(ctx.host, `pi-rukas: /work for #${ctx.issue} not started — ${reason}.`);
    return { started: false, reason };
  }
  const claimed = claimCycle(ctx.issue, ctx.issues);
  if (!claimed.ok) {
    notifyAgent(
      ctx.host,
      `pi-rukas: /work for issue #${ctx.issue} refused — issue #${claimed.conflictIssue} is already being worked by the cycle for #${claimed.heldByCycle} in this session. Two drivers on one branch interleave commits and produce a PR nobody can review. Wait for it to finish, or check /work-status.`,
    );
    return {
      started: false,
      reason: `issue #${claimed.conflictIssue} is already held by the live cycle for #${claimed.heldByCycle}`,
    };
  }
  try {
    const cycleCtx = enterCycle(ctx);
    // #838 — the per-cycle deck header ("/work #N"): created when the cycle
    // starts, cleared on EVERY terminal path via the finally — merged,
    // handoff, park, halt, thrown error all unwind through it. A second
    // cycle on the same issue never clobbers the first cycle's header
    // (per-invocation ownership token; see work-driver-deck-header.ts).
    const header = acquireWorkDeckHeader(ctx.issue, headerToken());
    try {
      return await runWorkDriverInner(cycleCtx);
    } finally {
      header.release();
    }
  } finally {
    claimed.claim.release();
  }
}

async function runWorkDriverInner(ctx: CycleContext): Promise<DriverOutcome> {
  // PR12 — `/work N --restart`: skip readState, start fresh. Branch step
  // handles worktree leftovers at runtime; this flag only wipes state.
  let state =
    ctx.restart === true
      ? initialState(ctx.issue)
      : reenterInterrupted((await readState(ctx.repoRoot, ctx.issue)) ?? initialState(ctx.issue));
  if (ctx.restart === true) {
    trace(`work-driver: --restart wiped state for issue #${ctx.issue} (fresh cycle)`);
  }
  // PR10 — persist multi-issue list on first run; honour existing on resume
  // (don't widen scope silently). --restart yields issues===undefined → flows through.
  if (ctx.issues && ctx.issues.length > 0 && state.issues === undefined) {
    state = { ...state, issues: ctx.issues };
  }
  // #1090 — record this invocation's grant; a resume without the flag clears it.
  state = recordProtectedGrant(state, ctx.protectedGrant);

  // PR12 — surface a clear notify when state is already terminal and no --restart.
  if (state.pipelineState.status !== "running" && ctx.restart !== true) {
    const terminalStatus = state.pipelineState.status;
    const at = new Date().toISOString();
    notifyAgent(
      ctx.host,
      `pi-rukas:driver-event v1 kind=refused issue=${ctx.issue} at=${at}\npi-rukas: /work for issue #${ctx.issue} already terminated as ${terminalStatus}. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with --restart:\n  /work ${ctx.issue} --restart\nOr rm ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json manually. The prior cycle's event log is preserved in the state file until you restart or remove it.`,
    );
    // reportFinalState is called at every terminal path (7 sites) so the runner
    // always gets the driver's in-memory terminal state — see work-driver-final-state.ts
    reportFinalState(ctx, state);
    return { started: false, reason: `already terminated as ${terminalStatus}` };
  }

  // #408 — the driver has always WRITTEN `needs-human-attention` and never read
  // it back, so /work on a handed-off issue quietly reran the whole pipeline
  // and produced the same handoff again. Checked before any dispatch is paid
  // for. `--restart` is the override: it already means "I revised the issue".
  {
    const attention = await checkAttentionLabel(ctx.repoRoot, ctx.issue, {
      restart: ctx.restart === true,
      issues: ctx.issues,
    });
    if (attention.refuse && attention.message) {
      notifyAgent(ctx.host, attention.message);
      reportFinalState(ctx, state);
      return { started: false, reason: "issue carries the needs-human-attention label" };
    }
    if (!attention.checked) {
      trace(`work-driver: needs-human-attention check did not run for #${ctx.issue}`);
    }
  }

  // Launch sweep: other cycles' stale worktrees. Guarded by PI_ENSEMBLE_WORKTREE_SWEEP=0.
  if (process.env.PI_ENSEMBLE_WORKTREE_SWEEP !== "0") {
    await runWorktreeSweep({
      repoRoot: ctx.repoRoot,
      launchingCycleIssue: ctx.issue,
      liveCycles: new Set(ctx.issues),
    });
  }
  // #657 — bounded best-effort sweep of orphan artifact dirs under
  // .pi/work-state/ (numeric names, no sibling <N>.json, mtime > 14 days).
  // Never throws; a failure is traced and swallowed.
  await runArtifactSweep({ repoRoot: ctx.repoRoot });

  // #382 — resume on `running` state file: refuse (live pid), resume
  // (died mid-dispatch), or continue (clean boundary).
  if (resumeEnabled() && ctx.restart !== true) {
    const verdict = classifyRunningState(state);
    if (verdict.action === "refuse") {
      const at = new Date().toISOString();
      notifyAgent(
        ctx.host,
        `pi-rukas:driver-event v1 kind=refused issue=${ctx.issue} at=${at}\n${explainRefusal(ctx.issue, verdict.ownerPid)}`,
      );
      return {
        started: false,
        reason: `another live process (pid ${verdict.ownerPid}) owns this cycle`,
      };
    }
    if (verdict.action === "resume") {
      // #573 — reattach surviving session before falling back to re-dispatch.
      const inFlightEvents = state.eventLog.filter(
        (e) =>
          e.kind === "dispatch-started" &&
          verdict.jobIds.includes((e as { jobId?: string }).jobId ?? ""),
      );
      // Find the dispatch-started event matching one of the in-flight job IDs.
      const startedEvt = inFlightEvents.find(
        (e) => (e as { jobId?: string }).jobId === verdict.jobIds[0],
      ) as (WorkEvent & { jobId?: string; transcriptPath?: string; role?: string }) | undefined;
      const at = new Date().toISOString();
      notifyAgent(
        ctx.host,
        `pi-rukas:driver-event v1 kind=resume issue=${ctx.issue} at=${at}\n${explainResume(ctx.issue, verdict.step, verdict.jobIds.length)}`,
      );

      // #573 — reattach attempt.
      const { shouldSkipStep, nextState } = await attemptReattachInResume(
        ctx,
        state,
        verdict,
        inFlightEvents,
      );
      if (shouldSkipStep && nextState) {
        state = nextState;
      } else {
        // The orphaned `dispatch-started` events stay in the log — they are the
        // only record that a dispatch was paid for and lost.
        state = clearForResume(state);
      }
    }
  }

  // #533 — refuse on unrecognised discriminant in `running` state only.
  if (state.pipelineState.status === "running") {
    const unknowns = validateDiscriminants(state);
    if (unknowns.length > 0) {
      const detail = unknowns.map((u) => `  - ${u}`).join("\n");
      trace(`work-driver: state discriminant validation failed for issue ${ctx.issue}:\n${detail}`);
      notifyAgent(
        ctx.host,
        `pi-rukas /work driver halted on issue #${ctx.issue}: state file carries an unrecognised value.\n${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
      );
      return { started: false, reason: "state-file discriminant validation failed" };
    }
  }

  // Detect half-written state (resume hazard).
  const inconsistencies = detectInconsistencies(state);
  if (inconsistencies.length > 0) {
    const detail = inconsistencies.join("\n  - ");
    trace(`work-driver: state inconsistencies detected for issue ${ctx.issue}:\n  - ${detail}`);
    notifyAgent(
      ctx.host,
      `pi-rukas /work driver halted on issue #${ctx.issue}: state-file inconsistencies detected.\n  - ${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
    );
    return { started: false, reason: "state-file inconsistencies detected" };
  }

  // Persist the initial state on first run so the user can see the file
  // appear as soon as a cycle starts.
  await persistCycle(ctx, state);

  // PR2 fold-in: set up project-local scratch dir (#553).
  const tmpDir = await setupWorkspaceTmp(ctx.repoRoot, ctx.issue);
  trace(`work-driver: scratch dir for issue #${ctx.issue}: ${tmpDir}`);

  // Headless S4 (#1024): an interrupt that arrived before the first step is
  // recorded here, so the cycle's log says why it stopped.
  state = await interruptIfRequested(ctx, state);

  let safety = 0;
  while (state.pipelineState.status === "running") {
    // Headless S4 (#1024) — an interrupt (SIGTERM / SIGINT) is honoured at the
    // step boundary, before any further step is paid for.
    state = await interruptIfRequested(ctx, state);
    if (state.pipelineState.status !== "running") break;
    safety++;
    if (safety > 64) {
      // Safety: unbounded transition loop guard.
      trace(`work-driver: safety break after 64 iterations for issue ${ctx.issue}`);
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await persistCycle(ctx, state);
      notifyAgent(
        ctx.host,
        `pi-rukas /work driver aborted on issue #${ctx.issue}: transition safety limit reached.` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json for the state.`,
      );
      // The cycle ran and then aborted — its state file is the real outcome.
      reportFinalState(ctx, state);
      return { started: true };
    }
    const step = state.pipelineState.currentStep;
    // A session shutdown is not a step failure — see work-driver-shutdown.ts.
    if (interruptedByShutdown(ctx, state, step)) return { started: true };
    // Step-level lifecycle event (PR2 O1): "▶ step N/9 X started".
    const stepOrd = STEP_ORDINAL[step] ?? { num: 0, total: 9 };
    const stepStartedAt = Date.now();
    // PR4: sub-round labels for iterative steps.
    const stepRound = countPriorStepStarts(state, step) + 1;
    // #657 — the first event of this iteration is the step-started the step
    // handler appends; its round is derived at render time (fmtRecentEvents)
    // so renderers can show re-entries as "adversarial (round 3)". Additive
    // field; absent in the 12 per-step handler append sites, so nothing there changes.
    emitStepStarted(step, stepOrd.num, stepOrd.total, stepRound, ctx.issue);
    // PR2 O2: footer status cursor (step-level position with live-tick).
    updateFooter(state, stepStartedAt);
    try {
      state = await runStep(ctx, state, step);
      if (interruptedAfter(ctx, state, step)) return { started: true };
    } catch (err) {
      // A throw during a session shutdown is the abort's doing, not a crash (work-driver-shutdown.ts).
      if (interruptedByShutdown(ctx, state, step, err)) return { started: true };
      // Recorded before the abort branch: a crash that coincides with a signal
      // is still a crash. An abort that makes the step throw is the interrupt.
      state = recordStepCrash(state, step, err);
      if (ctx.signal?.aborted === true) {
        state = await interruptIfRequested(ctx, state);
        break;
      }
      if (err instanceof DriverNotImplementedError) {
        trace(
          `work-driver: ${err.message} — falling back to PM-driven flow not yet implemented; halting`,
        );
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, status: "aborted" },
        };
        await persistCycle(ctx, state);
        emitStepFailed(
          step,
          stepOrd.num,
          stepOrd.total,
          Date.now() - stepStartedAt,
          "step not implemented",
          stepRound,
          ctx.issue,
        );
        notifyAgent(
          ctx.host,
          `pi-rukas /work driver halted: step "${err.step}" is not implemented in this build. This is a bug — the state file at .pi/work-state/ has the full cycle for the report.`,
        );
        // The cycle ran and then aborted — its state file is the real outcome.
        reportFinalState(ctx, state);
        return { started: true };
      }
      // Spawn-level / unexpected error — route through the SAME handoff path a
      // dispatch failure uses (issue #1263) so the operator gets a comment +
      // label on the issue, not just a silent `aborted` state file. One-shot
      // guard: a throw at `handoff` itself means runHandoff already ran and is
      // crashing on the post — re-routing to handoff would loop forever, so a
      // handoff crash falls back to the direct abort (still `aborted`, state
      // file is the record; the handoff body was already attempted).
      if (step === "handoff") {
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, status: "aborted" },
        };
        await persistCycle(ctx, state);
        emitStepFailed(
          step,
          stepOrd.num,
          stepOrd.total,
          Date.now() - stepStartedAt,
          (err as Error).message?.slice(0, 80),
          stepRound,
          ctx.issue,
        );
        notifyAgent(
          ctx.host,
          `pi-rukas /work driver aborted on step "handoff" for issue #${ctx.issue}: ` +
            `${(err as Error).message}`,
        );
        reportFinalState(ctx, state);
        return { started: true };
      }
      // Append the cap-hit (reason = the crash, via cap `driver-crash:<step>`),
      // point the loop at `handoff`, and leave status running so runHandoff
      // runs and sets the terminal status itself: `driver-crash:*` is NOT a
      // mid-flight-halt shape there, so it terminalizes as `handoff` — the
      // same value the dispatch-failure path uses.
      state = appendEvent(state, {
        kind: "cap-hit",
        at: Date.now(),
        cap: `driver-crash:${step}` as const,
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      });
      emitStepFailed(
        step,
        stepOrd.num,
        stepOrd.total,
        Date.now() - stepStartedAt,
        (err as Error).message?.slice(0, 80),
        stepRound,
        ctx.issue,
      );
      trace(
        `work-driver: step "${step}" threw — ${
          (err as Error).message
        } → handoff (comment + label before aborting)`,
      );
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, currentStep: "handoff" },
      };
      await persistCycle(ctx, state);
      continue;
    }
    // Headless S4 (#1024): an interrupt that fired during the step ends the
    // cycle here, without routing. The step's events stay in the log (they
    // happened); the router never sees its outcome, so no handoff follows.
    if (ctx.signal?.aborted === true) {
      state = await interruptIfRequested(ctx, state);
      break;
    }
    // Route step outcome (work-driver-step-router.ts); `retry: true` means
    // the router already persisted state and we re-enter.
    const routed = await routeStepOutcome(ctx, state, step, stepOrd, stepRound, stepStartedAt);
    state = routed.state;
    // #657 — the loop round is derived from log position when rendered
    // (fmtRecentEvents), not backfilled here: an amended step-started would no
    // longer match the event the host was already emitted (S4a, #1162).
    // Do not append a second step-started to backfill: nextStep()/routeStepOutcome() read the trailing event.
    // #543 F5 — driver-owned checkpoint after a dispatch-cap kill. Must stay
    // BEFORE the `routed.retry` continue so a retried step never checkpoints
    // the same kill twice. Never throws; failure degrades to the uncommitted.
    state = await checkpointCapedDispatch(ctx, state, step);
    if (routed.retry) continue;

    // Capture completedStep BEFORE nextStep() clobbers it.
    const completedStep = state.pipelineState.currentStep;
    const decision = nextStep(state);
    if (decision.kind === "done") break;
    // #533 — unknown currentStep value.
    if (decision.kind === "unknown-step") {
      trace(
        `work-driver: unknown step value ${JSON.stringify(decision.value)} for issue ${ctx.issue}`,
      );
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await persistCycle(ctx, state);
      notifyAgent(
        ctx.host,
        `pi-rukas:driver-event v1 kind=crash issue=${ctx.issue} at=${new Date().toISOString()}\npi-rukas /work driver halted on issue #${ctx.issue}: pipelineState.currentStep has unknown value ${JSON.stringify(decision.value)}. ` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh.`,
      );
      reportFinalState(ctx, state);
      return { started: true };
    }
    const decisionStep = decision.step;
    if (decisionStep !== state.pipelineState.currentStep) {
      state = {
        ...state,
        pipelineState: {
          ...state.pipelineState,
          lastCompletedStep: completedStep,
          currentStep: decisionStep,
        },
      };
      await persistCycle(ctx, state);
    }
  }

  // Clear footer cursor (PR2 O2).
  workWidget.clear(ctx.issue);

  // Cleanup scratch dir on success only — handoff/aborted keep the dir
  // so the user can inspect artifacts from failures.
  const final = state.pipelineState.status;
  // A loop that ends with status still "running" is a driver bug of the
  // awaiting-human-merge class (a transition answered "done" while a
  // routing decision was pending). It must never again be invisible: 25
  // cycles on this host sat in that shape with no comment, no label, no
  // notification.
  if (final === "running") {
    trace(
      `work-driver: ANOMALY — loop exited with status "running" for issue ${ctx.issue} (currentStep=${state.pipelineState.currentStep})`,
    );
    notifyAgent(
      ctx.host,
      `pi-rukas /work driver ended its loop for issue #${ctx.issue} with status still "running" — this is a driver bug; the cycle did NOT terminalize. Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json and report the event tail.`,
    );
  }
  if (final === "merged") {
    await teardownWorkspaceTmp(ctx.repoRoot, ctx.issue);
  }

  // #808 — single terminal-delivery path (work-driver-terminal-delivery.ts):
  // send first, record handoffDeliveredAt only after a successful send, and
  // trace (never escape) a delivery throw so a resume can re-attempt it.
  state = await deliverTerminalLine(ctx, state);
  if (final === "handoff" || final === "aborted") {
    // Persist the updated state (handoffDeliveredAt set on success, or
    // unchanged when the send threw — in which case the next invocation
    // retries the delivery). On a send failure this write is the only
    // record that the driver reached its terminal boundary at all.
    await persistCycle(ctx, state);
  }
  reportFinalState(ctx, state);
  return { started: true };
}
