#!/usr/bin/env bun
/**
 * #1798 — a lens-fix killed by pi-rukas's own clock says so, and names the
 * knob it killed it.
 *
 * The field shape (three cycles, v0.14.27): the lens-fix developer was killed at
 * its bound — twice at the 45-minute `PI_ENSEMBLE_LENS_FIX_BOUND_MS` ceiling,
 * once at the caller's cycle deadline — still producing output seconds before the
 * kill, and the cycle handed the operator
 * `Cause: environment — the step failed and the driver recorded no structured
 * cause for it` / `clear the environment fault the evidence names (the provider,
 * the host or the deadline), then re-run /work N`. Nothing in the environment had
 * failed. The operator restarted and burned the same hours.
 *
 * So this file pins three links of one chain, each of which used to lose the
 * fact the previous link had just computed:
 *
 *  1. the resolver keeps WHICH clock won, not only the duration;
 *  2. the completion event writes that source into the kill's text and its
 *     override knob, instead of the two-hour backstop the child never ran under;
 *  3. the cause classifier reads it back and answers pi-rukas with a concrete
 *     action — and answers NOTHING (falls through to the generic entry) for the
 *     shapes that really are the environment's.
 *
 * The canaries are the point of the file: an error-stop, a sourceless kill and a
 * different step must all keep the old verdict, or this fix becomes a way to
 * re-badge a provider outage as a knob.
 */
import { failureOf, type ResultFailure } from "../src/headless/failure.ts";
import type { HeadlessCap } from "../src/headless/caps.ts";
import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import {
  buildCompletionEvent,
  overrideEnvForKillCause,
} from "../src/work-driver-completion-event.ts";
import {
  CYCLE_DEADLINE_ENV,
  fixerBoundClause,
  fixerBoundEnv,
  lensFixBoundKillAction,
  SPAWN_BACKSTOP_ENV,
} from "../src/work-driver-fixer-bound.ts";
import { reviewFixDispatchBound } from "../src/work-driver-lens-fix-arming.ts";
import { LENS_FIX_BOUND_ENV, REVIEW_WALL_CLOCK_ENV } from "../src/review-budget.ts";
import { initialState, type WorkEvent, type WorkState } from "../src/workflow-state.ts";
import type { DispatchResult } from "../src/types.ts";
import type { CycleContext } from "../src/work-driver-context.ts";

const MIN = 60_000;
const NOW = 1_700_000_000_000;
const WALL = 90 * MIN;
const FIXER_BOUND = 45 * MIN;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

// ─────────────────────────────── 1. the resolver keeps its source ────────────
// The budget reads are supplied directly: this section is about the attribution
// of a resolved bound, not about reading the loop clock (which
// test-review-wall-clock-enforced.ts covers exhaustively).
{
  const base = initialState(1798);

  // Plenty of budget left ⇒ the fixer's own ceiling won ⇒ the knob to name is
  // the fixer's, NOT the review clock and NOT the backstop.
  const own = reviewFixDispatchBound(base, "lens-fix", NOW, FIXER_BOUND, "lens-fix", {
    remaining: 80 * MIN,
  });
  assert(
    own?.boundMs === FIXER_BOUND && own.source === "fixer-bound",
    `budget left > ceiling → source fixer-bound at the ceiling (got ${JSON.stringify(own)})`,
  );

  // The loop leaves less than the ceiling ⇒ the review wall clock set the bound.
  const loop = reviewFixDispatchBound(base, "lens-fix", NOW, FIXER_BOUND, "lens-fix", {
    remaining: 30 * MIN,
  });
  assert(
    loop?.boundMs === 20 * MIN && loop.source === "review-clock",
    `budget left < ceiling → source review-clock, bound = remaining − the owed round's reserve (got ${JSON.stringify(loop)})`,
  );

  // No ceiling at all is never "fixer-bound": there is no fixer knob to raise.
  const unclamped = reviewFixDispatchBound(base, "lens-fix", NOW, undefined, "lens-fix", {
    remaining: 80 * MIN,
  });
  assert(
    unclamped?.source === "review-clock",
    `no ceiling from the caller → the review clock owns the bound (got ${JSON.stringify(unclamped)})`,
  );

  // Exactly at the ceiling the ceiling won: the fixer ran out of ITS minutes.
  const exact = reviewFixDispatchBound(base, "lens-fix", NOW, 20 * MIN, "lens-fix", {
    remaining: 30 * MIN,
  });
  assert(
    exact?.boundMs === 20 * MIN && exact.source === "fixer-bound",
    `bound == ceiling → fixer-bound, the tie belongs to the knob the operator can raise (got ${JSON.stringify(exact)})`,
  );

  // Canaries: the shapes that must produce NO source at all.
  assert(
    reviewFixDispatchBound(base, "develop", NOW, FIXER_BOUND, "lens-fix", { remaining: 80 * MIN }) ===
      undefined,
    "canary: a step outside the fix loop gets no bound and no source",
  );
  assert(
    reviewFixDispatchBound(base, "lens-fix", NOW, FIXER_BOUND, "lens-fix", {
      remaining: undefined,
      unboundReason: "enforcement is off (PI_ENSEMBLE_REVIEW_ENFORCE)",
    }) === undefined,
    "canary: nothing armed → no bound, no source (never a fabricated fixer-bound)",
  );
  // The number and its attribution come from one comparison, so they cannot
  // disagree: every armed resolution names the knob its own minutes came from.
  assert(
    fixerBoundEnv("fixer-bound") === LENS_FIX_BOUND_ENV &&
      fixerBoundEnv("review-clock") === REVIEW_WALL_CLOCK_ENV &&
      fixerBoundEnv("cycle-deadline") === CYCLE_DEADLINE_ENV,
    "each source names exactly one knob, and the backstop is never one of them",
  );
  assert(
    fixerBoundClause("fixer-bound", FIXER_BOUND) ===
      `pi-rukas's own ${"fixer-bound"} bound of 45m (${LENS_FIX_BOUND_ENV})`,
    "the clause the classifier reads back is spelled by one function only",
  );
}

