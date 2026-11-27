#!/usr/bin/env bun
/**
 * lean #2660 — the production dispatch seams forward the deadline's GRACE, not just its bound.
 *
 * `armBudget` arms a deadline-derived bound as a PAIR (`lean/step-budget.ts`):
 * `childBoundMs` clamped to what the deadline leaves, and `childBoundGraceMs` — the
 * shortened grace that keeps the kill inside deadline + handoff allowance. The pair is
 * only worth arming if it REACHES `spawnSpecialist`, and for the model-dispatching steps
 * that means the object literal each `<step>Deps()` builds key by key (`lean/build.ts`,
 * `lean/challenge.ts`, `lean/command.ts`, `lean/spec-derive.ts`, `lean/review-deps.ts`).
 * A seam that forwards `childBoundMs` and not `childBoundGraceMs` leaves the child on the
 * configured `childBoundGraceMs()` — the shipped 600 s — so the deadline-derived bound of
 * 468 s is killed 498 s past the deadline on top of the 8-minute handoff allowance: the
 * exact overrun shape this issue was filed for.
 *
 * THE SEAM THIS ASSERTS ON IS THE LEAF, NOT THE FIXTURE. The step-side suites
 * (`test-lean-step-deadline-bound-sites.ts`, `test-lean-deadline-step-bound.ts`) capture
 * the opts at their fixture's fake `dispatch`, which sits UPSTREAM of these literals —
 * a key dropped inside the literal was invisible to them, which is how the gap shipped.
 * Here `mock.module` replaces `src/spawn.ts` itself, so the recorder sees exactly the
 * object `spawnSpecialist` is handed, through the real `<step>Deps()` the engine wires
 * (`command.ts`'s `handlers.build = (ctx) => buildOutcome(ctx, buildDeps(headless))`).
 * The same leaf-recorder convention `test-lean-review-deps-grace.ts` established.
 *
 * Offline: no model, no child, no token. The leaf returns canned results.
 */
import { mock } from "bun:test";
import type { StepBound } from "../src/lean-step-bound.ts";
import { stepDispatchArms } from "../src/lean-step-bound.ts";
import { defaultConfig } from "../src/lean/config.ts";
import type { Budget } from "../src/lean/config.ts";
import { armBudget } from "../src/lean/step-budget.ts";
import { childBoundGraceMs } from "../src/spawn-child-bound.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  GOLDEN_ALLOWANCE_MS,
  GOLDEN_DEADLINE_MS,
  GOLDEN_GRACE_MS,
  GOLDEN_START_MS,
} from "./lib/lean-step-deadline-bound-off-arm.ts";

const { assert, failures } = makeAssert();

/** The spawn's own opts, narrowed to the fields this suite reads. */
interface LeafCall {
  mod: string;
  role: string;
  childBoundMs?: number;
  childBoundGraceMs?: number;
}

const leaf: LeafCall[] = [];
/** Which step's seam made the call, tagged by the case that drove it. */
let leafMod = "?";
/** What the leaf answers, held in a BOX: `mock.module`'s factory is hoisted above these
 *  bindings, and a `let` reassigned by a case would read back as `undefined` inside a
 *  closure over the binding (TDZ). A property read off a const object is immune. */
const answer: { current: () => DispatchResult } = { current: () => OK };

const OK: DispatchResult = {
  role: "developer",
  ok: true,
  text: "implemented",
  toolUses: [],
  ms: 1,
  exitCode: 0,
};

function record(mod: string) {
  return async (spec: { role: string }, opts: Record<string, unknown>): Promise<DispatchResult> => {
    leaf.push({
      mod,
      role: spec.role,
      childBoundMs: opts.childBoundMs as number | undefined,
      childBoundGraceMs: opts.childBoundGraceMs as number | undefined,
    });
    return { ...answer.current(), role: spec.role };
  };
}

// Mocked BEFORE any production import, so every seam binds to the recorder.
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-2660-production-seam",
  spawnSpecialist: (spec: { role: string }, opts: Record<string, unknown>) =>
    record(leafMod)(spec, opts),
}));

