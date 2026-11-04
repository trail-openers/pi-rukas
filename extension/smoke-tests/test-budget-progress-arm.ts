#!/usr/bin/env bun
/**
 * #1991 — the ARM's runtime behaviour: `armChildBounds` on a live child, with
 * every combination of levers the PM's two parameters can produce.
 *
 * `test-budget-progress-wiring.ts` pins the tool boundary (the PM's
 * `maxTurns`/`maxMinutes` are validated and reach `spawnSpecialist`) and the
 * source-text claims that the levers really reach the spawn. This suite is what
 * happens AFTER the arm is called: which lever arms the steer and so stands the
 * #546 turn nudge down, what a child with no steer seam receives, what the deck
 * key path writes, and what a refused delivery does to a stage.
 *
 * It exists because the pure logic and the wiring assertions can both be green
 * while a child is never paced: the nudge stands down on `armed()`, so an arm
 * that misreports what it armed is a child with NO steer at all — and under
 * `PI_ENSEMBLE_DISPATCH_CAPS=0` a minutes bound cannot kill, so claiming it
 * armed silences the one advisory that still fires (F4).
 *
 * The arm is called through `lib/budget-progress-harness.ts`, the same call
 * shape `spawnSpecialist` uses.
 */

import { PassThrough } from "node:stream";
import { registerChildHandle } from "../src/async-jobs-registry.ts";
import { BUDGET_PROGRESS_STEER_SOURCE } from "../src/budget-progress.ts";
import { type SteerSource } from "../src/dispatch-steer.ts";
import { type LifecycleDetails, formatLine } from "../src/lifecycle-events.ts";
import { childBoundGraceMs, childBoundSchedule } from "../src/spawn-child-bound.ts";
import {
  type SteerSource as HarnessSteerSource,
  armChild,
  capture,
  makeCheck,
  withEnv,
} from "./lib/budget-progress-harness.ts";

const { assert, eq, exitCode } = makeCheck();

// ── 6. a child with NO steer seam still receives both steers ────────────
//
// The lens / adversarial path passes no onSteer, so delivery falls through to
// the stdin envelope. That is the whole of AC6 and nothing else exercises it:
// every other steer test supplies a seam.
{
  const out = capture();
  const progress = armChild({
    role: "code-review-specialist",
    stdin: out.stdin,
    start: 0,
    opts: { budgetTurns: 4 },
  });
  eq(progress.armed(), true, "a turns lever alone arms the progress steer");
  // The seam the pump drives: runningState.turns, one call per assistant turn.
  for (let t = 1; t <= 4; t++) progress.onAssistantTurn(t, 0);
  eq(out.lines().length, 2, "AC6: a no-seam child receives exactly two steers on stdin");
  const first = JSON.parse(out.lines()[0] ?? "{}");
  eq(first.type, "steer", "the stdin line is an RPC steer envelope (the only stdin form Pi reads)");
  assert(
    first.message === "Budget: turn 2 of 4.",
    `the 50% line states the child's position (${first.message})`,
  );
  const second = JSON.parse(out.lines()[1] ?? "{}");
  assert(
    second.message === "Budget: turn 4 of 4. Report your findings now, then end your turn.",
    `a reviewer at 80% is told to report, never to commit (${second.message})`,
  );
  progress.stop();
}

