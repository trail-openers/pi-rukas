/**
 * /work driver — the deterministic orchestrator for compiled /work cycles.
 *
 * Replaces PM-as-orchestrator with code-as-orchestrator for /work (and ONLY
 * /work — /research, /audit, /plan, /review, /start stay prose-driven; see
 * the plan file's command taxonomy table). The driver:
 *
 *   1. owns the step transition table (walked from `pi-prompts/work.md`),
 *   2. dispatches subagents directly via `dispatchCore()` (ownerKind:driver),
 *   3. persists every transition to `.pi/work-state/<issue>.json` via
 *      `writeState()`,
 *   4. surfaces step-level progress to the user by `pi.sendUserMessage()` —
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
 *   `check_review_cap` tool. The tool remains for PM-driven /work cycles
 *   (PI_ENSEMBLE_WORK_DRIVER=0 fallback).
 *
 * ## Feature flag
 *
 * `PI_ENSEMBLE_WORK_DRIVER=0` bypasses the driver entirely and falls back
 * to the legacy PM-driven flow (`pi.sendUserMessage(work.md)`). Default is
 * ON in v1. See `commands.ts:registerCommands` for the dispatch.
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

import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import { runAdversarial } from "./work-driver-adversarial.ts";
import { runBranch, runDevelop } from "./work-driver-branch-develop.ts";
import { runCommitPr } from "./work-driver-commit.ts";
import { type DriverContext, STEP_ORDINAL, nextStep } from "./work-driver-context.ts";
import { countPriorStepStarts } from "./work-driver-diff.ts";
import { runExplore } from "./work-driver-explore.ts";
import { renderHandoffUserMessage } from "./work-driver-handoff-message.ts";
import { runHandoff } from "./work-driver-handoff.ts";
import { runLens, runLensFix } from "./work-driver-lens.ts";
import { runMerged } from "./work-driver-merged.ts";
import { runPlan } from "./work-driver-plan.ts";
import { routeStepOutcome } from "./work-driver-step-router.ts";
import { runCi, runStepBack } from "./work-driver-stepback-ci.ts";
import { scratchDir, setupWorkspaceTmp, teardownWorkspaceTmp } from "./work-driver-workspace.ts";
import * as workWidget from "./work-widget.ts";
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
 * Status: skeleton — only `explore`, `plan`, `handoff`, and `merged` are
 * wired today. Other steps throw `DriverNotImplementedError`; the handler
 * catches and falls back to the legacy work.md flow until the rest of the
 * step bodies land.
 */
export async function runWorkDriver(ctx: DriverContext): Promise<void> {
  // PR12 — `/work N --restart`: skip readState and start fresh from
  // `initialState(issue)`. Used after the operator revises the issue
  // body via /plan (or gh issue edit) following a prior terminal cycle
  // (handoff / aborted / merged). Branch step's existing-branch logic
  // handles worktree leftovers at runtime; this flag only wipes the
  // driver's state file.
  let state =
    ctx.restart === true
      ? initialState(ctx.issue)
      : ((await readState(ctx.repoRoot, ctx.issue)) ?? initialState(ctx.issue));
  if (ctx.restart === true) {
    trace(`work-driver: --restart wiped state for issue #${ctx.issue} (fresh cycle)`);
  }
  // PR10 — persist the full multi-issue list on first run. On resume,
  // honour what's already in the file (the user may have continued a
  // single-issue cycle by re-invoking /work N; we don't widen scope
  // silently). Only fresh state files (issues===undefined) take the
  // ctx.issues list. On --restart, the freshly-initialised state has
  // issues===undefined so the ctx.issues list flows through.
  if (ctx.issues && ctx.issues.length > 0 && state.issues === undefined) {
    state = { ...state, issues: ctx.issues };
  }

  // PR12 — surface a clear notify when /work re-invocation finds the
  // state already terminal (handoff / aborted / merged) and the
  // operator didn't pass --restart. Pre-PR12 this silently fell
  // through to the end of the function — the operator saw nothing
  // and PM ended up recommending /do as a workaround.
  if (state.pipelineState.status !== "running" && ctx.restart !== true) {
    const terminalStatus = state.pipelineState.status;
    ctx.pi.sendUserMessage(
      `pi-ensemble: /work for issue #${ctx.issue} already terminated as ${terminalStatus}. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with --restart:\n  /work ${ctx.issue} --restart\nOr rm ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json manually. The prior cycle's event log is preserved in the state file until you restart or remove it.`,
    );
    return;
  }

  // Detect a half-written state (resume hazard). v1 policy: refuse to
  // resume cleanly; surface to user and halt.
  const inconsistencies = detectInconsistencies(state);
  if (inconsistencies.length > 0) {
    const detail = inconsistencies.join("\n  - ");
    trace(`work-driver: state inconsistencies detected for issue ${ctx.issue}:\n  - ${detail}`);
    ctx.pi.sendUserMessage(
      `pi-ensemble /work driver halted on issue #${ctx.issue}: state-file inconsistencies detected.\n  - ${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
    );
    return;
  }

  // Persist the initial state on first run so the user can see the file
  // appear and PI_ENSEMBLE_WORK_DRIVER=0 fallback knows a cycle exists.
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
      ctx.pi.sendUserMessage(
        `pi-ensemble /work driver aborted on issue #${ctx.issue}: transition safety limit reached. ` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json for the state.`,
      );
      return;
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
    lifecycle.emitStepStarted(step, stepOrd.num, stepOrd.total, stepRound);
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
        );
        ctx.pi.sendUserMessage(
          `pi-ensemble /work driver halted: step "${err.step}" not yet implemented in this build. Run with PI_ENSEMBLE_WORK_DRIVER=0 to use the legacy PM-driven flow.`,
        );
        return;
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
      );
      ctx.pi.sendUserMessage(
        `pi-ensemble /work driver aborted on step "${step}" for issue #${ctx.issue}: ` +
          `${(err as Error).message}`,
      );
      return;
    }
    // Step completed — emit the scrollback lifecycle line, then apply
    // the PR5 single-dispatch + PR7 multi-workstream halt-cascade
    // routers. See work-driver-step-router.ts for the full routing
    // logic; `retry: true` means the router already persisted state and
    // this loop iteration should re-enter without reaching nextStep().
    const routed = await routeStepOutcome(ctx, state, step, stepOrd, stepRound, stepStartedAt);
    state = routed.state;
    if (routed.retry) continue;

    // Capture which step just completed BEFORE the nextStep transition
    // clobbers currentStep. This is the routing input the adversarial-
    // approved branch needs to distinguish "from develop" vs "from
    // lens-fix" (PR #239 routed on currentStep which was already wrong).
    const completedStep = state.pipelineState.currentStep;
    const decision = nextStep(state);
    if (decision === "done") break;
    if (decision !== state.pipelineState.currentStep) {
      state = {
        ...state,
        pipelineState: {
          ...state.pipelineState,
          lastCompletedStep: completedStep,
          currentStep: decision,
        },
      };
      await writeState(ctx.repoRoot, state);
    }
  }

  // Clear the footer status cursor (PR2 O2). Stale cursors after a
  // cycle ends are worse than no cursor — the user might think a /work
  // is still running when it isn't.
  workWidget.clear();

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
    ctx.pi.sendUserMessage(`pi-ensemble /work for issue #${ctx.issue} — MERGED ✓`);
  } else if (final === "handoff" || final === "aborted") {
    ctx.pi.sendUserMessage(
      renderHandoffUserMessage(state, ctx.repoRoot, scratchDir(ctx.repoRoot, ctx.issue)),
    );
  }
}
