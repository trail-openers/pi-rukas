#!/usr/bin/env bun
/**
 * The pre-verify share, on the panel's own row (#2634).
 *
 * A 4200-second cell whose `specify` spent 1312 s and whose `challenge` was about to start: the
 * pair had already used more of the cell than the share allows, so the round is SKIPPED — with a
 * stable one-line reason on the durable record — and the run goes on to `verify`, whose gate is
 * the thing the cell was armed to reach. The second row is the control the field showed too: the
 * same cell where `specify` spent 565 s, where the round runs.
 *
 * The clock is a fake one (`cell` starts at zero and every reading is the case's), so the numbers
 * in the assertions are the panel's seconds rather than a fixture's accident. The reserve side of
 * the skip rule is read through `handoffAllowanceMs()` and `REVIEW_DEADLINE_RESERVE_MS`, never a
 * literal, and the tests pin `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` so a host's exported allowance
 * cannot move the floor under them — which is also AC3's guarantee: the review step's own reserve
 * rule is untouched, and (e) says so by driving the review bound on the same inputs.
 *
 *   (a) share used up at challenge entry  -> `skipped`, its reason, no child, no reset
 *   (b) share unspent                     -> the round runs (the control row)
 *   (c) time left below reserve + one verify -> `skipped` on the deadline's own reason
 *   (d) inert arms: no deadline, and `PI_ENSEMBLE_DISPATCH_CAPS=0` — nothing bounded, and it says so
 *   (e) `specify` past the share buys no retry, and the review reserve rule still fires
 *   (f) `challenge: skipped` is the optional round: verify with `challengeDone`, no build round
 *
 * The off arm is NOT proved here. Every expected byte this file asserts about the off arm comes from
 * the same module the change under review owns, so it could only ever equal itself; the off arm's
 * byte-identity against `main` is pinned by `test-lean-pre-verify-share-off-arm.ts` against a record
 * captured from the pre-change tree. This file exercises what that tree could not reach at all: the
 * `skipped` kind, its reason, and its routing.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import { next } from "../src/lean/machine.ts";
import {
  ONE_VERIFY_MS,
  type PreVerifyShare,
  challengeSkip,
  preVerifyShare,
} from "../src/lean/pre-verify-share.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../src/lean/review-bound.ts";
import { INITIAL_COUNTERS, type LeanRun, type Outcome, type Step } from "../src/lean/state.ts";
import { leanStateFile, loadRun } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { runChallenge } from "./lib/lean-challenge-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { MIN, cfg, ctxWithClock, slowDeps } from "./lib/lean-review-bound-fixtures.ts";
import { BRANCH, makeRepo, runStep, setup } from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

const SEC = 1000;
/** The panel's cell: 4200 s, and the run's own start on the fake clock. */
const CELL_S = 4200;
const START = 1_700_000_000_000;
const DEADLINE = START + CELL_S * SEC;
/** The shipped share, spelled here so a case can say what fraction of the cell it expects. */
const SHARE_MS = Math.floor((CELL_S * SEC * 40) / 100);

/** A decided `specify` step that spent `seconds` of the cell. */
function specifyTook(seconds: number): Step {
  return {
    key: "7:specify:0",
    state: "specify",
    startedAt: START,
    endedAt: START + seconds * SEC,
    outcome: { kind: "ok" },
  };
}

/** The pair's spend, and the challenge entry instant, for a `specify` that took `seconds`. */
function entryAt(seconds: number): { steps: Step[]; now: number } {
  return { steps: [specifyTook(seconds)], now: START + seconds * SEC };
}

