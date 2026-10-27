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
 *
 * The window rule — WHICH dispatch of a multi-dispatch window supplies cause,
 * source and line — is pinned by its sibling,
 * `test-work-driver-lens-fix-kill-cause-window.ts`. Both files read state built
 * by `lib/lens-fix-kill-cause-fixtures.ts`, whose header says why every event
 * here comes from a production writer.
 */
import { type ResultFailure, failureOf } from "../src/headless/failure.ts";
import type { HeadlessCap } from "../src/headless/caps.ts";
import {
  LENS_FIX_BOUND_DEFAULT_MS,
  LENS_FIX_BOUND_ENV,
  REVIEW_WALL_CLOCK_ENV,
} from "../src/review-budget.ts";
import type { DispatchResult } from "../src/types.ts";
import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import {
  buildCompletionEvent,
  overrideEnvForKillCause,
} from "../src/work-driver-completion-event.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import {
  CYCLE_DEADLINE_ENV,
  SPAWN_BACKSTOP_ENV,
  fixerBoundClause,
  fixerBoundEnv,
  lensFixBoundKillAction,
} from "../src/work-driver-fixer-bound.ts";
import { reviewFixDispatchBound } from "../src/work-driver-lens-fix-arming.ts";
import { initialState } from "../src/workflow-state.ts";
import {
  FIXER_BOUND,
  MIN,
  NOW,
  boundKillTail,
  byKind,
  failFor,
  failedDispatches,
  killed,
  lensFixCtx,
  lensFixCycle,
  lensFixWindow,
} from "./lib/lens-fix-kill-cause-fixtures.ts";

const ctx = lensFixCtx(killed({})) as unknown as CycleContext;

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
    reviewFixDispatchBound(base, "develop", NOW, FIXER_BOUND, "lens-fix", {
      remaining: 80 * MIN,
    }) === undefined,
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
    childBound.includes("PI_ENSEMBLE_DEVELOP_BOUND_MS") && !childBound.includes(LENS_FIX_BOUND_ENV),
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

  // #1798 round 1 — a kill with no `killBudgetMs` prints no "undefinedms".
  const noBudget = await killTail(killed({ killBudgetMs: undefined, fixerBoundSource: undefined }));
  assert(
    !noBudget.includes("undefined"),
    `a kill with no budget never prints "undefinedms" (got ${JSON.stringify(noBudget)})`,
  );

  // The one case the builder cannot produce: a state file written BEFORE #1798,
  // whose kill text carries the fixer clause but whose event has no
  // `fixerBoundSource` field. Synthesised from the clause the builder itself
  // spells (section 1 pins that spelling), with the legacy backstop override
  // appended — which is exactly what the text fallback has to see past.
  const legacyTail = `[pi-rukas] killed after ${FIXER_BOUND}ms at ${fixerBoundClause(
    "fixer-bound",
    FIXER_BOUND,
  )} (override: ${SPAWN_BACKSTOP_ENV})`;
  const legacy = await lensFixWindow([killed()], [], [legacyTail]);
  assert(
    failedDispatches(legacy).every(
      (e) => (e as { fixerBoundSource?: string }).fixerBoundSource === undefined,
    ),
    "the legacy fixture records no source on its dispatch (a pre-#1798 state file)",
  );
  const legacyVerdict = causeVerdictOf(legacy, "step-failed:lens-fix", failFor(legacy));
  assert(
    legacyVerdict?.causeClass === "pi-rukas" &&
      (legacyVerdict.userAction ?? "").includes(LENS_FIX_BOUND_ENV),
    `a state file written before the field still classifies from the kill's own clause (got ${JSON.stringify(legacyVerdict?.causeClass)})`,
  );
}

