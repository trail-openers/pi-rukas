/**
 * work-driver-context — shared driver state/type foundation.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Every
 * step-handler file imports `DriverContext` from here; this file has no
 * dependency on any step-handler file, keeping it a clean leaf that the
 * rest of the driver module graph can sit on top of.
 *
 * Contains: the step display-ordinal table, the per-step failure policy,
 * the review/CI caps `nextStep()` enforces, the `DriverContext` shape
 * every step handler is dispatched with, and the `nextStep()` transition
 * table itself.
 */

import type { DispatchHost } from "./async-jobs-lifecycle.ts";
import type { LensReviewSummary } from "./lens-review.ts";
import { reviewWallClockMs } from "./review-budget.ts";
import type { OnSlowCallback } from "./slow-notice.ts";
import type { DispatchImage, DispatchResult, WriteFenceOpt } from "./types.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { DriverHost } from "./work-driver-host.ts";
import type { EmitSink } from "./work-state-emit.ts";
import { KNOWN_STATUSES } from "./workflow-state-validate.ts";
import { WORK_STEPS, type WorkState, type WorkStep } from "./workflow-state.ts";

/**
 * Display ordinal for the user-facing "step N/9" badge in scrollback /
 * widget output.
 * `plan` collapses without a dispatch but still gets a number for
 * consistency. Internal-only steps (handoff / merged / step-back) get
 * sequence numbers past 9 so the badge stays informative without lying
 * about the doctrine's named 9.
 */
export const STEP_ORDINAL: Record<string, { num: number; total: number }> = {
  explore: { num: 1, total: 9 },
  plan: { num: 2, total: 9 },
  branch: { num: 3, total: 9 },
  develop: { num: 4, total: 9 },
  adversarial: { num: 5, total: 9 },
  "commit-pr": { num: 6, total: 9 },
  "lens-review": { num: 7, total: 9 },
  "lens-fix": { num: 7, total: 9 }, // sub-step of 7
  "step-back": { num: 7, total: 9 }, // sub-step of 7
  ci: { num: 8, total: 9 },
  merged: { num: 9, total: 9 },
  handoff: { num: 9, total: 9 }, // terminal alternative to merged
};

/**
 * Maximum review-fix rounds before the driver halts and routes to the
 * cap-hit handoff path. Three rounds is the limit: past that the fix loop
 * has demonstrably stopped converging and a human should look.
 */
export const MAX_REVIEW_ROUNDS = 3;

/**
 * Maximum CI retry attempts before routing to handoff. Counts ci-status:
 * failure → develop transitions; 2 means up to 3 total CI attempts (the
 * first attempt + 2 retries). Added in PR2 after issue #553's live cycle
 * spun forever in ci → develop → adversarial → lens-review → ci when no
 * PR existed for CI to watch.
 */
export const MAX_CI_RETRIES = 2;

/**
 * The review-loop time ceilings live in `review-budget.ts` (#1429), which is
 * the only place either ceiling is stated. Re-exported so every existing
 * import path keeps working and `nextStep` below reads the resolved value.
 */
export {
  MIN_REVIEW_BUDGET_MS,
  REVIEW_CAP_DEFAULT_MS,
  REVIEW_CAP_ENV,
  REVIEW_WALL_CLOCK_ENV,
  REVIEW_WALL_CLOCK_MS,
  reviewCapMs,
  reviewWallClockMs,
} from "./review-budget.ts";

/**
 * Headless S4 (#1024) — the context a cycle runs with once `enterCycle` has
 * created its emit sink. `persistCycle` takes this shape (or a narrower Pick
 * of it), so a step that writes state cannot be compiled without a sink.
 */
export type CycleContext = DriverContext & { emitSink: EmitSink };