// ── (a) the panel row: specify 1312 s, the round about to start with the share nearly used ──
{
  // The field's row: a 4200 s cell whose `specify` spent 1312 s, which offered the round at all
  // only after the cell had also BUILT. The pair's own spend is `specify` plus every `challenge`
  // visit — the build round is the gate's downstream, not part of the pair this bound holds — so
  // at entry the share is all but spent (1312 of 1680 s) and the deadline leaves 2521 s, under
  // the reserve plus one verify. The skip is therefore the clock's, and the reason says so.
  const spec = specifyTook(1312);
  const build: Step = {
    key: "7:build:0",
    state: "build",
    startedAt: spec.endedAt as number,
    endedAt: (spec.endedAt as number) + 367 * SEC,
    outcome: { kind: "ok" },
  };
  const steps = [spec, build];
  const now = build.endedAt as number;
  const share = preVerifyShare(steps, DEADLINE, START, now);
  assert(
    share.stop === undefined && share.usedSeconds === 1312,
    `(a) the pair is specify plus challenge only — a build round is not charged to it (got ${JSON.stringify(share)})`,
  );
  const r = challengeSkip(steps, DEADLINE, START, now);
  assert(
    r.stop === true,
    `(a) the round is still skipped, on the time left (got ${JSON.stringify(r)})`,
  );
  assert(
    (r.reason ?? "").startsWith(
      "challenge SKIPPED: cycle deadline left 42 min, inside the 43 min reserve plus one verify",
    ),
    `(a) the reason line is the stable one the bench counts (got ${JSON.stringify(r.reason)})`,
  );
  assert(
    (r.reason ?? "").includes("(used 1312s)"),
    `(a) and it carries the pair's spend, so the TSV column needs no second field (got ${JSON.stringify(r.reason)})`,
  );
  // The same row with the share itself spent: the share's own line takes over, same shape.
  const over = challengeSkip([specifyTook(1700)], DEADLINE, START, now);
  assert(
    (over.reason ?? "").startsWith(
      "challenge SKIPPED: pre-verify share 40% of the 4200s cell used up",
    ),
    `(a) once the share itself is spent the reason is the share's (got ${JSON.stringify(over.reason)})`,
  );
  // A resumed cell: a second challenge visit is charged on top of the first, not reset.
  const twice = challengeSkip(
    [
      specifyTook(700),
      {
        key: "7:challenge:0",
        state: "challenge",
        startedAt: START,
        endedAt: START + 1000 * SEC,
        outcome: { kind: "new-tests" },
      },
    ],
    DEADLINE,
    START,
    START + 1701 * SEC,
  );
  assert(
    twice.usedSeconds === 1700 && twice.stop === true,
    `(a) every visit counts, so a resumed pair is charged what the cell really spent (got ${JSON.stringify(twice)})`,
  );
}

// ── (b) the control row: specify spent 565 s, the round runs ─────────────────────────
{
  const { steps, now } = entryAt(565);
  const r: PreVerifyShare = challengeSkip(steps, DEADLINE, START, now);
  assert(
    r.stop === undefined && r.inert === false,
    `(b) with specify at 565 s the round runs, unbounded (got ${JSON.stringify(r)})`,
  );
  assert(
    r.usedSeconds === 565,
    `(b) and its spend is on the record (got ${String(r.usedSeconds)})`,
  );
}

// ── (c) the deadline floor: reserve + one verify, read through the review's own helpers ──
// Pinned inside the block so a host's exported `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` cannot move
// the floor under the numbers this case states — the field's observed 8-to-17 minutes is
// exactly this arithmetic at other instants.
const pinned = await withEnv({ PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(8 * MIN) }, async () => {
  const floorMs = handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS + ONE_VERIFY_MS;
  assert(
    floorMs === 8 * MIN + REVIEW_DEADLINE_RESERVE_MS + ONE_VERIFY_MS,
    `the floor is the handoff allowance plus the review reserve plus one verify (${String(floorMs)})`,
  );
  // The share is UNspent (specify took 565 s) and only the clock is short: the skip must be
  // the deadline's, not the share's.
  const { steps } = entryAt(565);
  const late = DEADLINE - floorMs;
  const inside = challengeSkip(steps, DEADLINE, START, late);
  assert(
    inside.stop === true && (inside.reason ?? "").includes("cycle deadline left"),
    `(c) a round that would eat the reserve and the gate is skipped on the clock's own reason (got ${JSON.stringify(inside)})`,
  );
  const outside = challengeSkip(steps, DEADLINE, START, late - SEC);
  assert(
    outside.stop === undefined,
    `(c) one second of room above the floor and the round runs (got ${JSON.stringify(outside)})`,
  );
});
assert(pinned === undefined, "(c) the pinned arm returns nothing to carry");

// ── (d) the inert arms: no resolved deadline, and the caps master switch ─────────────
{
  const { steps, now } = entryAt(1312);
  const noDeadline = challengeSkip(steps, undefined, START, now);
  assert(
    noDeadline.inert === true && noDeadline.stop === undefined,
    `(d) with no resolved deadline the bound does nothing and says so (got ${JSON.stringify(noDeadline)})`,
  );
  const noStart = challengeSkip(steps, DEADLINE, undefined, now);
  assert(
    noStart.inert === true && noStart.stop === undefined,
    `(d) and a run that never recorded its start is bounded by nothing (got ${JSON.stringify(noStart)})`,
  );
  await withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: "0" }, async () => {
    const capsOff = challengeSkip(steps, DEADLINE, START, now);
    assert(
      capsOff.inert === true && capsOff.stop === undefined,
      `(d) with PI_ENSEMBLE_DISPATCH_CAPS=0 nothing is bounded, and the arm is disclosed (got ${JSON.stringify(capsOff)})`,
    );
    // The share at `0` switches the whole change off, on both arms.
    await withEnv({ PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE: "0" }, async () => {
      const off = challengeSkip(steps, DEADLINE, START, now);
      assert(
        off.stop === undefined,
        `(d) with the switch at 0 the round runs (got ${JSON.stringify(off)})`,
      );
    });
  });
}

/** A run sitting in `challenge`, for the routing and record cases. */
const panelRun: LeanRun = {
  schema: 1,
  issue: 7,
  version: "test",
  models: {},
  baseSha: "sha",
  branch: "b",
  state: "challenge",
  counters: { ...INITIAL_COUNTERS },
  steps: [],
};

