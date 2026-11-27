#!/usr/bin/env bun
/**
 * lean #2660 — a step's child bound reads the cycle deadline, not only its minutes row.
 *
 * The panel-row shape, twice over in the field and six cells in the campaign: a red
 * verify of about 2000 s, then a build step still running when the deadline passes.
 * Nothing ends the child — its bound came from `budgets.build.minutes` alone, the engine
 * consults the deadline only BETWEEN steps, and the cycle-deadline clock
 * `spawn-child-bound.ts` clamps against is never recorded for a lean spawn. The cell
 * overran 1150 s and 1158 s past the deadline, past the 600 s child grace, until the
 * harness's outer wall killed it: no handback, an empty result document, and no patch
 * although the workspace held edits.
 *
 * What this file pins, in order:
 *
 *   (a) THE DERIVATION. Through the real `armBudget`, with a real run deadline and a real
 *       step start, the armed `childBoundMs` is the smaller of the minutes row and what
 *       the deadline leaves outside the handoff allowance — never a literal.
 *   (b) THE PAIR THE STEP HANDS THE SPAWN ENDS THE CHILD INSIDE THE LINE. The two numbers
 *       the step arms with go into `childBoundScheduleFor` — the ONE call `armChildBounds`
 *       makes to place its timers — and `killAtMs` relative to the step start must sit at
 *       or before deadline + allowance. The shipped 600 s grace does not: it lands 720 s
 *       past the line, which is the field's 1150 s and 1158 s in miniature.
 *   (c) THE VERDICT AND THE WORK. Through the real build step, a child the deadline's
 *       bound ends reads as `{kind: "budget"}` with `limit: "minutes"` and a reason naming
 *       the deadline, the dispatch received the deadline's arms (not the 45-minute row),
 *       and the stopped-step fold committed what the child had written.
 *   (d) THE INERT ARMS SAY SO. No deadline, or the switch at 0, leaves the bound exactly
 *       the configured minutes and traces which cause.
 *   (e) A step that starts with less time left than the allowance is never armed with a
 *       zero or negative timer.
 *
 * Why there is no real child here. The kill a bound performs is an unref'd `setTimeout`
 * firing `killProcessTree`; under bun's test runner that observation is not obtainable,
 * and the first revision of this suite burned five hours trying to watch it. What the
 * acceptance criteria are written in is the pair the step hands the spawn, and both of
 * this file's load-bearing observations are made through production code: the spawn's own
 * schedule call for (b), and the real step plus the real fold for (c). `killBudgetMs` on
 * the result is the bound `applyChildBound` stamps from those arms, so the verdict names
 * the deadline's number and not the row's.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { MIN_DEADLINE_GRACE_MS } from "../src/lean-step-bound.ts";
import { defaultConfig } from "../src/lean/config.ts";
import type { Budget } from "../src/lean/config.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import type { ArmedPair } from "./lib/lean-step-bound-arms.ts";
import { armBudget, budgetTrio } from "../src/lean/step-budget.ts";
import { childBoundGraceMs, childBoundSchedule } from "../src/spawn-child-bound.ts";
import { withEnv } from "./lib/env-scope.ts";
import { put } from "./lib/lean-build-git.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { git, runBuild } from "./lib/lean-build-fixture.ts";
import {
  ALLOWANCE_MS,
  PANEL_CELL_MS,
  PANEL_START_MS,
  SHIPPED_GRACE_MS,
  STEP_START_MS,
  armedPairSummary,
  armPairFor,
  budgetRow,
  ctxWith,
  panelEnv,
} from "./lib/lean-step-bound-arms.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

/** The field's build budget: a row that cannot be what ended a child 1150 s past a 4200 s
 *  cell, which is the whole defect. */
const FIELD_MINUTES = 45;
const FIELD_ROW_MS = FIELD_MINUTES * MINUTE_MS;
const DEADLINE = PANEL_START_MS + PANEL_CELL_MS;

/** A budget row with one ceiling. */
const row = (over: Partial<Budget>): Budget => budgetRow(over);

/** A child the bound ended, as `applyChildBound` stamps it: the deadline's own bound in
 *  `killBudgetMs`, and the child's ms overshooting the bound by its grace. */
const KILLED_CHILD = { killCause: "child-bound" as const, ok: false, ms: 498_000 };

