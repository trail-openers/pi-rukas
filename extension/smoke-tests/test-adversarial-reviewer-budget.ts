#!/usr/bin/env bun
/**
 * #1978 — the adversarial reviewer child carries the STEP BUDGET's arms, and the
 * loop reports what it does with them.
 *
 * `budgets.review` (turns / tokens / minutes) armed the lens children and NOT the
 * adversarial gate's reviewer: the loop never forwarded an arm, so `makeRunPhase`
 * passed the spawn neither a bound the budget set, nor the abort the turns/tokens
 * levers fire, nor the hook that measures them. A reviewer ran to the operator's
 * 30-minute knob (or the 2-h backstop) whatever the review step's ceiling said,
 * and when it did die the loop reported no cause — so `armBudget`'s `fired()` had
 * nothing to read, `gate.stop` stayed `undefined`, and the lean gate MERGED a head
 * its own budget had stopped.
 *
 * Each case therefore asserts what the CHILD received or what the loop RETURNED,
 * never which internal function ran. `deliver` drives the real phase with armed
 * params; `deliverKilled` stubs only `makeRunPhase`, so the arms, the deck
 * composition and the projection stay production code with the child's death the
 * only fabricated fact. The harness is shared with the #1827 bound assertions
 * (`test-adversarial-reviewer-bound.ts`), which predate this issue and cover the
 * reviewer's own knob.
 *
 * The step-level counterpart — the same chain driven through the production
 * `reviewDeps()` seam down to the throw — is
 * `test-lean-review-adversarial-budget-stop.ts`.
 *
 * Offline: no model, no child, no token.
 */

import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import { classifyReviewer } from "../src/adversarial-reviewer-arm.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  deliver,
  deliverKilled,
  setNextProgressTurns,
} from "./lib/adversarial-reviewer-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (A) THE OPERATOR'S KNOB WINS WHEN IT IS THE SMALLER ONE ═══════════
// The spread-order defect: `...a.budget.opts` after the reviewer's own bound
// re-supplied the budget's 40 minutes and `PI_ENSEMBLE_ADVERSARIAL_BOUND_MS` was
// decoration. A budget may only ever TIGHTEN the wall clock.
{
  const KNOB = 60_000;
  const BUDGET = 40 * 60_000;
  const { reviewer } = await deliver(
    { childBoundMs: BUDGET },
    { PI_ENSEMBLE_ADVERSARIAL_BOUND_MS: String(KNOB) },
  );
  assert(
    reviewer?.childBoundMs === KNOB,
    `(A) the reviewer's bound is min(budget, knob): a ${String(BUDGET)}ms budget must NOT lengthen the operator's ${String(KNOB)}ms knob (captured ${String(reviewer?.childBoundMs)})`,
  );
}

// ── (B) THE BUDGET TIGHTENS WHEN IT IS THE SMALLER ONE ═════════════
{
  const KNOB = 30 * 60_000;
  const BUDGET = 5 * 60_000;
  const { reviewer } = await deliver(
    { childBoundMs: BUDGET },
    { PI_ENSEMBLE_ADVERSARIAL_BOUND_MS: String(KNOB) },
  );
  assert(
    reviewer?.childBoundMs === BUDGET,
    `(B) and a budget below the knob still TIGHTENS the reviewer's wall clock — the minutes lever reaching the child at all (captured ${String(reviewer?.childBoundMs)}, expected ${String(BUDGET)})`,
  );
}

// ── (C) NO ARMED BUDGET STILL GETS THE KNOB, NOT INFINITY ═════════════
{
  const KNOB = 11 * 60_000;
  const { reviewer } = await deliver({}, { PI_ENSEMBLE_ADVERSARIAL_BOUND_MS: String(KNOB) });
  assert(
    reviewer?.childBoundMs === KNOB,
    `(C) with no armed budget the reviewer still gets PI_ENSEMBLE_ADVERSARIAL_BOUND_MS — not Infinity, not the generic bound (captured ${String(reviewer?.childBoundMs)})`,
  );
}

// ── (D) THE ARMS ARE REVIEWER-ONLY ════════════════════════════════
// `makeRunPhase` branches on `isReviewerRole`; a fix-pass arm that inherited the
// budget's abort would be a developer child the step kills for a reviewer's
// overrun. The bound's reviewer-only half is asserted in the #1827 file; these
// cover the abort and the hook.
{
  const controller = new AbortController();
  const budgetHook = (): void => {};
  const { reviewer, fix } = await deliver({
    childBoundMs: 9 * 60_000,
    signal: controller.signal,
    onProgress: budgetHook,
  });
  assert(
    reviewer?.signal !== undefined,
    "(D) the reviewer child received AN abort signal — the one the turns/tokens levers fire",
  );
  assert(
    typeof reviewer?.onProgress === "function",
    "(D) and the reviewer child received an onProgress hook",
  );
  assert(
    fix?.signal === undefined,
    `(D) the FIX-pass developer got NO abort signal — a budget arm on the fixer kills a developer for the reviewer's overrun (captured ${String(fix?.signal)})`,
  );
  assert(fix?.onProgress === undefined, "(D) and no progress hook of any kind on the fix arm");
}

