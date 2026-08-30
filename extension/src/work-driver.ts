/**
 * /work driver — the deterministic orchestrator for compiled /work cycles.
 *
 * Replaces PM-as-orchestrator with code-as-orchestrator for /work (and ONLY
 * /work — /research, /audit, /plan, /review, /start stay prose-driven; see
 * the plan file's command taxonomy table). The driver:
 *
 *   1. owns the step transition table — this module IS the definition of a
 *      /work cycle; #393 deleted the prose flow it was originally derived from,
 *   2. dispatches subagents directly via `dispatchCore()` (ownerKind:driver),
 *   3. persists every transition to `.pi/work-state/<issue>.json` via
 *      `writeState()`,
 *   4. surfaces step-level progress to the user by `notifyAgent()` —
 *      PM stays as the chat-side reporter, not the loop runner.
 *
 * ## Design axioms (from the determinism research synthesis)
 *
 * - **TS owns transitions; prose owns judgement.** The driver routes on
 *   structured-output fields produced by subagents (e.g.,
 *   `adversarial_loop` returns "APPROVED"/"ISSUES_FOUND"/"CRITICAL"). Fuzzy
 *   doctrine like "findings cluster around a theme" is decided by an
 *   @explore step-back call that returns a structured spec-element
 *   identification, not by the driver inferring themes.
 *
 * - **Driver-owned dispatch.** Every dispatch uses
 *   `dispatchCore(pi, spec, { … })` which sets `ownerKind:"driver"` so the
 *   async-jobs steer back to PM is skipped. The driver awaits the
 *   completion promise and routes the result through its own state
 *   machine. PM never sees an `[ensemble:async]` it didn't ask for.
 *
 * - **Resume-on-restart, NOT resume-of-in-flight.** v1 is observational:
 *   if the Pi process dies mid-dispatch, the driver on restart detects an
 *   orphan `dispatch-started` event in the log without a matching
 *   completion and HALTS, asking the user to inspect the worktree. Auto-
 *   replay of partial dispatches is a v2 concern (would require async-jobs
 *   to durably journal too).
 *
 * - **Cap-state lives in the work-state file.** `reviewRound` and
 *   `reviewCapStartedAt` are persisted to `pipelineState`; the driver
 *   enforces caps directly without going through the legacy
 *   `check_review_cap` tool, which the PM-driven commands still use.
 *
 * ## Status
 *
 * All 9 steps (explore, plan, branch, develop, adversarial, commit-pr,
 * lens-review/lens-fix/step-back, ci, merged/handoff) are wired. This file
 * itself holds only the `runStep` dispatch table and the `runWorkDriver`
 * main loop — each step's implementation lives in its own
 * `work-driver-<step>.ts` file (issue #171 file-size hygiene); `runStep`
 * imports and dispatches to them.
 */

import { notifyAgent } from "./agent-message.ts";
import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import { runAdversarial } from "./work-driver-adversarial.ts";
import { checkAttentionLabel } from "./work-driver-attention.ts";
import { runBranch, runDevelop } from "./work-driver-branch-develop.ts";
import { checkpointCapedDispatch } from "./work-driver-cap-checkpoint.ts";
import { runCommitPr } from "./work-driver-commit.ts";
import { type DriverContext, STEP_ORDINAL, nextStep } from "./work-driver-context.ts";
import { countPriorStepStarts } from "./work-driver-diff.ts";
import { runExplore } from "./work-driver-explore.ts";
import { renderHandoffUserMessage } from "./work-driver-handoff-message.ts";
import { runHandoff } from "./work-driver-handoff.ts";
import { runLens, runLensFix } from "./work-driver-lens.ts";
import { runMerged } from "./work-driver-merged.ts";
import { runPlan } from "./work-driver-plan.ts";
import { claimCycle } from "./work-driver-registry.ts";
import {
  classifyRunningState,
  clearForResume,
  explainRefusal,
  explainResume,
  resumeEnabled,
} from "./work-driver-resume.ts";
import { routeStepOutcome } from "./work-driver-step-router.ts";
import { runCi, runStepBack } from "./work-driver-stepback-ci.ts";
import { scratchDir, setupWorkspaceTmp, teardownWorkspaceTmp } from "./work-driver-workspace.ts";
import { runWorktreeSweep } from "./work-driver-worktree-sweep.ts";
import * as workWidget from "./work-widget.ts";
import { validateDiscriminants } from "./workflow-state-validate.ts";
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
 * Run the driver loop for one /work cycle. Reads / creates the state file,
 * loops over steps via `nextStep()`, persists after every transition,
 * surfaces final outcome (handoff or merged) to the user via
 * `pi.sendUserMessage`.
 *
 * Fire-and-forget contract: callers in `commands.ts` start this via
 * `void runWorkDriver(...).catch(reportFatal)`. The handler returns
 * immediately; the loop runs in the background.
 *
 * Every step is wired. A step body that throws `DriverNotImplementedError`
 * aborts the cycle and hands off — #393 removed the prose flow that used to
 * absorb that case, and silently continuing past an unimplemented step would
 * be worse than stopping.
 */