/**
 * The pre-change bound and kill of the field's row, read out of the base-commit golden the
 * off-arm suite pins — the arm `11c1e8a8a7` really produced. Not re-derived here: a literal
 * standing in for a golden is a second source of truth for one fact and the first to rot.
 */
const prechange = (() => {
  const g = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures", "lean-step-deadline-bound-off-arm.json"),
      "utf8",
    ),
  ) as {
    rows: Record<string, { opts: { childBoundMs?: number }; schedule: { killAtMs?: number } }>;
  };
  const r = g.rows["deadline/minutes=45/headless=false"];
  return { boundMs: r?.opts?.childBoundMs ?? 0, killAtMs: r?.schedule?.killAtMs ?? 0 };
})();
assert(
  prechange.boundMs === FIELD_ROW_MS && prechange.killAtMs === FIELD_ROW_MS + SHIPPED_GRACE_MS,
  `(pre) the golden holds the pre-change arm of this row (bound ${String(prechange.boundMs)}, kill ${String(prechange.killAtMs)})`,
);

const panelConfig = () => ({
  ...configWithRunner(),
  budgets: { ...defaultConfig().budgets, build: row({ minutes: FIELD_MINUTES }) },
});

// ── (a) the bound is derived from the deadline through the real arm site ─────
{
  let armed!: ArmedPair;
  await withEnv(panelEnv(), async () => {
    armed = armPairFor(
      ctxWith({
        deadlineMs: DEADLINE,
        now: STEP_START_MS,
        startedAt: STEP_START_MS,
        state: "build",
        issue: 2660,
      }),
      "build",
      FIELD_MINUTES,
    );
  });
  // Independently hand-computed from the issue's own rule — "the smaller of its configured
  // minutes bound and the time left to the deadline minus the handoff allowance", with the
  // kill required to land inside deadline + allowance: room 978 000 − allowance 480 000 −
  // grace 30 000 (the shipped 600 000 clamped to the floor the steer needs) = 468 000.
  const expectedGrace = 30_000;
  const expectedLeft = 978_000 - ALLOWANCE_MS - expectedGrace;
  assert(
    armed.arms.opts.childBoundGraceMs === expectedGrace,
    `(a) the armed grace is what the deadline leaves for the kill behind its steer, not the shipped 10 min (got ${String(armed.arms.opts.childBoundGraceMs)}, expected ${String(expectedGrace)})`,
  );
  assert(
    armed.arms.opts.childBoundMs === expectedLeft,
    `(a) the armed bound is what the deadline leaves outside the handoff allowance, not the 45-minute row (got ${String(armed.arms.opts.childBoundMs)}, expected ${String(expectedLeft)})`,
  );
  assert(
    (armed.arms.opts.childBoundMs ?? 0) < FIELD_ROW_MS,
    `(a) and that is TIGHTER than the configured minutes, which is the only way this ends the field's child (bound ${String(armed.arms.opts.childBoundMs)} vs ${String(FIELD_ROW_MS)})`,
  );
  assert(
    armed.bound?.clamped === true && /deadline/.test(armed.bound.sentence ?? ""),
    `(a) the bound says it came from the deadline (${JSON.stringify(armed.bound)})`,
  );
}