// ─────────────────────────── 3. the classifier reads it back ─────────────────
{
  const state = await lensFixWindow(
    [killed({ fixerBoundSource: "fixer-bound" })],
    [],
    [boundKillTail],
  );
  const failure: ResultFailure | undefined = failFor(state);
  const v = causeVerdictOf(state, "step-failed:lens-fix", failure);
  assert(
    v?.causeClass === "pi-rukas",
    `a bound kill is pi-rukas's, not the host's (got ${v?.causeClass})`,
  );
  assert(
    (v?.causeReason ?? "").includes("pi-rukas's own time bound") &&
      (v?.causeReason ?? "").includes("killed at 45m"),
    `the reason names the clock and the minutes (got ${JSON.stringify(v?.causeReason)})`,
  );
  assert(
    !/(provider|host)/i.test(v?.causeReason ?? "") ||
      (v?.causeReason ?? "").includes("not at fault"),
    "the reason does not send the operator to a provider or host that is fine",
  );
  assert(
    (v?.userAction ?? "").includes(LENS_FIX_BOUND_ENV) &&
      (v?.userAction ?? "").includes("/work 1798"),
    `the action names the knob to raise and the re-run (got ${JSON.stringify(v?.userAction)})`,
  );
  assert(
    !(v?.userAction ?? "").toLowerCase().startsWith("clear the environment"),
    "the generic environment advice is gone for this shape",
  );
}

