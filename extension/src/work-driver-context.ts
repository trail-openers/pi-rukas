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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LensReviewSummary } from "./lens-review.ts";
import type { DispatchResult } from "./types.ts";
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
 * Wall-clock cap for the entire fix loop (lens-review → developer-fix →
 * adversarial → re-review). 90 minutes, same as legacy review-cap.ts.
 * Persisted in `pipelineState.reviewCapStartedAt` so it survives restart.
 */
export const REVIEW_WALL_CLOCK_MS = 90 * 60 * 1000;

/**
 * Per-step failure policy (PR5 halt-cascade prevention).
 *
 * Background: PR #239 driver continued past `dispatch-failed` because
 * `nextStep()` has no branch for that event kind — the linear table just
 * advanced. On nessie #553, a developer SIGTERM at 30 min cascaded into
 * 2h31m of adversarial review against partial work, then 40 min of
 * provider-timeouting handoff. ~4 hours wasted, opaque outcome.
 *
 * The fix is a routing classifier: when a step body's tail event is
 * `dispatch-failed` (or `dispatch-failed-provider`), the driver loop
 * consults this table BEFORE calling `nextStep()`:
 *
 *  - **HALT**: synthesise a cap-hit `step-failed:<step>` (or the special
 *    `developer-timeout` shape when the errorTail matches the spawn
 *    timeout marker), set `status='aborted'`, route to handoff. There
 *    is no useful downstream past a HALT failure.
 *  - **RETRY_ONCE**: re-run the same step body once. Idempotent steps
 *    (adversarial loop against a stable diff, lens-review 6-way fanout)
 *    can absorb transient provider transport errors. Second failure
 *    HALTs via the same path.
 *  - **DEGRADED_OK**: the existing fall-through to `nextStep()` is fine.
 *    Step-back (informational) and the terminal steps (handoff, merged)
 *    fit here.
 *
 * The verdict paths (adversarial-rejected → cap-hit handoff, the lens
 * round cap → whatever destination `appendReviewCapHit` recorded on the
 * event) are unchanged — those route correctly already. This table only
 * governs dispatch-failed at the step level.
 */
export type StepFailurePolicy = "HALT" | "RETRY_ONCE" | "DEGRADED_OK";

export const STEP_FAILURE_POLICY: Record<WorkStep, StepFailurePolicy> = {
  // No spec foundation → plan/branch/develop run blind.
  explore: "HALT",
  // No workstreams → silent regression to single-task develop without
  // out-of-scope fences (PR3 doctrine violated).
  plan: "HALT",
  // No branch → develop edits HEAD, commit-pr has nothing to push, CI
  // has nothing to watch. Was the empirical root of issue #553's first
  // run cascade.
  branch: "HALT",
  // Partial uncommitted work after SIGTERM is not adversarial-reviewable.
  // For N>1 workstreams: HALT if ANY branch failed (runDevelop's
  // Promise.allSettled aggregate is the failure signal).
  develop: "HALT",
  // Internal 3-round loop is idempotent against a stable diff; transient
  // transport is realistic. Second failure HALTs. The
  // REJECTED-after-3-rounds verdict path already routes correctly to
  // handoff via cap-hit — unchanged.
  adversarial: "RETRY_ONCE",
  // No PR → lens-review wastes hours on uncommitted work, CI retries
  // to no purpose. Was a contributing factor in the #553 spin.
  "commit-pr": "HALT",
  // 6 lens children against a stable diff are idempotent. Cannot ship
  // code that bypassed lens-review.
  "lens-review": "RETRY_ONCE",
  // Same shape as develop — partial fix work cannot meaningfully re-
  // enter adversarial→lens.
  "lens-fix": "HALT",
  // Output is informational; an empty step-back reply still produces a
  // useful handoff.
  "step-back": "DEGRADED_OK",
  // Silently marking a cycle merged when CI was never checked is the
  // worst possible outcome. Marker-missing-but-ops-ran is already
  // handled via ciRetryCount (PR2).
  ci: "HALT",
  // Must never halt the loop — IS the loop terminator. PR5 hardens
  // handoff itself via in-process gh fallback (see runHandoff).
  handoff: "DEGRADED_OK",
  // PR10: was DEGRADED_OK while runMerged was a 0ms state mutation; now
  // it actually dispatches ops to run `gh pr merge`, which CAN fail
  // (auth, branch protection, conflicts). Silently flipping status to
  // 'merged' on dispatch failure would be exactly the bug PR10 fixes
  // (the empirical /work 561/562 case: driver reported MERGED ✓ while
  // PRs sat OPEN on GitHub). HALT routes the failure through cap-hit
  // 'step-failed:merged' → handoff so the operator merges manually.
  merged: "HALT",
};

