/**
 * /work driver — the deterministic orchestrator for compiled /work cycles.
 *
 * Code-as-orchestrator: owns step transitions (#393), dispatches via
 * `dispatchCore()` (ownerKind:driver), persists to `.pi/work-state/` via
 * `writeState()`, surfaces progress via `notifyAgent()`.
 *
 * All 9 steps wired; each implementation lives in `work-driver-<step>.ts`.
 */
import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import { runAdversarial } from "./work-driver-adversarial.ts";
import { checkAttentionLabel } from "./work-driver-attention.ts";
import { runBranch, runDevelop } from "./work-driver-branch-develop.ts";
import { checkpointCapedDispatch } from "./work-driver-cap-checkpoint.ts";
import { runCommitPr } from "./work-driver-commit.ts";
import { type DriverContext, STEP_ORDINAL, nextStep } from "./work-driver-context.ts";
import { countPriorStepStarts } from "./work-driver-diff.ts";
import { runExplore } from "./work-driver-explore.ts";
import { finalizeCycle } from "./work-driver-finalize.ts";
import { renderHandoffUserMessage } from "./work-driver-handoff-message.ts";
import { runHandoff } from "./work-driver-handoff.ts";
import { runLens, runLensFix } from "./work-driver-lens.ts";
import {
  clearFooter,
  emitStepCompleted,
  emitStepFailed,
  emitStepStarted,
  updateFooter,
} from "./work-driver-lifecycle.ts";
import { runMerged } from "./work-driver-merged.ts";
import { runPlan } from "./work-driver-plan.ts";
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
import { routeStepOutcome } from "./work-driver-step-router.ts";
import { runCi, runStepBack } from "./work-driver-stepback-ci.ts";
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
  readState,
  workStateDir,
  writeState,
} from "./workflow-state.ts";

/**
 * Run a single step end-to-end: load template (or judge inline for PM-
 * judgment-shaped steps), dispatch via `dispatchCore`, await, append
 * event(s), update pipelineState. Returns the new state. Persistence is
 * the caller's responsibility (so multi-step transitions don't double-write).
 *
 * Per-step implementations are intentionally separated rather than
 * collapsed into one big switch — each step's prompt template, role
 * selection, and event-emission logic is distinct enough that a giant
 * switch becomes harder to read than a dispatch table.
 */
async function runStep(ctx: DriverContext, state: WorkState, step: WorkStep): Promise<WorkState> {
  const now = Date.now();
  trace(`work-driver: running step "${step}" for issue ${ctx.issue}`);

  switch (step) {
    case "explore":
      return runExplore(ctx, state, now);
    case "plan":
      return runPlan(ctx, state, now);
    case "branch":
      return runBranch(ctx, state, now);
    case "develop":
      return runDevelop(ctx, state, now);
    case "adversarial":
      return runAdversarial(ctx, state, now);
    case "commit-pr":
      return runCommitPr(ctx, state, now);
    case "lens-review":
      return runLens(ctx, state, now);
    case "lens-fix":
      return runLensFix(ctx, state, now);
    case "step-back":
      return runStepBack(ctx, state, now);
    case "ci":
      return runCi(ctx, state, now);
    case "handoff":
      return runHandoff(ctx, state, now);
    case "merged":
      return runMerged(ctx, state, now);
  }
}

/**
 * Error thrown by `runStep` when the step's body is staged for a later
 * commit. The smoke test asserts these are thrown for the unimplemented
 * steps; the live /work handler catches them and falls back to legacy
 * PM-driven flow until the step body lands.
 */
export class DriverNotImplementedError extends Error {
  constructor(public readonly step: WorkStep) {
    super(`work-driver: step "${step}" is not yet implemented in this build`);
    this.name = "DriverNotImplementedError";
  }
}

/**
 * Run one /work cycle: read/create state, loop over steps via `nextStep()`,
 * persist after every transition, surface outcome via `pi.sendUserMessage`.
 *
 * Fire-and-forget: callers start via `void runWorkDriver().catch(reportFatal)`.
 */
/**
 * Outcome of a `runWorkDriver` call: `{started: true}` or `{started: false; reason}`.
 */