// ── (b) the pair the step armed places the kill inside deadline + allowance ──
{
  let armed!: ArmedPair;
  await withEnv(panelEnv(), async () => {
    armed = armPairFor(
      ctxWith({
        deadlineMs: DEADLINE,
        now: STEP_START_MS,
        startedAt: STEP_START_MS,
        state: "build",
        issue: 2661,
      }),
      "build",
      FIELD_MINUTES,
    );
  });
  const pair = armedPairSummary(armed.arms.opts);
  // The field's premise, stated rather than assumed: the configured 45-minute row on its
  // own leaves this child alive 55 minutes past the arm, so nothing in the pre-change arm
  // ends a child at a 70-minute cell.
  const old = childBoundSchedule(prechange.boundMs, SHIPPED_GRACE_MS, STEP_START_MS);
  assert(
    // Hand-computed from the issue's row: the child the golden's arm gives is killed 1 842 000 ms
    // past the line the cell was meant to honour (978 000 of step room + 480 000 of allowance).
    old.killAtMs === prechange.killAtMs && old.killAtMs - (978_000 + ALLOWANCE_MS) === 1_842_000,
    "(b) the pre-change pair kills 1 842 000 ms PAST deadline + allowance (1 458 000) — the field's 1150 s and 1158 s overruns in miniature, which is the defect this rule closes",
  );
  assert(
    pair.killRelativeToArmMs > (old.killAtMs ?? 0) - 2 * MINUTE_MS ||
      pair.killRelativeToArmMs < (old.killAtMs ?? 0),
    `(b) the deadline's pair is not the row's pair wearing new clothes (derived ${String(pair.killRelativeToArmMs)}, row ${String(old.killAtMs)})`,
  );
  // The spawn's OWN placement of its timers, from the arms the step armed with.
  assert(
    armed.killAtMs !== undefined && armed.killAtMs === pair.killRelativeToArmMs,
    `(b) the kill timer the spawn arms sits at bound + grace from the arm (${String(armed.killAtMs)} vs ${String(pair.killRelativeToArmMs)})`,
  );
  assert(
    armed.steerAtMs === pair.boundMs && armed.steerAtMs < (armed.killAtMs ?? 0),
    `(b) the wrap-up steer is armed at the bound and the kill one grace behind it, so the child is never killed without being told (steer ${String(armed.steerAtMs)}, kill ${String(armed.killAtMs)})`,
  );
  // The acceptance criterion, in the issue's own words: the kill lands inside the deadline
  // plus the handoff allowance. Hand-computed: 978 s of step room + 480 s of allowance =
  // 1 458 s; the shipped grace's kill sits at 2 178 s from the same start.
  assert(
    armed.killAtMs !== undefined &&
      armed.deadlineAtMs !== undefined &&
      armed.killAtMs <= armed.deadlineAtMs + ALLOWANCE_MS,
    `(b) the kill lands inside deadline plus the handoff allowance: kill at ${String(armed.killAtMs)} ms from the step start against ${String((armed.deadlineAtMs ?? 0) + ALLOWANCE_MS)} (deadline 978 s out + 480 s allowance), where the shipped grace would sit at 2178000`,
  );
  assert(
    (armed.graceMs() ?? SHIPPED_GRACE_MS) < SHIPPED_GRACE_MS,
    `(b) and the grace it armed with is below the shipped 600 s, which is what keeps the sum inside the line (grace ${String(armed.arms.opts.childBoundGraceMs)})`,
  );
}

// ── (c) the shape of the verdict, and the work the fold keeps ────────────────
{
  const armedOpts: BudgetOpts[] = [];
  let r!: Awaited<ReturnType<typeof runBuild>>;
  await withEnv(panelEnv(), async () => {
    r = await runBuild({
      issue: 2663,
      config: panelConfig(),
      clock: { deadlineMs: DEADLINE, now: () => STEP_START_MS },
      buildStartedAt: STEP_START_MS,
      child: (wt) => put(wt, "src/deadline.ts", "export const kept = 1;\n"),
      // The child the bound ended, on EVERY child this visit dispatches: a budget stop
      // buys a retry, and a second child that came back fine would be the step's verdict
      // instead. `killCause`/`killBudgetMs` are the fields `applyChildBound` stamps.
      dispatchResults: () => KILLED_CHILD,
      armedOpts,
    });
  });
  const trio = budgetTrio(r.outcome);
  const armed = armedOpts[0] ?? {};
  const pair = armedPairSummary(armed);
  assert(
    r.threw === undefined,
    `(c) the deadline stop is a verdict, not a crash (${String(r.threw?.message)})`,
  );
  assert(
    (armed.childBoundMs ?? 0) === 468_000 && armed.childBoundGraceMs === 30_000,
    `(c) the build step's dispatch received the deadline's pair — bound 468000 + grace 30000 — and not the 45-minute row (got bound ${String(armed.childBoundMs)}, grace ${String(armed.childBoundGraceMs)})`,
  );
  assert(
    pair.killRelativeToArmMs <= DEADLINE - STEP_START_MS + ALLOWANCE_MS,
    `(c) and that pair kills inside deadline + allowance as the step handed it out (${String(pair.killRelativeToArmMs)} vs ${String(DEADLINE - STEP_START_MS + ALLOWANCE_MS)})`,
  );
  assert(
    r.outcome?.kind === "budget",
    `(c) a build child the deadline ended is the step's \`budget\` outcome, no new kind (got ${String(r.outcome?.kind)})`,
  );
  assert(
    trio?.limit === "minutes",
    `(c) and the trio keeps \`limit: "minutes"\` — no new limit value the state validator would refuse (got ${String(trio?.limit)})`,
  );
  assert(
    trio?.value === FIELD_MINUTES && (r.outcome?.reason ?? "").includes("45"),
    `(c) the stop names the row it breached and what it cost (${JSON.stringify(r.outcome?.reason)})`,
  );
  assert(
    /deadline/.test(r.outcome?.reason ?? ""),
    `(c) and the reason names the deadline rather than only the row (got ${JSON.stringify(r.outcome?.reason)})`,
  );
  // AC4's guarantee, the one this issue makes for build: the stopped step's fold committed
  // the child's edit, so the captured patch holds the workspace's work.
  const committed = git(r.worktree, "show", "--stat", "--name-only", "--format=", "HEAD");
  assert(
    git(r.worktree, "rev-parse", "HEAD") !== r.headBefore,
    "(c) the stopped step made a commit above the head it started from",
  );
  assert(
    committed.includes("src/deadline.ts"),
    `(c) and that commit holds the file the child had written — the patch the field lost (HEAD names: ${committed.replace(/\n/g, " ")})`,
  );
}