{
  // CANARIES — every one must keep the generic entry.
  // The pre-#1798 text: a kill clause naming no clock and no fixer knob.
  const genericState = await lensFixWindow(
    [killed({ killCause: "timeout" })],
    [],
    ["[pi-rukas] killed after 7200000ms timeout"],
  );
  const generic = causeVerdictOf(genericState, "step-failed:lens-fix", failFor(genericState));
  assert(
    generic?.causeClass === "environment",
    `canary: a sourceless lens-fix timeout stays environment (got ${generic?.causeClass})`,
  );

  const stoppedState = await lensFixWindow(
    [
      killed({
        killCause: undefined,
        exitCode: 1,
        errorStop: { reason: "error", message: "upstream connect error" },
        fixerBoundSource: "fixer-bound",
      }),
    ],
    [],
    ["provider error: stream ended"],
  );
  const stopped = causeVerdictOf(stoppedState, "step-failed:lens-fix", failFor(stoppedState));
  assert(
    stopped?.causeClass === "environment",
    `canary: an error-stop is the provider's even with a source present (got ${stopped?.causeClass})`,
  );

  // #1798 round 1 — the shape the field-on-`failure` guard could never see.
  // Built through the REAL mapper with both facts on the result: pi-rukas's own
  // clock killed the child AND the provider had severed the stream. The kill
  // branch wins the event (so the event's KIND is `dispatch-failed`), and the
  // verdict must still abstain — an outage is never a knob to raise.
  const outage = killed({
    killCause: "timeout",
    killBudgetMs: FIXER_BOUND,
    fixerBoundSource: "fixer-bound",
    errorStop: { reason: "error", message: "terminated" },
  });
  // No `errorTail` override here on purpose: the builder's own bound clause is
  // what this canary tests, and the provider note it appends is the fact.
  const outageEvent = await buildCompletionEvent(ctx, "lens-fix", "developer", "lens-fix", outage);
  assert(
    outageEvent?.kind === "dispatch-failed" && outageEvent.providerMessage !== undefined,
    `a kill that is also an error-stop keeps the provider fact on the dispatch-failed (got ${JSON.stringify(outageEvent)?.slice(0, 160)})`,
  );
  const outageState = await lensFixCycle({}, "fixer-bound");
  const outageLog = [...outageState.eventLog];
  const outageIdx = outageLog.findIndex((e) => e.kind === "dispatch-failed");
  outageLog[outageIdx] = outageEvent as never;
  const outageVerdict = causeVerdictOf(
    { ...outageState, eventLog: outageLog },
    "step-failed:lens-fix",
    failFor({ ...outageState, eventLog: outageLog }),
  );
  assert(
    outageVerdict?.causeClass === "environment",
    `canary: a bound kill that is ALSO a provider error-stop is not re-badged as a knob (got ${outageVerdict?.causeClass})`,
  );

  // The verdict is lens-fix-only. Built the way a real develop failure is
  // built — the `develop` step's own events — rather than by patching `step`
  // onto lens-fix events: rewriting the step of a lens-fix log leaves a
  // `step-started: lens-fix` in the window, and the classifier then reads a
  // lens-fix window and answers for a step that never ran one. The canary has
  // to ask what a DEVELOP log says.
  //
  // The FAILURE is the one `failureOf` projects for this log (kind `timeout`),
  // which is what the generic entry makes `environment`. Passing `undefined`
  // instead would answer a question no cycle asks — a kind-driven cap with no
  // dispatch behind it is `pi-rukas` by the table's own rule, and asserting
  // `environment` against that would pin the table's fallback, not this
  // module's step guard.
  const developState = initialState(1798, 1);
  const developLog = [
    { kind: "step-started", step: "develop", at: 1 },
    {
      kind: "dispatch-failed",
      step: "develop",
      role: "developer",
      jobId: "develop:d:1",
      label: "develop",
      ms: FIXER_BOUND,
      at: 2,
      killCause: "timeout",
      errorTail: boundKillTail,
      fixerBoundSource: "fixer-bound",
    },
    {
      kind: "cap-hit",
      step: "develop",
      cap: "step-failed:develop",
      at: 3,
      reviewRound: 0,
      nextStep: "handoff",
    },
  ] as never;
  const developFailure = {
    kind: "timeout",
    message: "killed by pi-rukas (wall-clock timeout)",
    step: "develop",
    role: "developer",
    cause: "self-killed:timeout",
    killCause: "timeout",
  } as unknown as ResultFailure;
  const other = causeVerdictOf(
    { ...developState, eventLog: developLog },
    "step-failed:develop",
    developFailure,
  );
  assert(
    other?.causeClass === "environment",
    `canary: the verdict is lens-fix-only — develop keeps its own classification (got ${other?.causeClass})`,
  );

  // An inactivity kill carries the bound clause from a sibling round: it must
  // NOT be re-badged as a bound kill, because raising the bound does not stop a
  // silent child. It keeps the generic verdict.
  const mismatchedState = await lensFixWindow(
    [killed({ killCause: "inactivity", fixerBoundSource: "fixer-bound" })],
    [],
    [`[pi-rukas] killed after 2700000ms inactivity · ${boundKillTail}`],
  );
  const mismatched = causeVerdictOf(
    mismatchedState,
    "step-failed:lens-fix",
    failFor(mismatchedState),
  );
  assert(
    mismatched?.causeClass === "environment",
    `canary: an inactivity kill is not re-badged as a bound kill (got ${mismatched?.causeClass})`,
  );

  assert(
    lensFixBoundKillAction("review-clock", 7).includes(REVIEW_WALL_CLOCK_ENV),
    "the action for a review-clock kill raises the wall clock, not the fixer ceiling",
  );
  // #1798 round 3 — the number is DERIVED from `LENS_FIX_BOUND_DEFAULT_MS`, so
  // this asserts the sentence tracks the constant the resolver actually uses
  // rather than a literal that can rot when the default moves.
  assert(
    lensFixBoundKillAction("fixer-bound", 7).includes(
      `${Math.round(LENS_FIX_BOUND_DEFAULT_MS / 60_000)} min`,
    ),
    "the action says what the default is, and the default is the constant, not a literal",
  );

  // #1798 round 1 — with no minutes in the kill's clause the reason says
  // "a bound", never "0m": an unknown number reads as a bound of zero.
  // The legacy writer's shape: an older builder printed the clause with no
  // minutes. Appended to the driver's own line the way a pre-#1798 state file
  // carries text the current builder never writes, so the read — not the
  // fixture — is what has to cope.
  const noMinutesState = await lensFixWindow(
    [killed({ killCause: "timeout", fixerBoundSource: "fixer-bound" })],
    [],
    [`[pi-rukas] killed at pi-rukas's own fixer-bound bound (${LENS_FIX_BOUND_ENV})`],
  );
  const noMinutes = causeVerdictOf(noMinutesState, "step-failed:lens-fix", undefined);
  assert(
    noMinutes?.causeClass === "pi-rukas" &&
      (noMinutes.causeReason ?? "").includes("killed at a bound") &&
      !(noMinutes.causeReason ?? "").includes("0m"),
    `unknown minutes are phrased without a number (got ${JSON.stringify(noMinutes?.causeReason)})`,
  );
}

console.log("\n#1798 lens-fix bound kill cause: all assertions passed");