// ── (f) the skip routes as the optional round it is ──────────────────────────────────
{
  const moved = next(panelRun, {
    kind: "skipped",
    reason: "challenge SKIPPED: x",
  } satisfies Outcome);
  assert(moved.state === "verify", `(f) challenge + skipped goes to verify (got ${moved.state})`);
  assert(
    moved.counters.challengeDone === true,
    "(f) with the optional round marked done, so it is never offered again",
  );
  assert(
    moved.counters.buildAttempts === panelRun.counters.buildAttempts,
    "(f) and it bills no build round — no child ran, so nothing was dispatched",
  );
}

// ── (a′) the step itself: no dispatch, no reset, and the reason on the record ────────
{
  const r = await runChallenge({
    issue: 2634,
    deadlineMs: DEADLINE,
    cellStartedAt: START,
    specifySeconds: 1312,
    buildSeconds: 367,
    challengeAt: START + 1679 * SEC,
    toolUses: [],
  });
  assert(
    r.outcome?.kind === "skipped",
    `(a') the step returns the new kind (got ${JSON.stringify(r.outcome ?? r.threw)})`,
  );
  assert(
    (r.outcome?.reason ?? "").startsWith("challenge SKIPPED:"),
    `(a') its reason is the bound's own line, on the durable record (got ${JSON.stringify(r.outcome?.reason)})`,
  );
  assert(r.dispatched === 0, `(a') and no adversary was dispatched (got ${String(r.dispatched)})`);
  assert(
    r.fetched === 0,
    `(a') the issue was not even re-read — the skip is before every precondition`,
  );
}

// ── (b′) the control through the step: the round really runs ─────────────────────────
{
  const r = await runChallenge({
    issue: 2635,
    deadlineMs: DEADLINE,
    cellStartedAt: START,
    specifySeconds: 565,
    toolUses: [],
  });
  assert(
    r.threw === undefined && r.outcome?.kind !== "skipped",
    `(b') the control row is not skipped (got ${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(r.dispatched === 1, `(b') and its adversary ran (got ${String(r.dispatched)})`);
}

// ── (e) the review reserve rule is untouched, on the same clock ──────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const bought = slowDeps();
  const now = START + 4000 * SEC;
  const { outcome, threw } = await runStep(
    ctxWithClock(repoRoot, baseSha, BRANCH, {
      startedAt: now - MIN,
      now: () => now,
      deadlineMs: now + handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS - MIN,
    }),
    { ...bought, loadConfig: async () => cfg(0) },
  );
  assert(
    bought.gates === 0,
    `(e) the review step's own reserve still stops it before it buys anyone (gates ${String(bought.gates)})`,
  );
  const rec = (threw as { reviewBound?: { reason?: string } } | undefined)?.reviewBound;
  assert(
    outcome === undefined &&
      rec?.reason !== undefined &&
      rec.reason.includes("cycle deadline left 22 min"),
    `(e) the review step's reserve stop is unchanged, in its own words (got ${JSON.stringify(outcome ?? threw?.message)})`,
  );
  assert(
    !(rec?.reason ?? "").includes("challenge"),
    "(e) and it is the review step's sentence, not the pre-verify one",
  );
}

process.exit(failures());

/** The durable loader's answer for one log, or the reason it refused. */
function loadRunOf(run: LeanRun): string | undefined {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-share-"));
  mkdirSync(path.dirname(leanStateFile(dir, run.issue)), { recursive: true });
  writeFileSync(leanStateFile(dir, run.issue), JSON.stringify(run), "utf8");
  try {
    loadRun(dir, run.issue);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

// ── (g) the record rules: `skipped` is a decision, not a ceiling ───────────────────
{
  const step = (outcome: Record<string, unknown>): Step => ({
    key: "7:challenge:0",
    state: "challenge",
    startedAt: START,
    outcome: outcome as unknown as Outcome,
  });
  const okRun = (steps: Step[]): LeanRun => ({ ...panelRun, steps });
  assert(
    loadRunOf(okRun([step({ kind: "skipped", reason: "challenge SKIPPED: x" })])) === undefined,
    "(g) a `skipped` record with its reason loads",
  );
  const trio = loadRunOf(
    okRun([
      step({
        kind: "skipped",
        reason: "challenge SKIPPED: x",
        limit: "minutes",
        value: 15,
        used: 16,
      }),
    ]),
  );
  assert(
    (trio ?? "").includes("is not a ceiling it crossed"),
    `(g) and the loader refuses the budget trio on a kind that crossed no ceiling (got ${JSON.stringify(trio)})`,
  );
  const budget = loadRunOf(
    okRun([step({ kind: "budget", limit: "minutes", value: 15, used: 16 })]),
  );
  assert(
    budget === undefined,
    `(g) while the budget kind keeps its trio (got ${JSON.stringify(budget)})`,
  );
}