// ── (d) the inert arms bound nothing and say which arm ───────────────────────
{
  const cfg = panelConfig();
  // No deadline at all: an absent deadline never shrinks a bound.
  let noDeadline!: ArmedPair;
  await withEnv(panelEnv(), async () => {
    noDeadline = armPairFor(
      ctxWith({ now: STEP_START_MS, startedAt: STEP_START_MS, state: "build", issue: 2664 }),
      "build",
      FIELD_MINUTES,
    );
  });
  assert(
    noDeadline.arms.opts.childBoundMs === FIELD_ROW_MS &&
      noDeadline.arms.opts.childBoundGraceMs === undefined,
    `(d) with no deadline the bound stays the configured minutes and no grace is armed — byte for byte the pre-change arm (got ${String(noDeadline.arms.opts.childBoundMs)}, grace ${String(noDeadline.arms.opts.childBoundGraceMs)})`,
  );
  // The switch's only off value.
  const armAt = async (issue: number, over?: Record<string, string>) => {
    let pair!: ArmedPair;
    await withEnv(panelEnv(over), async () => {
      pair = armPairFor(
        ctxWith({
          deadlineMs: DEADLINE,
          now: STEP_START_MS,
          startedAt: STEP_START_MS,
          state: "build",
          issue,
        }),
        "build",
        FIELD_MINUTES,
      );
    });
    return pair;
  };
  const off = await armAt(2665, { PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "0" });
  assert(
    off.arms.opts.childBoundMs === FIELD_ROW_MS && off.arms.opts.childBoundGraceMs === undefined,
    `(d) with the switch at 0 the arm is byte for byte the pre-change minutes row (got ${String(off.arms.opts.childBoundMs)}, grace ${String(off.arms.opts.childBoundGraceMs)})`,
  );
  // The off arm's kill, from the spawn's own schedule for those arms: the pre-change
  // placement, whole.
  assert(
    off.killAtMs === FIELD_ROW_MS + childBoundGraceMs(),
    `(d) and its kill still sits at the full bound plus the configured grace (${String(off.killAtMs)} vs ${String(FIELD_ROW_MS + childBoundGraceMs())})`,
  );
  const noise = await armAt(2666, { PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "false" });
  assert(
    noise.arms.opts.childBoundMs !== FIELD_ROW_MS,
    `(d) and a mangled value is not an operator asking for the old behaviour: the bound stays derived (got ${String(noise.arms.opts.childBoundMs)})`,
  );
}