/**
 * Run one /work cycle, holding an in-process claim on every issue it covers.
 *
 * The claim closes a hole the on-disk owner check structurally cannot: that
 * check excludes `owner.pid === selfPid` so a driver can resume its own crashed
 * state, which means two cycles started from the SAME process never refuse each
 * other. Harmless while only a human typing `/work` could start one; not
 * harmless once a tool can, because an LLM can call a tool twice.
 */
/**
 * What a `runWorkDriver` call actually did.
 *
 * It used to return `Promise<void>`, and five of its early exits resolve in
 * ~0 ms without running a cycle at all — a claim conflict, another live pid, a
 * terminal state, an attention label, or state-file inconsistencies. The queue
 * could not tell those apart from a cycle that ran and parked, so it read the
 * OTHER cycle's mid-flight state file and reported it as this group's outcome,
 * complete with a `--restart` recommendation that would have raced fresh jobs
 * against live ones.
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
    notifyAgent(
      ctx.pi,
      `pi-ensemble: /work for issue #${ctx.issue} already terminated as ${terminalStatus}. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with --restart:\n  /work ${ctx.issue} --restart\nOr rm ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json manually. The prior cycle's event log is preserved in the state file until you restart or remove it.`,
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

  // #382 — a `running` state file means one of three things, and the driver
  // used to conflate all of them into "just keep going". Either another
  // process owns this cycle (refuse — two drivers on one branch interleave
  // commits), or the previous run died mid-dispatch (resume at that step), or
  // it is a clean step boundary (continue as before).
  if (resumeEnabled() && ctx.restart !== true) {
    const verdict = classifyRunningState(state);
    if (verdict.action === "refuse") {
      notifyAgent(ctx.pi, explainRefusal(ctx.issue, verdict.ownerPid));
      return {
        started: false,
        reason: `another live process (pid ${verdict.ownerPid}) owns this cycle`,
      };
    }
    if (verdict.action === "resume") {
      notifyAgent(ctx.pi, explainResume(ctx.issue, verdict.step, verdict.jobIds.length));
      // The orphaned `dispatch-started` events stay in the log — they are the
      // only record that a dispatch was paid for and lost.
      state = clearForResume(state);
    }
  }

  // #533 — refuse to reconstruct on an unrecognised discriminant. Applied on
  // the RESUME path only: `readState` stays permissive so a terminal state
  // file (merged/handoff/aborted) with an unknown event kind still renders in
  // /work-status — a parked cycle's history must stay observable. A
  // `running` file that fails this check is refused before any dispatch or
  // resume, first line naming the field and the value.
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

  // Detect a half-written state (resume hazard). v1 policy: refuse to
  // resume cleanly; surface to user and halt.
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

  // PR2 fold-in (post-#553 cleanup): set up the project-local scratch
  // dir + ensure tmp/ is in .git/info/exclude so subagents have a known
  // hygienic place to write diff snapshots, screenshots, capture
  // scripts, analysis outputs. The inline prompts thread the absolute
  // path into each subagent's instructions.
  const tmpDir = await setupWorkspaceTmp(ctx.repoRoot, ctx.issue);
  trace(`work-driver: scratch dir for issue #${ctx.issue}: ${tmpDir}`);

  let safety = 0;
  while (state.pipelineState.status === "running") {
    safety++;
    if (safety > 64) {
      // Defence against an unbounded transition loop — never expected to
      // fire under normal use (each step settles or escalates to handoff).
      // If it does fire, the state file captures the path so the user can
      // inspect.
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
    // Step-level lifecycle event (PR2 O1): emits "▶ step N/9 X started"
    // to scrollback BEFORE the step body runs. Adversarial and lens-
    // review steps that bypass dispatchCore (and therefore don't fire
    // per-dispatch lifecycle events) become visible here.
    const stepOrd = STEP_ORDINAL[step] ?? { num: 0, total: 9 };
    const stepStartedAt = Date.now();
    // PR4 sub-round labels: steps that iterate (adversarial / lens-review /
    // lens-fix / re-entered develop) get a `(round N)` suffix in scrollback
    // so the user can distinguish first-pass from third-pass at a glance.
    // First entry (round=1) shows no suffix — formatLine suppresses it.
    const stepRound = countPriorStepStarts(state, step) + 1;
    lifecycle.emitStepStarted(step, stepOrd.num, stepOrd.total, stepRound, ctx.issue);
    // PR2 O2: update the footer status cursor — distinct from the deck,
    // which shows individual subagent children. The cursor shows the
    // driver's step-level position with live-tick elapsed.
    workWidget.update(state, stepStartedAt);
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
        lifecycle.emitStepFailed(
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
      lifecycle.emitStepFailed(
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
    // Step completed — emit the scrollback lifecycle line, then apply
    // the PR5 single-dispatch + PR7 multi-workstream halt-cascade
    // routers. See work-driver-step-router.ts for the full routing
    // logic; `retry: true` means the router already persisted state and
    // this loop iteration should re-enter without reaching nextStep().
    const routed = await routeStepOutcome(ctx, state, step, stepOrd, stepRound, stepStartedAt);
    state = routed.state;
    // #543 F5 — driver-owned checkpoint after a dispatch-cap kill. Must stay
    // BEFORE the `routed.retry` continue so a retried step never checkpoints
    // the same kill twice. Never throws; failure degrades to the uncommitted.
    state = await checkpointCapedDispatch(ctx, state, step);
    if (routed.retry) continue;

    // Capture which step just completed BEFORE the nextStep transition
    // clobbers currentStep. This is the routing input the adversarial-
    // approved branch needs to distinguish "from develop" vs "from
    // lens-fix" (PR #239 routed on currentStep which was already wrong).
    const completedStep = state.pipelineState.currentStep;
    const decision = nextStep(state);
    if (decision.kind === "done") break;
    // #533 — a state whose `currentStep` is not a WorkStep is not something
    // the driver can route. Halt naming the field and value, reusing the
    // inspect-or-rm idiom of the inconsistency halt above; the 64-iteration
    // safety counter below is no longer the failure surface.
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
        `pi-ensemble /work driver halted on issue #${ctx.issue}: pipelineState.currentStep has unknown value ${JSON.stringify(decision.value)}. ` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
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

  // Clear the footer status cursor (PR2 O2). Stale cursors after a
  // cycle ends are worse than no cursor — the user might think a /work
  // is still running when it isn't.
  workWidget.clear(ctx.issue);

  // Cleanup scratch dir on success only — handoff/aborted KEEP the dir
  // so the user can inspect what the agents produced when something
  // went wrong. Failure modes (no dir, perm error) log via trace and
  // continue silently — final user message is the priority.
  const final = state.pipelineState.status;
  if (final === "merged") {
    await teardownWorkspaceTmp(ctx.repoRoot, ctx.issue);
  }

  // PR5: rich operator handoff message. Replaces the PR4-and-earlier
  // ~150-char pointer-to-JSON. The aborted status (set by the halt-
  // cascade router in the post-step block) routes through the SAME
  // renderer as handoff — the cap-hit event already encodes whether
  // this was a mid-flight failure or a cap-hit, and renderHandoffUserMessage
  // distinguishes them.
  if (final === "merged") {
    notifyAgent(ctx.pi, `pi-ensemble /work for issue #${ctx.issue} — MERGED ✓`);
  } else if (final === "handoff" || final === "aborted") {
    notifyAgent(
      ctx.pi,
      renderHandoffUserMessage(state, ctx.repoRoot, scratchDir(ctx.repoRoot, ctx.issue)),
    );
  }
  return { started: true };
}