// ───────────────────── 2. the kill's text names the right knob ───────────────
const ctx = { repoRoot: "/tmp", issue: 1798 } as unknown as CycleContext;

function killed(over: Partial<DispatchResult>): DispatchResult {
  return {
    ok: false,
    ms: 45 * MIN,
    exitCode: null,
    finalAssistantText: "",
    killCause: "timeout",
    killBudgetMs: 45 * MIN,
    ...over,
  } as unknown as DispatchResult;
}

async function killTail(result: DispatchResult): Promise<string> {
  const event = await buildCompletionEvent(ctx, "lens-fix", "developer", "lens-fix", result);
  if (event === undefined || event.kind !== "dispatch-failed") {
    throw new Error(`expected a dispatch-failed event, got ${JSON.stringify(event)?.slice(0, 80)}`);
  }
  return event.errorTail ?? "";
}

{
  // A fixer killed at its own ceiling: the fixer's knob, never the backstop.
  const tail = await killTail(killed({ fixerBoundSource: "fixer-bound" }));
  assert(
    tail.includes(LENS_FIX_BOUND_ENV) && !tail.includes(SPAWN_BACKSTOP_ENV),
    `timeout at the fixer bound names PI_ENSEMBLE_LENS_FIX_BOUND_MS and NOT the backstop (got ${JSON.stringify(tail)})`,
  );
  assert(
    tail.includes("pi-rukas's own fixer-bound bound of 45m"),
    `the kill says which clock and how long (got ${JSON.stringify(tail)})`,
  );
  assert(
    !tail.includes("the provider"),
    `a bound kill does not send the operator to the provider (got ${JSON.stringify(tail)})`,
  );

  const reviewTail = await killTail(killed({ fixerBoundSource: "review-clock" }));
  assert(
    reviewTail.includes(REVIEW_WALL_CLOCK_ENV) && !reviewTail.includes(LENS_FIX_BOUND_ENV),
    `review-clock kill names the wall clock, not the fixer's ceiling (got ${JSON.stringify(reviewTail)})`,
  );

  const deadlineTail = await killTail(killed({ fixerBoundSource: "cycle-deadline" }));
  assert(
    deadlineTail.includes(CYCLE_DEADLINE_ENV) && !deadlineTail.includes(SPAWN_BACKSTOP_ENV),
    `cycle-deadline kill names the caller's deadline (got ${JSON.stringify(deadlineTail)})`,
  );

  // The caller's own deadline stamp still wins the wording (#1593), and the
  // source is carried on the event so a resumed cycle classifies the same.
  const clamped = await buildCompletionEvent(
    ctx,
    "lens-fix",
    "developer",
    "lens-fix",
    killed({ fixerBoundSource: "fixer-bound", killedAtCycleDeadline: true }),
  );
  assert(
    clamped?.kind === "dispatch-failed" &&
      (clamped.errorTail ?? "").includes("caller's cycle deadline") &&
      clamped.fixerBoundSource === "fixer-bound",
    "a deadline-clamped kill keeps the deadline wording and still records its source",
  );

  const stamped = await buildCompletionEvent(
    ctx,
    "lens-fix",
    "developer",
    "lens-fix",
    killed({ fixerBoundSource: "review-clock" }),
  );
  assert(
    stamped?.kind === "dispatch-failed" && stamped.fixerBoundSource === "review-clock",
    "the source persists on the dispatch-failed event (a resumed cycle must classify identically)",
  );

  // Canaries: no source ⇒ the old text verbatim, so no other step's kill is
  // silently re-badged as a fixer bound.
  const plain = await killTail(killed({}));
  assert(
    plain.includes(SPAWN_BACKSTOP_ENV) && !plain.includes(LENS_FIX_BOUND_ENV),
    `canary: a sourceless timeout still names the backstop (got ${JSON.stringify(plain)})`,
  );
  const childBound = await killTail(
    killed({ killCause: "child-bound", fixerBoundSource: undefined }),
  );
  assert(
    childBound.includes("PI_ENSEMBLE_DEVELOP_BOUND_MS") &&
      !childBound.includes(LENS_FIX_BOUND_ENV),
    `canary: a sourceless child-bound still names the per-role bounds (got ${JSON.stringify(childBound)})`,
  );
  assert(
    overrideEnvForKillCause("child-bound", "review-clock") === REVIEW_WALL_CLOCK_ENV,
    "child-bound takes the fixer's knob when the step recorded one",
  );
  assert(
    overrideEnvForKillCause("inactivity", "fixer-bound") === "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS",
    "canary: a source never leaks into a cause whose bound is another mechanism",
  );
  assert(
    overrideEnvForKillCause("plan-timeout", "fixer-bound") === "PI_ENSEMBLE_PLAN_TIMEOUT_MS",
    "canary: the plan step's own bound is unmoved by a fixer source",
  );
}