// The close-out instruction follows what the child can actually do: the arm
// decides from (role, cwd), the same rule `armChildBound`'s `commits` encodes.
{
  const dev = capture();
  const committing = armChild({
    role: "developer",
    cwd: "/work/issue-1",
    stdin: dev.stdin,
    start: 0,
    opts: { budgetTurns: 10 },
  });
  for (let t = 1; t <= 10; t++) committing.onAssistantTurn(t, 0);
  eq(dev.lines().length, 2, "a developer receives exactly two steers too");
  assert(
    /Commit your work now/.test(JSON.parse(dev.lines()[1] ?? "{}").message ?? ""),
    "the 80% line for a developer with a tree of its own says commit",
  );
  committing.stop();

  const lone = capture();
  const noCwd = armChild({
    role: "developer",
    stdin: lone.stdin,
    start: 0,
    opts: { budgetTurns: 10 },
  });
  for (let t = 1; t <= 10; t++) noCwd.onAssistantTurn(t, 0);
  assert(
    !/Commit/.test(lone.text()),
    "a developer with no cwd of its own is told to report — there is no tree to commit into",
  );
  assert(
    /Report your findings now/.test(JSON.parse(lone.lines()[1] ?? "{}").message ?? ""),
    "and it is told so in the same words a reviewer hears (the rule is (role, cwd), not role)",
  );
  noCwd.stop();
}

// ── no levers → inert arm, and the nudge is NOT stood down ──────────────
{
  const out = capture();
  const inert = armChild({ role: "explore", stdin: out.stdin, start: 0, opts: {} });
  eq(inert.armed(), false, "AC2: no bound armed → the steer reports itself unarmed");
  for (let t = 1; t <= 500; t++) inert.onAssistantTurn(t, 0);
  eq(out.text(), "", "AC2: and emits nothing, ever (500 turns)");
  inert.stop();

  // The distinction the AC insists on: "no bound" and "bound not yet crossed"
  // must not read the same, because the #546 nudge stands down on one and not
  // the other.
  const early = armChild({ role: "explore", stdin: out.stdin, start: 0, opts: { budgetTurns: 100 } });
  early.onAssistantTurn(3, 0);
  eq(early.armed(), true, "a bound that is not yet crossed still counts as armed");
  eq(out.lines().length, 0, "and still says nothing before its first threshold");
  early.stop();
}

// ── the deck-key path (a lens child steered through the registry) ───────
{
  const out = capture();
  const key = "budget-progress-wiring-lens";
  // A lens child registers its handle under its deck key (#799); the steer
  // resolves that id, so the tagged lifecycle line and the stdin envelope both
  // arrive through the one path the operator's `dispatch_steer` uses.
  registerChildHandle(key, out.stdin, "lens/simplicity", "code-review-specialist");
  const progress = armChild({
    role: "code-review-specialist",
    stdin: out.stdin,
    start: 0,
    deckKey: key,
    opts: { budgetTurns: 2 },
  });
  progress.onAssistantTurn(1, 0);
  progress.onAssistantTurn(2, 0);
  eq(
    out.lines().length,
    2,
    "AC6: a deck-registered child receives both steers through the registry",
  );
  eq(
    out.lines().map((l) => JSON.parse(l).type),
    ["steer", "steer"],
    "each registry steer is one RPC envelope on the child's stdin",
  );
  eq(
    BUDGET_PROGRESS_STEER_SOURCE,
    "driver-budget-progress",
    "the source the registry path tags with is the literal the operator reads",
  );
  const line = formatLine({
    kind: "steered",
    jobId: key,
    label: "lens/simplicity",
    role: "code-review-specialist",
    steerMessage: "Budget: turn 2 of 2. Report your findings now, then end your turn.",
    steerSource: BUDGET_PROGRESS_STEER_SOURCE,
  } satisfies LifecycleDetails);
  assert(
    line.includes("[driver-budget-progress]"),
    `the scrollback line names this cap as the nudger (${line})`,
  );
  progress.stop();

  // A deck key nobody registered — the shape a lens child has once its round
  // ended. `steerChild` answers "no-such-job" and the caller's stdin is the
  // same dead pipe, so nothing is written behind the registry's back.
  const orphan = capture();
  const orphanProgress = armChild({
    role: "code-review-specialist",
    stdin: orphan.stdin,
    start: 0,
    deckKey: "budget-progress-wiring-orphan",
    opts: { budgetTurns: 2 },
  });
  let threw = false;
  try {
    orphanProgress.onAssistantTurn(1, 0);
    orphanProgress.onAssistantTurn(2, 0);
  } catch {
    threw = true;
  }
  assert(!threw, "an unregistered deck key never throws onto the child's hot path");
  eq(orphan.text(), "", "an unregistered deck key is not written to twice on a closed pipe");
  orphanProgress.stop();
}