const { buildDeps } = await import("../src/lean/build.ts");
const { challengeDeps } = await import("../src/lean/challenge.ts");
const { specifyDeps } = await import("../src/lean/command.ts");
const { deriveDeps } = await import("../src/lean/spec-derive.ts");
const { deriveSpec } = await import("../src/lean/spec-derive.ts");
const { reviewDeps } = await import("../src/lean/review-deps.ts");
const { continuationBoundMs } = await import("../src/fixer-truncation.ts");
const { FIX_BOUND_MS } = await import("../src/lean/review.ts");

/** The field's row, straight out of the golden's instants: the step armed 978 s before a
 *  4200 s deadline with an 8 min handoff allowance and the shipped 600 s child grace. The
 *  deadline therefore leaves a bound of 978000 − 480000 − 30000 = 468000 with a 30000 grace. */
const EXPECT_BOUND = GOLDEN_DEADLINE_MS - GOLDEN_START_MS - GOLDEN_ALLOWANCE_MS - 30_000;
const EXPECT_GRACE = 30_000;
/** What the leaf falls back to when no grace travelled beside the bound. */
const DEFAULT_GRACE = GOLDEN_GRACE_MS;
const MINUTE = 60_000;
const ROW_MINUTES = 45;

const env = {
  PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(GOLDEN_ALLOWANCE_MS),
  PI_ENSEMBLE_CHILD_BOUND_GRACE_MS: String(GOLDEN_GRACE_MS),
  PI_ENSEMBLE_DISPATCH_CAPS: "1",
  PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1",
};

/** A run record whose step entry starts where the golden's did, under the golden's deadline
 *  — or with NO deadline at all, which is a different record and not one with a null field. */
function ctxFor(state: string, noDeadline = false): never {
  return {
    repoRoot: "/nowhere",
    issue: 2660,
    run: {
      schema: 1,
      issue: 2660,
      version: "t",
      models: {},
      ...(noDeadline ? {} : { deadlineMs: GOLDEN_DEADLINE_MS }),
    },
    steps: [{ key: `2660:${state}:0`, state, startedAt: GOLDEN_START_MS }],
    stepKey: `2660:${state}:0`,
    now: () => GOLDEN_START_MS,
  } as never;
}

/** The step's own arms, armed for real through the real lever pair — a fixture's `opts`
 *  would pin the fixture, and a hand-built object would pin the case. */
function armsFor(state: string, minutes = ROW_MINUTES) {
  const levers = stepDispatchArms(ctxFor(state), minutes * MINUTE, state);
  return armBudget({ minutes, turns: 0, tokens: 0 }, levers.stall, levers.bound);
}

/** The two assertions every seam shares, stated on what the LEAF received. */
function assertLeafPair(label: string, call: LeafCall | undefined): void {
  assert(call !== undefined, `${label}: the seam reached spawnSpecialist`);
  assert(
    call?.childBoundMs === EXPECT_BOUND,
    `${label}: the child was bounded by the deadline (${String(EXPECT_BOUND)}), got ${String(call?.childBoundMs)}`,
  );
  assert(
    call?.childBoundGraceMs === EXPECT_GRACE,
    `${label}: AND ITS KILL CARRIED THE DEADLINE'S GRACE (${String(EXPECT_GRACE)}) — a seam that forwards the bound alone leaves the leaf on the configured ${String(DEFAULT_GRACE)}, so the kill lands ${String((call?.childBoundMs ?? 0) + DEFAULT_GRACE - EXPECT_GRACE)} ms past where the deadline put it (captured ${String(call?.childBoundGraceMs)})`,
  );
  assert(
    (call?.childBoundMs ?? 0) + (call?.childBoundGraceMs ?? DEFAULT_GRACE) <=
      GOLDEN_DEADLINE_MS - GOLDEN_START_MS + GOLDEN_ALLOWANCE_MS,
    `${label}: and the kill lands inside deadline + the handoff allowance (${String((call?.childBoundMs ?? 0) + (call?.childBoundGraceMs ?? DEFAULT_GRACE))} vs ${String(GOLDEN_DEADLINE_MS - GOLDEN_START_MS + GOLDEN_ALLOWANCE_MS)})`,
  );
}

const config = { ...defaultConfig(), budgets: { ...defaultConfig().budgets } };
for (const k of Object.keys(config.budgets))
  config.budgets[k] = { minutes: ROW_MINUTES, turns: 0, tokens: 0 };
const ROW: Budget = { minutes: ROW_MINUTES, turns: 0, tokens: 0 };