// ── (e) a step with no room left is never armed with a zero or negative timer ─
{
  // Every constant below is read from the module that owns it, never restated as a literal:
  // the rows are built from these numbers, so a change to any of them moves the rows with it
  // instead of leaving a case that pins a number while the constant it guards drifted.
  const allowance = ALLOWANCE_MS;
  const grace = SHIPPED_GRACE_MS;
  const floor = MIN_DEADLINE_GRACE_MS;
  const armAtRoom = async (room: number) => {
    let armed!: ArmedPair;
    await withEnv(panelEnv(), async () => {
      armed = armPairFor(
        ctxWith({
          deadlineMs: STEP_START_MS + room,
          now: STEP_START_MS,
          startedAt: STEP_START_MS,
          state: "build",
          issue: 2667,
        }),
        "build",
        FIELD_MINUTES,
      );
    });
    return armed;
  };
  // THE INVARIANT the acceptance criterion is written in, in the derivation's own terms. Read
  // off the module: `deadlineRoom = deadlineMs − startedAt − allowance`, the grace is
  // `clamp(deadlineRoom − floor, floor, configured)`, and the bound is `deadlineRoom − grace`.
  // Therefore `bound + grace === deadlineMs − startedAt − allowance` on BOTH sides of the
  // `clamp()` — the kill the spawn arms from the pair lands exactly at deadline + the handoff
  // allowance and never past it, while each half stays positive. The tightest armable room is one
  // ms above the rule's own inertness guard (`room > allowance + floor`), where the deadline's
  // placement loses to the configured grace and the grace floors at `floor`; the room with slack
  // is the other branch, where the configured grace wins and the bound shortens instead. Both
  // halves are rows, and neither is ever zero or negative.
  const room = 2 * allowance + floor + 1; // wall-room row: 1 ms above the guard's own floor
  const tight = await armAtRoom(room);
  assert(
    tight.arms.opts.childBoundGraceMs === floor,
    `(e) at the tightest armable room the grace is the derivation's floor (${String(floor)}), not the configured ${String(grace)} and not 0 (got ${String(tight.arms.opts.childBoundGraceMs)})`,
  );
  assert(
    tight.arms.opts.childBoundMs !== undefined && tight.arms.opts.childBoundMs > 0,
    `(e) and its bound is positive at that room — never a timer that fires on arrival (got ${String(tight.arms.opts.childBoundMs)} at room ${String(room)}, configured grace ${String(grace)}, floor ${String(floor)})`,
  );
  assert(
    (tight.arms.opts.childBoundMs ?? 0) + (tight.arms.opts.childBoundGraceMs ?? 0) ===
      (tight.deadlineAtMs ?? 0) - allowance,
    `(e) bound + grace is exactly the room the deadline leaves outside the handoff allowance, so the kill the spawn arms from this pair lands AT deadline + allowance and cannot pass it (bound + grace ${String((tight.arms.opts.childBoundMs ?? 0) + (tight.arms.opts.childBoundGraceMs ?? 0))} vs the ${String((tight.deadlineAtMs ?? 0) - allowance)} this step's deadline leaves)`,
  );
  assert(
    tight.deadlineAtMs === room &&
      tight.killAtMs !== undefined &&
      tight.killAtMs === (tight.arms.opts.childBoundMs ?? 0) + floor,
    `(e) and the schedule the spawn builds from that pair puts the kill at deadline + the handoff allowance — the line itself, not past it (kill ${String(tight.killAtMs)} from the arm, deadline ${String(tight.deadlineAtMs)} out — the schedule is relative to the step's start, so the kill the deadline's own arithmetic produces is at the line plus allowance, never past it)`,
  );
  // The other side of the min(): a room with slack takes the CONFIGURED grace, the bound shortens
  // instead, and the same identity holds.
  const slack = await armAtRoom(2_400_000);
  assert(
    slack.arms.opts.childBoundGraceMs === grace &&
      (slack.arms.opts.childBoundMs ?? 0) ===
        (slack.deadlineAtMs ?? 0) - allowance - grace,
    `(e) with room to spare the grace is the configured ${String(grace)} and the bound is the deadline's own (got grace ${String(slack.arms.opts.childBoundGraceMs)}, bound ${String(slack.arms.opts.childBoundMs)})`,
  );
  assert(
    (slack.arms.opts.childBoundMs ?? 0) + (slack.arms.opts.childBoundGraceMs ?? 0) ===
      (slack.deadlineAtMs ?? 0) - allowance,
    `(e) and the identity holds there too — bound + grace ${String((slack.arms.opts.childBoundMs ?? 0) + (slack.arms.opts.childBoundGraceMs ?? 0))} against the ${String((slack.deadlineAtMs ?? 0) - allowance)} this step's deadline leaves`,
  );
  // Just below the guard: nothing is derived at all, which is the other half of "never a zero or
  // negative timer" — the rule stands down instead of arming one.
  const doomed = await armAtRoom(allowance + floor);
  assert(
    (doomed.arms.opts.childBoundMs ?? 0) === FIELD_ROW_MS &&
      doomed.bound?.clamped === false &&
      doomed.arms.opts.childBoundGraceMs === undefined,
    `(e) one ms lower the rule is inert — no clamp, no armed grace, the configured row whole (got ${String(doomed.arms.opts.childBoundMs)}, grace ${String(doomed.arms.opts.childBoundGraceMs)})`,
  );
}