export type DriverOutcome = { started: true } | { started: false; reason: string };

export async function runWorkDriver(ctx: DriverContext): Promise<DriverOutcome> {
  const claimed = claimCycle(ctx.issue, ctx.issues);
  if (!claimed.ok) {
    notifyAgent(
      ctx.pi,
      `pi-ensemble: /work for issue #${ctx.issue} refused — issue #${claimed.conflictIssue} is already being worked by the cycle for #${claimed.heldByCycle} in this session. Two drivers on one branch interleave commits and produce a PR nobody can review. Wait for it to finish, or check /work-status.`,
    );
    return {
      started: false,
      reason: `issue #${claimed.conflictIssue} is already held by the live cycle for #${claimed.heldByCycle}`,
    };
  }
  try {
    return await runWorkDriverInner(ctx);
  } finally {
    claimed.claim.release();
  }
}

async function runWorkDriverInner(ctx: DriverContext): Promise<DriverOutcome> {
  // PR12 — `/work N --restart`: skip readState, start fresh. Branch step
  // handles worktree leftovers at runtime; this flag only wipes state.
  let state =
    ctx.restart === true
      ? initialState(ctx.issue)
      : ((await readState(ctx.repoRoot, ctx.issue)) ?? initialState(ctx.issue));
  if (ctx.restart === true) {
    trace(`work-driver: --restart wiped state for issue #${ctx.issue} (fresh cycle)`);
  }
  // PR10 — persist multi-issue list on first run; honour existing on resume
  // (don't widen scope silently). --restart yields issues===undefined → flows through.
  if (ctx.issues && ctx.issues.length > 0 && state.issues === undefined) {
    state = { ...state, issues: ctx.issues };
  }

  // PR12 — surface a clear notify when state is already terminal and no --restart.
  if (state.pipelineState.status !== "running" && ctx.restart !== true) {
    const terminalStatus = state.pipelineState.status;
    const at = new Date().toISOString();
    notifyAgent(
      ctx.pi,
      `pi-ensemble:driver-event v1 kind=refused issue=${ctx.issue} at=${at}\npi-ensemble: /work for issue #${ctx.issue} already terminated as ${terminalStatus}. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with --restart:\n  /work ${ctx.issue} --restart\nOr rm ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json manually. The prior cycle's event log is preserved in the state file until you restart or remove it.`,
    );
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
      notifyAgent(ctx.pi, attention.message);
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

  // #382 — resume on `running` state file: refuse (live pid), resume
  // (died mid-dispatch), or continue (clean boundary).
  if (resumeEnabled() && ctx.restart !== true) {
    const verdict = classifyRunningState(state);
    if (verdict.action === "refuse") {
      const at = new Date().toISOString();
      notifyAgent(
        ctx.pi,
        `pi-ensemble:driver-event v1 kind=refused issue=${ctx.issue} at=${at}\n${explainRefusal(ctx.issue, verdict.ownerPid)}`,
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
        ctx.pi,
        `pi-ensemble:driver-event v1 kind=resume issue=${ctx.issue} at=${at}\n${explainResume(ctx.issue, verdict.step, verdict.jobIds.length)}`,
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
        ctx.pi,
        `pi-ensemble /work driver halted on issue #${ctx.issue}: state file carries an unrecognised value.\n${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
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
      ctx.pi,
      `pi-ensemble /work driver halted on issue #${ctx.issue}: state-file inconsistencies detected.\n  - ${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
    );
    return { started: false, reason: "state-file inconsistencies detected" };
  }

  // Persist the initial state on first run so the user can see the file
  // appear as soon as a cycle starts.
  await writeState(ctx.repoRoot, state);

  // PR2 fold-in: set up project-local scratch dir (#553).
  const tmpDir = await setupWorkspaceTmp(ctx.repoRoot, ctx.issue);
  trace(`work-driver: scratch dir for issue #${ctx.issue}: ${tmpDir}`);

  let safety = 0;
  while (state.pipelineState.status === "running") {
    safety++;
    if (safety > 64) {
      // Safety: unbounded transition loop guard.
      trace(`work-driver: safety break after 64 iterations for issue ${ctx.issue}`);
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await writeState(ctx.repoRoot, state);
      notifyAgent(
        ctx.pi,
        `pi-ensemble /work driver aborted on issue #${ctx.issue}: transition safety limit reached. ` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json for the state.`,
      );
      // The cycle ran and then aborted — its state file is the real outcome.
      return { started: true };
    }
    const step = state.pipelineState.currentStep;
    // Step-level lifecycle event (PR2 O1): "▶ step N/9 X started".
    const stepOrd = STEP_ORDINAL[step] ?? { num: 0, total: 9 };
    const stepStartedAt = Date.now();
    // PR4: sub-round labels for iterative steps.
    const stepRound = countPriorStepStarts(state, step) + 1;
    emitStepStarted(step, stepOrd.num, stepOrd.total, stepRound, ctx.issue);
    // PR2 O2: footer status cursor (step-level position with live-tick).
    updateFooter(state, stepStartedAt);
    try {
      state = await runStep(ctx, state, step);
    } catch (err) {
      if (err instanceof DriverNotImplementedError) {
        trace(
          `work-driver: ${err.message} — falling back to PM-driven flow not yet implemented; halting`,
        );
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, status: "aborted" },
        };
        await writeState(ctx.repoRoot, state);
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
          ctx.pi,
          `pi-ensemble /work driver halted: step "${err.step}" is not implemented in this build. This is a bug — the state file at .pi/work-state/ has the full cycle for the report.`,
        );
        // The cycle ran and then aborted — its state file is the real outcome.
        return { started: true };
      }
      // Spawn-level / unexpected error — mark aborted with the error.
      trace(`work-driver: step "${step}" threw: ${(err as Error).message}`);
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await writeState(ctx.repoRoot, state);
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
        ctx.pi,
        `pi-ensemble /work driver aborted on step "${step}" for issue #${ctx.issue}: ` +
          `${(err as Error).message}`,
      );
      // The cycle ran and then aborted — its state file is the real outcome.
      return { started: true };
    }
    // Route step outcome (work-driver-step-router.ts); `retry: true` means
    // the router already persisted state and we re-enter.
    const routed = await routeStepOutcome(ctx, state, step, stepOrd, stepRound, stepStartedAt);
    state = routed.state;
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
      await writeState(ctx.repoRoot, state);
      notifyAgent(
        ctx.pi,
        `pi-ensemble:driver-event v1 kind=crash issue=${ctx.issue} at=${new Date().toISOString()}\npi-ensemble /work driver halted on issue #${ctx.issue}: pipelineState.currentStep has unknown value ${JSON.stringify(decision.value)}. ` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh.`,
      );
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
      await writeState(ctx.repoRoot, state);
    }
  }

  // Clear footer cursor (PR2 O2).
  workWidget.clear(ctx.issue);

  // Cleanup scratch dir on success only — handoff/aborted keep the dir
  // so the user can inspect artifacts from failures.
  const final = state.pipelineState.status;
  if (final === "merged") {
    await teardownWorkspaceTmp(ctx.repoRoot, ctx.issue);
  }

  // #580 — write-ahead guard: write handoffDeliveredAt before notifyAgent so
  // a crash between write and send does not cause re-delivery on restart.
  if (final === "merged") {
    notifyAgent(ctx.pi, `pi-ensemble /work for issue #${ctx.issue} — MERGED ✓`);
  } else if (final === "handoff" || final === "aborted") {
    if (!state.pipelineState.handoffDeliveredAt) {
      const msg = renderHandoffUserMessage(
        state,
        ctx.repoRoot,
        scratchDir(ctx.repoRoot, ctx.issue),
      );
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, handoffDeliveredAt: new Date().toISOString() },
      };
      await writeState(ctx.repoRoot, state);
      notifyAgent(ctx.pi, msg);
    }
  }
  return { started: true };
}

/**
 * #573 — attempt reattach in the crash-resume path. Returns whether the
 * resumed child produced a valid result (skip runStep) and the updated state.
 *
 * The resume path reads `transcriptPath` from the in-flight `dispatch-started`
 * event, calls `resolveReattach` to check if reattach is possible, and
 * `attemptReattach` to actually reconnect. On success, emits a
 * `dispatch-completed` event and advances to the next step.
 */