/**
 * #1414 — the shell-executor shape the driver's test seams accept, written
 * once so `verifyExecFn` and `checkpointExecFn` cannot drift.
 *
 * Round 2: this used to be a SECOND structural declaration of the same shape.
 * Two literals that must stay byte-equivalent is one more thing to forget — an
 * added option on `VerifyExecFn` would have left this one silently dropping it,
 * which is precisely the #1279 failure the `argv` field exists to prevent.
 * `work-driver-git.ts` is the leaf (its jsdoc header says so) and `VerifyExecFn`
 * is its one executor type, so this is an ALIAS of it: one declaration, and the
 * `satisfies` check there keeps `execp` honest against both names. A type-only
 * import pulls no runtime code, so the leaf-ness claimed above is unaffected.
 */
export type DriverExecFn = VerifyExecFn;

export interface DriverContext {
  /** The host the cycle runs in (#1020). Pi-session or a recording test host. */
  host: DriverHost;
  /** Project root (NOT a worktree). State file lives here. */
  repoRoot: string;
  /**
   * S4a (#1162) — this cycle's emit sink, passed to every `writeState`. Created
   * by `enterCycle` (work-driver-cycle-entry.ts); absent for a direct step call,
   * in which case persists write without emitting.
   */
  emitSink?: EmitSink;
  /**
   * Headless S4 (#1024) — aborted by the runner's SIGTERM / SIGINT handler (or
   * its `--timeout`). The driver checks it at each step boundary and records
   * the interrupt itself (work-driver-interrupt.ts); `signal.reason` is the
   * `interrupted` event's reason (`signal` or `timeout`).
   */
  signal?: AbortSignal;
  /**
   * Headless S4 (#1024) — true only for the headless runner: each child then
   * leads its own process group, so an interrupt reaches its grandchildren.
   * Interactive /work leaves it unset (Ctrl-C reaches the children as before).
   */
  processGroup?: boolean;
  /** Primary issue number — anchors state file path + branch name. For
   * multi-issue cycles this is `issues[0]`. */
  issue: number;
  /** PR10 — full list of issue numbers passed to /work. Optional for
   * back-compat; absent means single-issue (driver treats as [issue]). */
  issues?: number[];
  /**
   * Optional injection point for tests: replace dispatchCore with a fake.
   * Production callers omit this — the default is the real dispatchCore.
   */
  dispatchFn?: (
    host: DispatchHost,
    spec: {
      role: string;
      prompt: string;
      cwd?: string;
      images?: DispatchImage[];
      /** #573/#1789 — the caller's run id, which `runSingleDispatch` now sets to
       *  the dispatch's own jobId so the child's transcript names the driver
       *  dispatch that spawned it. `dispatchCore` already accepts it. */
      runId?: string;
    },
    opts?: WriteFenceOpt & {
      label?: string;
      skipDeck?: boolean;
      deck?: { cycleKey: string; label: string; deckLabel?: string }; // #838 — see dispatchCore
      timeoutMs?: number;
      childBoundMs?: number; // #1560 — the per-child run bound (spawn-child-bound.ts)
      /** #1024 — the cycle's abort, and whether the child leads its own group. */
      signal?: AbortSignal;
      processGroup?: boolean;
      onSlow?: OnSlowCallback;
    },
  ) => Promise<DispatchResult>;
  /**
   * PR11 — optional injection point for tests: replace the `gh issue view`
   * fetch in runExplore. Production callers omit this; the default
   * shells out via `execp("gh issue view <N>")`. Tests inject a fake to
   * simulate empty bodies / rejected fetches without mocking PATH.
   * Returns `{ stdout: string }` matching the execp shape.
   */
  issueBodyFetcherFn?: (issue: number, cwd: string) => Promise<{ stdout: string }>;
  /**
   * PR12 — when true, `runWorkDriver` skips `readState` and starts from
   * `initialState(issue)`. Set by `commands.ts` when the operator
   * passes `/work N --restart` to wipe a prior terminal cycle's state
   * and run fresh (e.g., after revising the issue body via /plan).
   * This flag only resets the driver's state file — it does NOT clean up
   * branches, worktrees, or an already-open PR. #362's branch-step
   * pre-flight halts when an open PR already covers the issue (#358
   * orphaned by #359). Omitted / false reads the existing state.
   */
  restart?: boolean;
  /** #1468 — `/work N --restart --continue-pr`: continue the issue's open PR. */
  continuePr?: boolean;
  /**
   * #380 — the operator's in-session grant of merge authority, from
   * `/work N --merge`. Merging is the one irreversible act in the cycle and
   * is opt-in: absent this flag the driver falls back to reading the
   * project's `AGENTS.md`, and absent a grant there too it opens the PR and
   * parks as `awaiting-human-merge`. There is deliberately no way to grant
   * authority implicitly — the absence of a prohibition is not permission.
   */
  mergeGrant?: boolean;
  /**
   * #1090 — protected paths the operator granted this cycle with
   * `/work N --allow-protected <path>`. Operator-only, like `mergeGrant`:
   * `start_work_driver` forces it empty, and nothing from the issue, explore
   * or the planner reaches it. The #406 gate reads it from here, never from
   * the state file, which records it only.
   */
  protectedGrant?: readonly string[];
  /**
   * #1362 — the project's `.pi/dirty-root-exempt` list, parsed once per cycle
   * before the branch step. Paths here are not repo-root dirt and are never
   * staged at repoRoot, which is how a tool's own local file
   * (`.claude/settings.local.json`) stops blocking a cycle.
   *
   * Carried on the context rather than read at module scope: up to
   * `PI_ENSEMBLE_PARALLEL_GROUPS` cycles run concurrently in one process and
   * each has its own project, so a shared list would leak exemptions between
   * them. Absent is an empty list — every consumer behaves as it did before
   * the file existed.
   */
  dirtyRootExempt?: readonly string[];
  /**
   * #1362 — set when reading `.pi/dirty-root-exempt` FAILED outright (any error
   * but ENOENT/ENOTDIR), as the error cause. Absent = the file read, or was
   * absent (the ordinary cases). The branch step's dirty-root block folds this
   * into its plumb report so the handoff says "the exemption file could not be
   * read" instead of only "your repo root is dirty"; the cycle log carries the
   * same event.
   */
  dirtyRootExemptReadFailed?: string;
  /**
   * #1427 — injectable process-tree walker for the gate-hang reports, threaded
   * from the verify seams down to `runVerifyCommandGate` and the consolidated
   * probe. Production leaves it unset and the real `ps` walk runs; smoke tests
   * inject one so a report's tree section is an assertion rather than whatever
   * else happens to be running on the host.
   */
  walkProcessTree?: (leaderPid: number) => {
    processes: import("./work-driver-gate-hang.ts").HangProcess[];
    treeUnavailable?: string;
  };
  /**
   * #1292 — the invoking session has no UI (`!ctx.hasUI`, e.g. `pi -p`). A
   * headless cycle opens its PR as a draft by default — nobody is watching
   * the review window — unless `PI_ENSEMBLE_DRAFT_PR` says otherwise.
   */
  headless?: boolean;
  /**
   * How many cycles this invocation runs at once. Set by the queue; the
   * single-issue path leaves it at 1.
   *
   * This is the ACTUAL concurrency of the run, not the configured cap:
   * `/work 123` runs one cycle whatever `PI_ENSEMBLE_PARALLEL_GROUPS` says,
   * and sizing decisions that key off the cap instead would degrade a
   * single-issue run for a pool it is not part of.
   */
  parallelCycles?: number;
  /**
   * #1093 — the operator's checkout read once per /work invocation, before any
   * sibling group started. Stamped as this cycle's start ref when present; the
   * per-cycle locked capture is the fallback (single-issue path).
   */
  invocationStartRef?: string;
  /**
   * Optional injection point for tests: replace runAdversarialLoop with a
   * fake. Production callers omit this — runAdversarial uses the real
   * orchestrator from adversarial.ts. Mirrors `dispatchFn` for symmetry.
   * Added in PR8 alongside the per-workstream adversarial fanout so the
   * smoke tests can validate fanout shape without spawning real Pi
   * children.
   */
  adversarialLoopFn?: (
    params: { diff: string; context: string; workCwd?: string; processGroup?: boolean },
    signal: AbortSignal,
    orchestratorJobId: string,
  ) => Promise<DispatchResult>;
  /**
   * PR17 — optional injection point for tests: replace the shell
   * executor used by verifyStepOutcome (git status / rev-list, the
   * project's verify command, gh pr view). Production callers omit
   * this; the default is `execp`. Mirrors `issueBodyFetcherFn`.
   */
  verifyExecFn?: DriverExecFn;
  /**
   * #1414 — optional test seam for the cap-kill checkpoint's TYPECHECK only
   * (`typecheckWorktree`). Default `execp`; like `verifyExecFn` but NARROWER:
   * the checkpoint's git calls keep calling `execp`, so a fake cannot make
   * `tree: "committed"` a tautology.
   */
  checkpointExecFn?: DriverExecFn;
  /** #1414 r3 — commit-only test seam; documented at its call site. */
  checkpointCommitFn?: DriverExecFn;
  /**
   * Optional injection point for tests: replace runLensReview with a fake.
   * Production callers omit this — runLens uses the real runLensReview.
   * Mirrors `adversarialLoopFn` for symmetry, but returns
   * `LensReviewSummary` (verdict, totalFindings, bySeverity, lenses,
   * findings), NOT `DispatchResult`.
   */
  lensReviewFn?: (opts: {
    diff: string;
    context?: string;
    cwd?: string;
    signal?: AbortSignal;
    processGroup?: boolean;
    evidence?: string;
    extraFindings?: import("./lens-review.ts").Finding[];
    threshold?: import("./lens-review.ts").Severity;
    branch?: string;
    pr?: number;
  }) => Promise<LensReviewSummary>;
  /**
   * #280 — optional injection point for tests: replace the vipune write
   * function used by the invariant-removal guard-memory path. Production
   * callers omit this; the default shells out to `vipune add`. Tests
   * inject a fake to assert on argv without forking vipune.
   */
  gvwmWriteFn?: (text: string, opts: { cwd: string; issue: number }) => Promise<{ id?: string }>;
  /**
   * #612 S4 task-b — optional injection point for tests: replace the forge
   * adapter used by `runHandoff`'s in-process gh fallback. Production
   * callers omit this; the driver resolves a fresh `Forge` via
   * `handoffForge` (work-driver-handoff.ts). Tests inject a fake to drive
   * the fallback path without a real `gh` binary.
   */
  forge?: import("./forge.ts").Forge;
  /**
   * @internal / test-only. Optional injection point for tests: replace the
   * merge-authority policy judge built by `judgePolicy` in the merged step.
   * Production callers omit this and get the real `judgePolicy` (a
   * `spawnSpecialist` child); tests inject a fake to distinguish "the doctrine
   * was unreadable" from "the judge is switched off for the whole process" —
   * which is what made the doctrine-denial case vacuous. Mirrors
   * `adversarialLoopFn` / `lensReviewFn`.
   *
   * NOT a host knob. `runHeadless` forwards this field, so an exported-API
   * caller could otherwise speak for the merge-authority gate; `runMerged`
   * honours it only when `PI_ENSEMBLE_FORBID_LIVE_SPAWN=1` (which the offline
   * suite sets) and traces a warning when it does. See `mergeAuthorityJudge`
   * in `work-driver-merged.ts`.
   */
  policyJudgeFn?: import("./work-driver-policy.ts").PolicyJudgeFn;
  /**
   * #1189 — the driver's in-memory terminal state, handed to the caller for
   * the disk-vs-memory divergence check. The state file lives inside the tree
   * agents work in (same user), so the runner needs its own trusted copy.
   * Invoked at most once per cycle, never on a crashed driver; `undefined`
   * means the driver never reached a terminal boundary. Production callers
   * omit this; the headless runner passes one (see work-driver-final-state.ts).
   */
  onFinalState?: (state: WorkState) => void;
}