// ── the stand-down reaches the arm through the spawn's flag ─────────────
{
  const out = capture();
  let armed = false;
  const progress = armChild({
    role: "developer",
    cwd: "/w",
    stdin: out.stdin,
    start: 0,
    boundArmed: () => armed,
    opts: { budgetTurns: 4 },
  });
  armed = true;
  for (let t = 1; t <= 4; t++) progress.onAssistantTurn(t, 0);
  eq(out.text(), "", "a child another bound is already ending gets no progress steer");
  progress.stop();
}

// ── the minutes lever arms without any turns lever ──────────────────────
{
  const out = capture();
  // A synthetic epoch, so the deadline clamp inside the bound's schedule (which
  // is relative to the instant it is asked) cannot shorten the bound out from
  // under the assertions below.
  const start = 1_000_000;
  const BOUND_MS = 600_000;
  const progress = armChild({
    role: "explore",
    stdin: out.stdin,
    start,
    opts: { childBoundMs: BOUND_MS },
  });
  eq(progress.armed(), true, "AC4: maxMinutes alone arms the steer, whatever the role");
  // The denominator is the run bound's FULL schedule — bound plus the wrap-up
  // grace — because that is the child's whole life, and it is the same schedule
  // `armChildBound` arms its timers from. Read back off the schedule rather than
  // written as a literal, so this test cannot drift from the bound's arithmetic.
  // Asked at the spawn's own instant, exactly as the arm asks it: the deadline
  // clamp inside the schedule is relative to `now`, so asking it later measures
  // the child against a bound it never had.
  const total = (childBoundSchedule(BOUND_MS, childBoundGraceMs(), 0).killAtMs ?? 0) - 0;
  assert(
    total > BOUND_MS,
    `the child is paced against bound + grace (${String(total / 60_000)} min, not the bare ${String(BOUND_MS / 60_000)})`,
  );
  // Half, on a minute boundary: the display floors, so an unaligned instant
  // would print 9 and make a correct renderer look off by one.
  const halfAt = start + Math.floor(total / 2 / 60_000) * 60_000;
  progress.onAssistantTurn(1, halfAt);
  eq(out.lines().length, 1, "the minutes lever fires at half");
  const half = JSON.parse(out.lines()[0] ?? "{}");
  // Half the bound means half the time left, to the minute the display floors
  // to — an assertion on the wording alone would pass on a renderer that always
  // printed the total, which is the bug worth catching here.
  const halfMatch = /about (\d+) min left of (\d+)\./.exec(half.message ?? "");
  eq(
    halfMatch?.[1],
    String(Math.floor((total - (halfAt - start)) / 60_000)),
    `at half the bound the child is told it has half left (${half.message})`,
  );
  eq(
    halfMatch?.[2],
    String(Math.floor(total / 60_000)),
    `the total it names is the whole bound it was given (${half.message})`,
  );
  assert(
    (half.message ?? "").startsWith("Budget: turn 1, about "),
    `the line opens with the child's position and carries the minutes clause (${half.message})`,
  );
  assert(
    !/turn 1 of/.test(half.message ?? ""),
    "a turns-less child is never shown a turns figure it has no limit for",
  );
  progress.onAssistantTurn(2, start + total * 0.9);
  eq(out.lines().length, 2, "and again at close-out");
  assert(
    /Report your findings now/.test(JSON.parse(out.lines()[1] ?? "{}").message ?? ""),
    "the close-out instructs a non-committing child on the minutes lever too",
  );
  progress.onAssistantTurn(3, start + total * 1.5); // past the bound
  eq(out.lines().length, 2, "never a third steer, even past the bound");
  progress.stop();
}