export interface DriverContext {
  pi: ExtensionAPI;
  /** Project root (NOT a worktree). State file lives here. */
  repoRoot: string;
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
    pi: ExtensionAPI,
    spec: { role: string; prompt: string; cwd?: string },
    opts?: { label?: string; skipDeck?: boolean; timeoutMs?: number },
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
   * branches, worktrees, or an already-open PR. #362 adds a branch-step
   * pre-flight that halts when an open PR already covers the issue,
   * because wiping state alone made the driver rebuild #5 from scratch
   * and open a duplicate PR (#358 orphaned by #359). Default behaviour
   * (omitted / false) reads the existing state if present.
   */
  restart?: boolean;
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
   * Optional injection point for tests: replace runAdversarialLoop with a
   * fake. Production callers omit this — runAdversarial uses the real
   * orchestrator from adversarial.ts. Mirrors `dispatchFn` for symmetry.
   * Added in PR8 alongside the per-workstream adversarial fanout so the
   * smoke tests can validate fanout shape without spawning real Pi
   * children.
   */
  adversarialLoopFn?: (
    params: { diff: string; context: string; workCwd?: string },
    signal: AbortSignal,
    orchestratorJobId: string,
  ) => Promise<DispatchResult>;
  /**
   * PR17 — optional injection point for tests: replace the shell
   * executor used by verifyStepOutcome (git status / rev-list, the
   * project's verify command, gh pr view). Production callers omit
   * this; the default is `execp`. Mirrors `issueBodyFetcherFn`.
   */
  verifyExecFn?: (
    cmd: string,
    opts?: {
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      shell?: string;
    },
  ) => Promise<{ stdout: string; stderr?: string }>;
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
  }) => Promise<LensReviewSummary>;
  /**
   * #280 — optional injection point for tests: replace the vipune write
   * function used by the invariant-removal guard-memory path. Production
   * callers omit this; the default shells out to `vipune add`. Tests
   * inject a fake to assert on argv without forking vipune.
   */
  gvwmWriteFn?: (text: string, opts: { cwd: string; issue: number }) => Promise<{ id?: string }>;
}

/**
 * #533 — the transition table's answer, made total. Pre-#533 an unknown
 * `pipelineState.currentStep` reached the linear table's `Record<WorkStep, …>`
 * lookup, got `undefined`, and the driver loop's 64-iteration safety counter
 * fired with a message naming no field. The unknown case is now its own
 * member: the driver halts naming `pipelineState.currentStep`, and a loop
 * that spins can only do so by repeatedly RUNNING a real step, which the
 * safety counter still bounds.
 */
export type StepDecision =
  | { kind: "step"; step: WorkStep }
  | { kind: "done" }
  | { kind: "unknown-step"; value: unknown };

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

  // Terminal short-circuits.
  if (ps.currentStep === "merged" || ps.currentStep === "handoff") return { kind: "done" };

  // A cap-hit routes to `handoff`, `step-back` or `ci`, regardless of which
  // step emitted it: the driver records the decision in the event itself, so
  // this stays a lookup rather than a second place that can disagree. `ci` is
  // the round cap's non-critical exit (see `appendReviewCapHit`) — a review
  // that ran out of rounds with the adversarial gate approving and its residual
  // findings posted goes on to CI and the merge-authority gate, instead of
  // parking work a human then judges merge-worthy anyway.
  if (lastEvent?.kind === "cap-hit") return { kind: "step", step: lastEvent.nextStep };

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
    if (ps.reviewCapStartedAt && Date.now() - ps.reviewCapStartedAt > REVIEW_WALL_CLOCK_MS) {
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