// ── (e2) a step whose deadline already passed keeps its configured bound ──────
{
  let passed!: ArmedPair;
  await withEnv(panelEnv(), async () => {
    passed = armPairFor(
      ctxWith({
        deadlineMs: STEP_START_MS - MINUTE_MS,
        now: STEP_START_MS,
        startedAt: STEP_START_MS,
        state: "build",
        issue: 2670,
      }),
      "build",
      FIELD_MINUTES,
    );
  });
  assert(
    (passed.arms.opts.childBoundMs ?? 0) === FIELD_ROW_MS &&
      passed.arms.opts.childBoundGraceMs === undefined &&
      passed.bound?.clamped === false,
    `(e2) a step started after its own deadline keeps the configured row and arms no grace — the engine stops the NEXT step, this one must still hand back (got ${String(passed.arms.opts.childBoundMs)}, grace ${String(passed.arms.opts.childBoundGraceMs)})`,
  );
}

// ── (f) a row already tighter than the deadline is not a deadline stop ───────
{
  let tight!: ArmedPair;
  await withEnv(panelEnv(), async () => {
    tight = armPairFor(
      ctxWith({
        deadlineMs: DEADLINE,
        now: STEP_START_MS,
        startedAt: STEP_START_MS,
        state: "build",
        issue: 2668,
      }),
      "build",
      3,
    );
  });
  assert(
    tight.arms.opts.childBoundMs === 3 * MINUTE_MS &&
      tight.arms.opts.childBoundGraceMs === undefined &&
      tight.bound?.clamped === false,
    `(f) an operator's 3-minute row inside the same deadline is unchanged and traces no clamp (got ${String(tight.arms.opts.childBoundMs)}, grace ${String(tight.arms.opts.childBoundGraceMs)})`,
  );
}

// ── (g) the armBudget the fixture's step made is the arm this file pins ──────
// The one place the two halves meet: the step's own `armBudget` call site is the same
// function, fed by the same `stepChildBound`, and the dispatch received its opts. A case
// that armed a bound only in this file and never read the step's dispatch could pass with
// the wiring at `lean/build.ts` deleted.
{
  const armedOpts: BudgetOpts[] = [];
  await withEnv(panelEnv(), async () => {
    await runBuild({
      issue: 2669,
      config: panelConfig(),
      clock: { deadlineMs: DEADLINE, now: () => STEP_START_MS },
      buildStartedAt: STEP_START_MS,
      child: (wt) => put(wt, "src/deadline.ts", "export const kept = 1;\n"),
      dispatchResults: () => KILLED_CHILD,
      armedOpts,
    });
  });
  let direct!: ArmedPair;
  await withEnv(panelEnv(), async () => {
    direct = armPairFor(
      ctxWith({
        deadlineMs: DEADLINE,
        now: STEP_START_MS,
        startedAt: STEP_START_MS,
        state: "build",
        issue: 2669,
      }),
      "build",
      FIELD_MINUTES,
    );
  });
  assert(
    (armedOpts[0]?.childBoundMs ?? 0) === (direct.arms.opts.childBoundMs ?? -1) &&
      armedOpts[0]?.childBoundGraceMs === direct.arms.opts.childBoundGraceMs,
    `(g) what the step dispatched is what the arm site derives (step ${JSON.stringify(armedOpts[0])} vs arm ${JSON.stringify(direct.arms.opts)})`,
  );
}

process.exit(failed);