// ─────────────────────────── 3. the classifier reads it back ─────────────────
function lensFixCycle(event: Record<string, unknown>): WorkState {
  const base = initialState(1798, 1);
  return {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "lens-fix",
    },
    eventLog: [
      { kind: "step-started", at: 1, step: "lens-fix" },
      {
        kind: "dispatch-failed",
        at: 2,
        step: "lens-fix",
        role: "developer",
        label: "lens-fix",
        ok: false,
        exitCode: null,
        ms: 45 * MIN,
        ...event,
      },
      {
        kind: "cap-hit",
        at: 3,
        cap: "step-failed:lens-fix",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ] as WorkEvent[],
  } as unknown as WorkState;
}

const boundKillTail = `[pi-rukas] killed after 2700000ms at pi-rukas's own fixer-bound bound of 45m (${LENS_FIX_BOUND_ENV})`;

/**
 * The failure the driver itself would hand the classifier: built by `failureOf`
 * from the same state, not by hand. A hand-rolled `ResultFailure` is a second
 * implementation of the read that the classifier depends on, and the first draft
 * of this file got its `kind` wrong — a `kind` the generic entry then preferred
 * over the bound verdict.
 */
function failFor(state: WorkState): ResultFailure | undefined {
  return failureOf(state, "step-failed:lens-fix" as HeadlessCap, "lens-fix");
}

{
  const v = causeVerdictOf(
    lensFixCycle({ killCause: "timeout", errorTail: boundKillTail, fixerBoundSource: "fixer-bound" }),
    "step-failed:lens-fix",
    failFor(
      lensFixCycle({ killCause: "timeout", errorTail: boundKillTail, fixerBoundSource: "fixer-bound" }),
    ),
    undefined,
  );
  assert(v?.causeClass === "pi-rukas", `a bound kill is pi-rukas's, not the host's (got ${v?.causeClass})`);
  assert(
    (v?.causeReason ?? "").includes("pi-rukas's own time bound") &&
      (v?.causeReason ?? "").includes("killed at 45m"),
    `the reason names the clock and the minutes (got ${JSON.stringify(v?.causeReason)})`,
  );
  assert(
    !/(provider|host)/i.test(v?.causeReason ?? "") || (v?.causeReason ?? "").includes("not at fault"),
    "the reason does not send the operator to a provider or host that is fine",
  );
  assert(
    (v?.userAction ?? "").includes(LENS_FIX_BOUND_ENV) && (v?.userAction ?? "").includes("/work 1798"),
    `the action names the knob to raise and the re-run (got ${JSON.stringify(v?.userAction)})`,
  );
  assert(
    !(v?.userAction ?? "").toLowerCase().startsWith("clear the environment"),
    "the generic environment advice is gone for this shape",
  );
}