// ── (E) BOTH PROGRESS FEEDS FIRE — COMPOSITION, NOT REPLACEMENT ════════
// The edge case the issue names: the phase's own `onProgress` writes the deck row
// and the slow-run watch, which `watchSlowDispatch`'s boundArmed/steer behaviour
// reads. Handing the spawn the budget's hook INSTEAD arms the turns lever and
// silently loses both.
{
  let budgetTicks = 0;
  setNextProgressTurns(1);
  const { deckTicks } = await deliver({ onProgress: () => void budgetTicks++ });
  setNextProgressTurns(0);
  assert(
    deckTicks > 0,
    `(E) the deck row still updates (deck ticks: ${String(deckTicks)}) — the budget's hook did not replace the phase's feed`,
  );
  assert(
    budgetTicks > 0,
    `(E) and the budget's hook fired on the same tick (its ticks: ${String(budgetTicks)}) — arming the turns lever is not enough if nothing calls it`,
  );
}

// ── (F) THE TURNS LEVER ACTUALLY ABORTS THE REVIEWER CHILD ═══════════
// AC1's delivered-value form at the loop level: a hook crossing its lever must
// abort the child the phase spawned, through the signal the phase wired to that
// child's own controller.
{
  const controller = new AbortController();
  setNextProgressTurns(4);
  const { reviewer } = await deliver({
    signal: controller.signal,
    onProgress: (s) => {
      if (s.turns > 3) controller.abort();
    },
  });
  setNextProgressTurns(0);
  assert(controller.signal.aborted, "(F) the child's tick crossed the lever and it aborted");
  assert(
    reviewer?.signal?.aborted === true,
    "(F) and that abort REACHED the reviewer child's own signal — the half that lets a runaway reviewer stop at a turn boundary",
  );
}

// ── (G) A KILLED REVIEWER PROJECTS ITS CAUSE AND BUYS NO RE-DISPATCH ════
// AC5 + the gap gate's CRITICAL: `armBudget`'s fired() reports the minutes lever
// ONLY on a result whose killCause is "child-bound" (step-budget.ts), and the
// loop's results carried none — so a reviewer the step's own ceiling killed came
// back as an ordinary verdict and the gate merged the head. And the kill must end
// the round: a re-dispatch would spend the same ceiling twice.
{
  const { loop, tags } = await deliverKilled("child-bound");
  assert(
    loop.killCause === "child-bound",
    `(G) the loop's result CARRIES the reviewer's kill cause — the only thing lean's budget reader can read to name the minutes lever (got ${String(loop.killCause)})`,
  );
  assert(
    loop.loopOutcome === "infra-failure",
    `(G) and the pass is honestly no-verdict infrastructure, not a verdict the child never spoke (got ${String(loop.loopOutcome)})`,
  );
  assert(
    tags.length === 1,
    `(G) a budget-killed reviewer ended the round with ONE reviewer dispatch and no fixer (tags: ${tags.join(", ")})`,
  );
  assert(
    tags.every((t) => !t.includes("-retry")),
    `(G) and NO re-dispatch — no child carried a -retry tag (${tags.join(", ")})`,
  );
}

// ── (G2) A CAUSELESS BUDGET KILL IS NOT RETRIED EITHER ════════════
// The shape `PI_ENSEMBLE_DISPATCH_CAPS=0` leaves: `armChildBound` is inert, so the
// child this harness ended carries NO killCause. The `crashed` fallback in
// `classifyDispatchOutcome` returns maxRetries:1, which spent the same ceiling on a
// second reviewer — the #1863 bug reached through the budget's bound.
{
  const { loop, tags } = await deliverKilled(undefined as DispatchResult["killCause"]);
  assert(
    tags.length === 1 && tags[0] === "round1-review",
    `(G2) a killed reviewer with NO kill cause is NOT re-dispatched — one child, not two from one ceiling (tags: ${tags.join(", ")})`,
  );
  assert(
    loop.loopOutcome === "infra-failure",
    `(G2) and the round still ends as no-verdict infrastructure rather than a merged head (got ${String(loop.loopOutcome)})`,
  );
}