// ── an exited child is never written to ─────────────────────────────────
{
  const out = capture();
  const progress = armChild({
    role: "developer",
    cwd: "/w",
    stdin: out.stdin,
    start: 0,
    exited: true,
    opts: { budgetTurns: 2 },
  });
  progress.onAssistantTurn(1, 0);
  progress.onAssistantTurn(2, 0);
  eq(out.text(), "", "advice is never written to a child whose exit the supervisors observed");
  progress.stop();
}

// ── F4: caps off → the minutes lever is NOT armed, so the nudge stays ───
//
// `armChildBound` returns before it arms a timer under PI_ENSEMBLE_DISPATCH_CAPS=0,
// so a minutes-only bound cannot end this child. `armed()` gates the #546 turn
// nudge, so reporting such a bound as armed would silence the one steer that
// still fires — for a bound that will never kill.
{
  const out = capture();
  const progress = withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: "0" }, () =>
    armChild({
      role: "explore",
      stdin: out.stdin,
      start: 1_000_000,
      opts: { childBoundMs: 600_000 },
    }),
  );
  eq(
    progress.armed(),
    false,
    "F4: caps off, a minutes-only lever is not armed (nothing will kill at it)",
  );
  for (let t = 1; t <= 200; t++) progress.onAssistantTurn(t, 1_000_000 + t * 60_000);
  eq(out.text(), "", "and it steers nothing either — an inert bound paces nobody");
  progress.stop();

  // A TURNS lever still arms under caps off: it is paced by the progress steer,
  // which does not depend on the caps stack, so the nudge stands down for it.
  const turnsOut = capture();
  const turnsStillPaces = withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: "0" }, () =>
    armChild({ role: "explore", stdin: turnsOut.stdin, start: 0, opts: { budgetTurns: 4 } }),
  );
  eq(
    turnsStillPaces.armed(),
    true,
    "F4: caps off, a turns lever still arms (the progress steer is not a cap)",
  );
  turnsStillPaces.stop();
}

// ── F1: a steer the seam could not deliver leaves the stage open ────────
//
// The registry path answers `delivered: false` for a child between rounds. An
// implementation that settled the latch on "the seam was called" tells a child
// its position once, fails to land it, and never tells it the close-out — which
// is the half of this feature the child cannot recover from.
{
  const received: Array<{ text: string; source: SteerSource }> = [];
  let deliverable = false;
  // A caller WITH a steer seam and no stdin: the seam's answer is the only
  // delivery evidence, which is exactly the shape `dispatchCore` hands the spawn
  // (`onSteer: … => steerChild(…).delivered`).
  const progress = armChild({
    role: "developer",
    cwd: "/w",
    stdin: new PassThrough(),
    start: 0,
    onSteer: (text, source) => {
      if (deliverable) received.push({ text, source });
      return deliverable;
    },
    opts: { budgetTurns: 10 },
  });
  progress.onAssistantTurn(5, 0);
  eq(received.length, 0, "an onSteer that returns false delivers NOTHING");
  deliverable = true;
  progress.onAssistantTurn(6, 0);
  eq(received.length, 1, "the next turn retries the half line once the seam can deliver");
  assert(
    /turn 6 of 10/.test(received[0]?.text ?? ""),
    `the retry carries the child's CURRENT position, not the turn that failed (${received[0]?.text})`,
  );
  eq(
    received[0]?.source,
    BUDGET_PROGRESS_STEER_SOURCE,
    "the retried line still carries the driver-budget-progress tag",
  );
  progress.onAssistantTurn(8, 0);
  progress.onAssistantTurn(9, 0);
  eq(received.length, 2, "and close-out fires exactly once after it");
  progress.onAssistantTurn(10, 0);
  eq(received.length, 2, "never a third line, however far past the bound it runs");
  progress.stop();
}

console.log(`\nexit ${exitCode()}`);
process.exit(exitCode());