{
  // The persisted source is not required — the kill's own text is enough, which
  // is what makes an older state file classify correctly after an upgrade.
  const v = causeVerdictOf(
    lensFixCycle({ killCause: "timeout", errorTail: boundKillTail }),
    "step-failed:lens-fix",
    failFor(lensFixCycle({ killCause: "timeout", errorTail: boundKillTail })),
    undefined,
  );
  assert(
    v?.causeClass === "pi-rukas" && (v.userAction ?? "").includes(LENS_FIX_BOUND_ENV),
    "a state file written before the field still classifies from the kill's own clause",
  );
}

{
  // CANARIES — every one must keep the generic entry.
  const generic = causeVerdictOf(
    lensFixCycle({ killCause: "timeout", errorTail: "[pi-rukas] killed after 7200000ms timeout" }),
    "step-failed:lens-fix",
    failFor(
      lensFixCycle({ killCause: "timeout", errorTail: "[pi-rukas] killed after 7200000ms timeout" }),
    ),
    undefined,
  );
  assert(
    generic?.causeClass === "environment",
    `canary: a sourceless lens-fix timeout stays environment (got ${generic?.causeClass})`,
  );

  const stopped = causeVerdictOf(
    lensFixCycle({
      errorTail: "provider error: stream ended",
      providerMessage: "upstream connect error",
      fixerBoundSource: "fixer-bound",
    }),
    "step-failed:lens-fix",
    failFor(
      lensFixCycle({
        errorTail: "provider error: stream ended",
        providerMessage: "upstream connect error",
        fixerBoundSource: "fixer-bound",
      }),
    ),
    undefined,
  );
  assert(
    stopped?.causeClass === "environment",
    `canary: an error-stop is the provider's even with a source present (got ${stopped?.causeClass})`,
  );

  const otherStep = (() => {
    const st = lensFixCycle({ killCause: "timeout", errorTail: boundKillTail, fixerBoundSource: "fixer-bound" });
    return {
      ...st,
      eventLog: st.eventLog.map((e) =>
        e.kind === "dispatch-failed" ? { ...e, step: "develop" } : e,
      ),
    } as WorkState;
  })();
  const other = causeVerdictOf(
    otherStep,
    "step-failed:develop",
    failFor(otherStep),
    undefined,
  );
  assert(
    other?.causeClass === "environment",
    `canary: the verdict is lens-fix-only — develop keeps its own classification (got ${other?.causeClass})`,
  );

  // An inactivity kill carries the bound clause from a sibling round: it must
  // NOT be re-badged as a bound kill, because raising the bound does not stop a
  // silent child. It keeps the generic verdict.
  const mismatched = causeVerdictOf(
    lensFixCycle({
      killCause: "inactivity",
      errorTail: `[pi-rukas] killed after 2700000ms inactivity · ${boundKillTail}`,
      fixerBoundSource: "fixer-bound",
    }),
    "step-failed:lens-fix",
    failFor(
      lensFixCycle({
        killCause: "inactivity",
        errorTail: `[pi-rukas] killed after 2700000ms inactivity · ${boundKillTail}`,
        fixerBoundSource: "fixer-bound",
      }),
    ),
    undefined,
  );
  assert(
    mismatched?.causeClass === "environment",
    `canary: an inactivity kill is not re-badged as a bound kill (got ${mismatched?.causeClass})`,
  );

  assert(
    lensFixBoundKillAction("review-clock", 7).includes(REVIEW_WALL_CLOCK_ENV),
    "the action for a review-clock kill raises the wall clock, not the fixer ceiling",
  );
  assert(
    lensFixBoundKillAction("fixer-bound", 7).includes("45 min"),
    "the action says what the default is, so the operator knows which way to move it",
  );
}

console.log("\n#1798 lens-fix bound kill cause: all assertions passed");