// ── (H) A NON-BUDGET KILL NEVER ARRIVES AS A BUDGET ═════════════
// The over-read half of the MEDIUM finding: a reviewer the caps or the watchdog
// ended must not make the step claim a budget the operator set. Both of the
// loop's returns are guarded, by two different filters, and this drives each of
// them with the cause that filter exists to refuse:
//
//  - the NO-VERDICT path returns `infraFailureResult`, whose killCause is narrowed
//    by `capKillOrWatchdogKillCause` in `adversarial-retry.ts`;
//  - the VERDICT path returns `synthesizeResult` fed by the loop's projection,
//    which keeps only the caller's-clock causes.
//
// The positive control at the end is what makes these two assertions evidence
// rather than tautology: the same code path DOES carry a bound kill, so a green
// pair above means a filter, not a field that was never written.
{
  const { loop: capLoop } = await deliverKilled("loop", { text: "VERDICT: APPROVED" });
  assert(
    capLoop.killCause !== "child-bound" && capLoop.killCause !== "abort",
    `(H) a reviewer killed by the loop cap never reaches the step as a budget kill (got ${String(capLoop.killCause)})`,
  );
  const { loop: watchdogLoop } = await deliverKilled("inactivity");
  assert(
    watchdogLoop.killCause !== "child-bound" && watchdogLoop.killCause !== "abort",
    `(H) and neither does a watchdog kill, which the fan-out reads with its own semantics (got ${String(watchdogLoop.killCause)})`,
  );
  const { loop: boundLoop } = await deliverKilled("child-bound", {
    text: "VERDICT: APPROVED",
  });
  assert(
    boundLoop.killCause === "child-bound",
    `(H) positive control — the bound kill DOES ride out on the same path, so the two refusals above are a filter and not a dropped field (got ${String(boundLoop.killCause)})`,
  );
}

// ── (I) THE CLASSIFIER'S OWN TWO GUARDS ═══════════════════════════════
// The two conditions that keep the no-retry verdict from swallowing a child it
// must not own, asserted on `classifyReviewer` directly because the loop cannot
// reach either shape: a child that SAID something is not a child the caller
// cancelled, and one the harness killed is not a child that died of nothing.
{
  const killed = (over: Partial<DispatchResult>): DispatchResult => ({
    role: "adversarial-developer",
    ok: false,
    text: "",
    toolUses: [],
    ms: 1,
    exitCode: 0,
    ...over,
  });
  const spoken = killed({ text: "reviewed, but the reply held no marker" });
  // The arm under test lives in the reviewer module; the shared classifier is
  // imported too so "reached the ladder" is told apart from "the arm said so".
  const noReply = classifyReviewer(killed({}));
  assert(
    noReply.cause === "crashed" && noReply.shouldRetry === false && noReply.maxRetries === 0,
    `(I) a no-reply, no-cause, zero-exit reviewer is terminal — no second child from one ceiling (got ${noReply.cause}, retry=${String(noReply.shouldRetry)}, max=${String(noReply.maxRetries)})`,
  );
  assert(
    noReply.cause !== "self-killed:abort" &&
      !/cancelled by the caller's budget/.test(noReply.headline),
    `(I) and it is no longer labelled an abort it never carried — the child reported NO kill cause, so naming one is a claim nothing recorded (cause ${noReply.cause})`,
  );
  assert(
    /caller|cancel/i.test(noReply.headline),
    `(I) but the headline still says what IS known: the caller ended it, so the operator reads a cancellation and not a crash (${noReply.headline})`,
  );
  // Same `!ok` / exit 0 / no-cause child, the only difference the text guard.
  const shared = classifyDispatchOutcome(spoken);
  const spoke = classifyReviewer(spoken);
  assert(
    shared.shouldRetry === true && shared.maxRetries === 1,
    `(I) precondition: the SHARED ladder retries this shape, so the assertion below is about the guard and not about both saying the same thing (retry=${String(shared.shouldRetry)}, max=${String(shared.maxRetries)})`,
  );
  assert(
    spoke.shouldRetry === true && spoke.maxRetries === 1,
    `(I) a child that PRINTED something is NOT given the arm's no-retry verdict — the guard is the empty text, not the ok flag (retry=${String(spoke.shouldRetry)}, max=${String(spoke.maxRetries)})`,
  );
  // The harness's own honesty condition, asserted rather than assumed: `spawn.ts`
  // marks a killed child failed whatever its exit code (`failedByKill`). It is
  // what makes a kill a FAILURE rather than a completed assignment that merely
  // carried a cause, so a killed child that also printed its verdict — the shape
  // `test-lean-review-adversarial-budget-stop.ts` drives — is refused by the loop
  // instead of approved on a child the ceiling ended.
  const verdict = "VERDICT: APPROVED";
  const okKilled = classifyReviewer({ ...killed({ text: verdict }), ok: true });
  const deadKilled = classifyReviewer(killed({ text: verdict }));
  assert(
    okKilled.cause === "success" && deadKilled.cause === "crashed",
    `(I) and a killed child really does come back FAILED — ok:true on a kill would let the loop approve a child the ceiling ended (ok:${okKilled.cause} vs !ok:${deadKilled.cause})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