/** A result the child-bound kill produced — the shape that makes a step STOP rather than
 *  keep working, so a step whose seam is under test dispatches exactly one child. */
function killedChild(): DispatchResult {
  return { ...OK, ok: false, exitCode: null as never, killCause: "child-bound", ms: EXPECT_BOUND };
}

// ── (0) non-vacuity: the step's own arms really do carry the pair ───────────
for (const state of ["build", "challenge", "specify", "review"]) {
  const a = armsFor(state);
  assert(
    a.opts.childBoundMs === EXPECT_BOUND && a.opts.childBoundGraceMs === EXPECT_GRACE,
    `(0) ${state}'s own arms carry the deadline's pair (${String(EXPECT_BOUND)} + ${String(EXPECT_GRACE)}); got ${String(a.opts.childBoundMs)} + ${String(a.opts.childBoundGraceMs)}`,
  );
}

// ── (1) build: `buildDeps().dispatch` → spawnSpecialist ─────────────────────
{
  leaf.length = 0;
  leafMod = "build";
  answer.current = killedChild;
  const deps = buildDeps(false);
  await withEnv(env, async () => {
    await deps.dispatch(
      { role: "developer", prompt: "p", cwd: "/nowhere" },
      { writeFence: undefined, extraArgs: [], ...armsFor("build").opts },
    );
  });
  assertLeafPair(
    "(1) build's production seam",
    leaf.find((c) => c.role === "developer"),
  );
}

// ── (2) challenge: `challengeDeps().dispatch` → spawnSpecialist ─────────────
{
  leaf.length = 0;
  leafMod = "challenge";
  answer.current = killedChild;
  const deps = challengeDeps(false);
  await withEnv(env, async () => {
    await deps.dispatch(
      { role: "adversarial-developer", prompt: "p", cwd: "/nowhere" },
      { writeFence: undefined, extraArgs: [], ...armsFor("challenge").opts },
    );
  });
  assertLeafPair(
    "(2) challenge's production seam",
    leaf.find((c) => c.role === "adversarial-developer"),
  );
}

// ── (3) specify and its re-ask: `specifyDeps().dispatch` → spawnSpecialist ──
{
  leaf.length = 0;
  leafMod = "specify";
  answer.current = () => OK;
  const deps = specifyDeps(false);
  await withEnv(env, async () => {
    // The first child and the re-ask take the SAME shape of opts: the re-ask adds only
    // `runId` (`specify-reask.ts`'s `adversaryDispatchOpts`), which is why one seam covers
    // both dispatches of the step.
    await deps.dispatch(
      { role: "developer", prompt: "p", cwd: "/nowhere" },
      { writeFence: undefined, extraArgs: [], ...armsFor("specify").opts },
    );
    await deps.dispatch(
      { role: "developer", prompt: "re-ask", cwd: "/nowhere" },
      { runId: "run-2660-production-seam", extraArgs: [], ...armsFor("specify").opts },
    );
  });
  const calls = leaf.filter((c) => c.role === "developer");
  assert(
    calls.length === 2,
    `(3) specify dispatched a first child and a re-ask (${String(calls.length)})`,
  );
  assertLeafPair("(3) specify's first child", calls[0]);
  assertLeafPair("(3) specify's re-ask", calls[1]);
}

// ── (4) spec-derive: `deriveDeps().dispatch` → spawnSpecialist ──────────────
// The step that has its own seam and its own dispatch literal (`spec-derive.ts`), and the
// one whose arming is still unbounded — see the report's advisory list. Asserted inertly
// here so the seam's SHAPE is pinned: if its arm ever derives a bound, the grace must ride.
{
  leaf.length = 0;
  leafMod = "derive";
  answer.current = () => ({
    ...OK,
    text: [
      "```pi-spec v1",
      JSON.stringify({
        problem: "p",
        size: "S",
        criteria: [{ id: "AC1", text: "t", verify: "test" }],
        scope: { paths: ["src/a.ts"], out: [] },
      }),
      "```",
    ].join("\n"),
  });
  const armed = armsFor("derive");
  await withEnv(env, async () => {
    await deriveSpec({ title: "t", body: "b" }, deriveDeps(false).dispatch, {
      budget: ROW,
      arms: () => armed,
    });
  });
  const call = leaf[0];
  assert(
    leaf.length === 1,
    `(4) spec-derive dispatched its child through the real seam (${String(leaf.length)})`,
  );
  assert(
    call?.childBoundMs === armed.opts.childBoundMs,
    `(4) spec-derive's seam forwarded the bound it was armed with (${String(call?.childBoundMs)} vs ${String(armed.opts.childBoundMs)})`,
  );
  assert(
    call?.childBoundGraceMs === armed.opts.childBoundGraceMs,
    `(4) and it forwarded the grace beside it (leaf ${String(call?.childBoundGraceMs)} vs armed ${String(armed.opts.childBoundGraceMs)})`,
  );
}