/**
 * #533 — the transition table's answer, made total. Pre-#533 an unknown
 * `pipelineState.currentStep` reached the linear table's `Record<WorkStep, …>`
 * lookup, got `undefined`, and the driver loop's 64-iteration safety counter
 * fired with a message naming no field. The unknown case is now its own member:
 * the driver halts naming `pipelineState.currentStep`, and a loop that spins can
 * only do so by repeatedly RUNNING a real step, which the safety counter bounds.
 */
export type StepDecision =
  | { kind: "step"; step: WorkStep }
  | { kind: "done" }
  | { kind: "unknown-step"; value: unknown };

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

/** Decide the next step from the current step + just-appended events. */
export function nextStep(state: WorkState): StepDecision {
  const ps = state.pipelineState;
  if (ps.status !== "running") return { kind: "done" };
  const lastEvent = state.eventLog[state.eventLog.length - 1];

  // #533 — the driver's pre-loop validator (validateDiscriminants) refuses to
  // resume a `running` state on an unknown currentStep/status, so these checks
  // are the in-memory backstop: an unknown value is a distinct answer, not a
  // `Record` lookup miss.
  if (!WORK_STEPS.includes(ps.currentStep as WorkStep)) {
    return { kind: "unknown-step", value: ps.currentStep };
  }
  if (!KNOWN_STATUSES.includes(ps.status)) {
    return { kind: "unknown-step", value: ps.status };
  }

  // A cap-hit routes to `handoff`, `step-back` or `ci`, regardless of which
  // step emitted it: the driver records the decision in the event itself, so
  // this stays a lookup rather than a second place that can disagree. `ci` is
  // the round cap's non-critical exit (see `appendReviewCapHit`) — a review
  // that ran out of rounds with the adversarial gate approving and its residual
  // findings posted goes on to CI and the merge-authority gate, instead of
  // parking work a human then judges merge-worthy anyway.
  //
  // ORDER IS LOAD-BEARING: this check runs BEFORE the terminal
  // short-circuits below. runMerged's merge-hold sets currentStep="merged"
  // and appends `cap-hit{awaiting-human-merge, nextStep:"handoff"}` — with
  // the old order the short-circuit answered "done" first, the loop exited
  // with status still "running", and the declared handoff never ran: no
  // comment, no label, no operator notification, and the queue read the
  // cycle as "still running". Measured: 25 of 240 cycles (10.4%) on this
  // host were stuck in exactly that shape, and 0 of 221 post-schema cycles
  // ever terminalized cleanly through the merge gate.
  if (lastEvent?.kind === "cap-hit") return { kind: "step", step: lastEvent.nextStep };

  // Terminal short-circuits (genuine terminals only — a trailing cap-hit
  // always carries its own routing and is handled above).
  if (ps.currentStep === "merged" || ps.currentStep === "handoff") return { kind: "done" };

  // #1114 — a parsed non-approving verdict routes that workstream back to
  // develop as a fix pass; the develop step answers with its own gates.
  if (lastEvent?.kind === "adversarial-fix-requested") return { kind: "step", step: "develop" };
  // A passing fix pass returns the workstream to the review gate explicitly —
  // not by falling through the linear table, which keys on currentStep and
  // would silently change if the fix pass ever left currentStep elsewhere.
  if (lastEvent?.kind === "adversarial-fix-applied") return { kind: "step", step: "adversarial" };

  // Adversarial verdict routes the next step.
  if (lastEvent?.kind === "adversarial-approved") {
    // The post-adversarial transition depends on what step we came FROM,
    // not what step we ARE — by the time this check fires, `currentStep`
    // has already been clobbered to "adversarial" by runAdversarial. The
    // original PR #239 read `ps.currentStep === "develop"` which was
    // always false here and silently routed every adversarial-approved to
    // lens-review, skipping commit-pr. PR2 routes on lastCompletedStep:
    //  - From "develop" → "commit-pr" (the happy path after first dev).
    //  - From "lens-fix" → "lens-review" (re-verify the fix loop).
    return ps.lastCompletedStep === "develop"
      ? { kind: "step", step: "commit-pr" }
      : { kind: "step", step: "lens-review" };
  }
  if (lastEvent?.kind === "adversarial-rejected") {
    // adversarial_loop already did 3 internal rounds and STILL rejected →
    // this is a cap-hit. The driver emits the cap-hit event in the same
    // transition; the cap-hit branch above handles routing.
    return { kind: "step", step: "handoff" };
  }

  // Lens-review verdict routes.
  if (lastEvent?.kind === "lens-approved") return { kind: "step", step: "ci" };
  if (lastEvent?.kind === "lens-issues-found") {
    // A capped review never reaches here: `appendReviewCapHit` appends a
    // cap-hit AFTER the lens-issues-found event, and the cap-hit branch above
    // is what routes it — including to "ci" for a round cap on a non-critical
    // verdict whose findings were disclosed on the PR. These two checks are
    // the uncapped fallback, and both must stay pessimistic: a tail that
    // somehow reached the cap without a cap-hit recorded has nothing that says
    // where it should go, and "stop" is the only safe answer to that.
    if (ps.reviewRound >= MAX_REVIEW_ROUNDS) return { kind: "step", step: "handoff" };
    if (ps.reviewCapStartedAt && Date.now() - ps.reviewCapStartedAt > reviewWallClockMs()) {
      return { kind: "step", step: "handoff" };
    }
    return { kind: "step", step: "lens-fix" };
  }

  // Step-back completes → emit handoff with the spec analysis attached.
  if (lastEvent?.kind === "step-back-completed") return { kind: "step", step: "handoff" };

  // A failing full verification is a failing verification.
  //
  // `runCi` runs `.pi/verify-cmd-full` before watching CI — strictly more than
  // CI does — and on failure appends this event WITHOUT a `ci-status`, on the
  // stated assumption that "the ci-retry cap will fire on the next iteration".
  // There is no next iteration: with no branch here the tail fell through to
  // the linear table, where `ci: "merged"`. A diff whose full verification
  // failed went to merged, on every cycle, because the check is opt-out and
  // this repo ships the file.
  //
  // Deliberately routed identically to `ci-status`, not merged into it: the two
  // events mean different things, and `verify-full-status` carries the
  // `evidenceTail` that says what actually broke.
  if (lastEvent?.kind === "verify-full-status" && lastEvent.status === "failure") {
    if ((ps.ciRetryCount ?? 0) >= MAX_CI_RETRIES) return { kind: "step", step: "handoff" };
    return { kind: "step", step: "develop" };
  }

  // CI outcomes.
  if (lastEvent?.kind === "ci-status") {
    if (lastEvent.status === "success") return { kind: "step", step: "merged" };
    if (lastEvent.status === "failure") {
      // The re-fix loop. Cap at MAX_CI_RETRIES so a permanently-failing CI
      // (e.g., branch step ABORTed and no PR exists for CI to watch — see
      // issue #553) can't spin develop → adversarial → review → ci forever.
      // The runCi step body bumps ciRetryCount when it appends the
      // ci-status event; this check just routes on the post-bump value.
      if ((ps.ciRetryCount ?? 0) >= MAX_CI_RETRIES) return { kind: "step", step: "handoff" };
      return { kind: "step", step: "develop" };
    }
    // "pending" — caller decides whether to poll again; for v1 we just stay.
    return { kind: "step", step: "ci" };
  }

  // Linear happy-path transitions when no special event fired. The lookup
  // can no longer miss: `ps.currentStep` was membership-checked above.
  const linear: Record<WorkStep, WorkStep> = {
    explore: "plan",
    plan: "branch",
    branch: "develop",
    develop: "adversarial",
    adversarial: "commit-pr",
    "commit-pr": "lens-review",
    "lens-review": "ci",
    "lens-fix": "adversarial",
    "step-back": "handoff",
    handoff: "handoff",
    ci: "merged",
    merged: "merged",
  };
  return { kind: "step", step: linear[ps.currentStep] };
}