// ── (5) the review fixer: `reviewDeps().dispatch` → spawnSpecialist ─────────
// The fixer's bound is the SMALLER of the step's deadline-derived bound and its own
// `FIX_BOUND_MS` (`lean/review-fix-child.ts`), and that clamp is `runFixer`'s decision, not
// the seam's — it is pinned there, so this case drives the seam with the pair as the step
// armed it and asserts only what the seam owes: the grace travels beside the bound.
{
  leaf.length = 0;
  leafMod = "fixer";
  answer.current = () => OK;
  const deps = reviewDeps(false);
  const budget = armsFor("review");
  await withEnv(env, async () => {
    await deps.dispatch({ role: "developer", prompt: "p", cwd: "/nowhere" }, { ...budget.opts });
  });
  assertLeafPair(
    "(5) the review fixer's production seam",
    leaf.find((c) => c.mod === "fixer"),
  );
}

// ── (6) the truncated fixer's continuation: `continuationBoundMs` → the leaf's bound ─
// The continuation reaches the child through `developer-session-continuation.ts`, not
// through `spawnSpecialist`, so its arms are what this leaf cannot see. Asserted where it
// is decided: the bound the step hands that seam must be the deadline's, not `FIX_BOUND_MS`.
{
  const budget = armsFor("review");
  const bound = continuationBoundMs(budget, FIX_BOUND_MS);
  assert(
    bound === EXPECT_BOUND,
    `(6) the continuation's bound is the deadline's (${String(EXPECT_BOUND)}), got ${String(bound)} — FIX_BOUND_MS is ${String(FIX_BOUND_MS)}`,
  );
}

// ── (7) inert arms forward NOTHING: the off arm stays the pre-change arm ─────
{
  const rows: { name: string; e: Record<string, string>; state: string }[] = [
    {
      name: "switch at 0",
      e: { ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "0" },
      state: "build",
    },
    {
      name: "no deadline",
      e: { ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1" },
      state: "build",
    },
  ];
  for (const row of rows) {
    leaf.length = 0;
    leafMod = row.state;
    answer.current = killedChild;
    // The `deadlineMs` key is OMITTED rather than deleted: an own property holding
    // `undefined` is not the same record as no key, and the lever's inertness table keys on
    // the key's presence (`arms.deadlineMs === undefined`).
    const ctx = ctxFor(row.state, row.name === "no deadline");
    const deps = buildDeps(false);
    await withEnv(row.e, async () => {
      const levers = stepDispatchArms(ctx, ROW_MINUTES * MINUTE, row.state);
      const a = armBudget(
        { minutes: ROW_MINUTES, turns: 0, tokens: 0 },
        levers.stall,
        levers.bound,
      );
      await deps.dispatch(
        { role: "developer", prompt: "p", cwd: "/nowhere" },
        { writeFence: undefined, extraArgs: [], ...a.opts },
      );
    });
    const call = leaf[0];
    assert(
      call?.childBoundGraceMs === undefined,
      `(7) ${row.name}: the leaf carries NO grace — byte for byte the pre-change arm (captured ${String(call?.childBoundGraceMs)})`,
    );
    assert(
      call?.childBoundMs === ROW_MINUTES * MINUTE,
      `(7) ${row.name}: and its bound is the row's own ${String(ROW_MINUTES * MINUTE)}, no deadline term (captured ${String(call?.childBoundMs)})`,
    );
    assert(
      DEFAULT_GRACE === childBoundGraceMs(),
      `(7) ${row.name}: the leaf's fallback is the configured grace the spawn reads (${String(childBoundGraceMs())})`,
    );
  }
}

process.exit(failures() === 0 ? 0 : 1);
