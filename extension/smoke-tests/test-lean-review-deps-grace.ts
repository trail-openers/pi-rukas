#!/usr/bin/env bun
/**
 * lean #2660 — the review step's children get the deadline's GRACE, not just its bound.
 *
 * `armBudget` forwards a deadline-derived arm as a PAIR (`lean/step-budget.ts`):
 * `childBoundMs` clamped to what the deadline leaves, and `childBoundGraceMs` — the
 * shortened grace that keeps the kill inside deadline + handoff allowance. `build`,
 * `specify` and `challenge` forward the pair because their dispatch spreads the armed
 * `BudgetOpts` straight into `spawnSpecialist`.
 *
 * The review step's children do NOT reach the spawn that way. Both build their own
 * spawn options several frames deeper:
 *
 *   - the adversarial gate: `reviewDeps().adversarial` → `runAdversarialLoop` →
 *     `makeRunPhase`, whose reviewer branch constructs `childBoundMs` itself;
 *   - the six lenses: `reviewDeps().lens` → `runLensReview` → `runLensChild`, which
 *     constructs `childBoundMs: runOpts.childBoundMs ?? lensChildBoundMs()`.
 *
 * Because of that, the destructures in `review-deps.ts` that take `childBoundMs` and
 * `stall` OUT of the armed arms (so a spread cannot re-supply them past the operator's
 * knobs) also silently drop `childBoundGraceMs` — and unlike the bound and the stall
 * window, the grace is never forwarded beside them. The leaf then falls to the default
 * `childBoundGraceMs()`: 10 minutes. On the panel's row the deadline-derived bound is
 * 468 s, so the reviewer's kill lands 498 s past the deadline on top of the 8-minute
 * handoff allowance — 978 s past the line, which is the exact overrun shape #2660 was
 * filed for, in the review step.
 *
 * Asserted on what the CHILD was actually dispatched with, through the real
 * seam → real loop → real `makeRunPhase` chain (reviewer) and the real seam → real
 * `runLensReview` → real `runLensChild` chain (lenses), which is the convention
 * `test-lean-review-deps-bound.ts` (1)-(4), `test-lean-review-deps-criteria-pair.ts` and
 * `test-lens-turn-ceiling-lean.ts` established. An assertion on what was handed
 * `reviewDeps` would have passed with the grace dropped on the floor, which is how the
 * gap shipped.
 *
 * Offline: `spawnSpecialist` is a recorder — no model, no child, no token.
 */
import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stepDispatchArms } from "../src/lean-step-bound.ts";
import { adversarialChildBoundMs } from "../src/review-bounds.ts";
import { armBudget } from "../src/lean/step-budget.ts";
import { childBoundGraceMs } from "../src/spawn-child-bound.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { installLensSkills } from "./lib/lens-stub-spawn.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  GOLDEN_ALLOWANCE_MS,
  GOLDEN_DEADLINE_MS,
  GOLDEN_GRACE_MS,
  GOLDEN_START_MS,
} from "./lib/lean-step-deadline-bound-off-arm.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

const { assert, failures } = makeAssert();

/** The spawn's own opts, narrowed to the fields this suite reads. */
interface LeafCall {
  role: string;
  childBoundMs?: number;
  childBoundGraceMs?: number;
}

const leaf: LeafCall[] = [];

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-review-grace",
  spawnSpecialist: async (spec: { role: string }, opts: Record<string, unknown>) => {
    leaf.push({
      role: spec.role,
      childBoundMs: opts.childBoundMs as number | undefined,
      childBoundGraceMs: opts.childBoundGraceMs as number | undefined,
    });
    return {
      role: spec.role,
      ok: true,
      text: "VERDICT: APPROVED",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    } as never;
  },
}));
for (const mod of ["dispatch-deck.ts", "async-jobs-registry.ts", "adversarial-ledger.ts"]) {
  const real = await import(`../src/${mod}`);
  mock.module(new URL(`../src/${mod}`, import.meta.url).href, () => ({
    ...real,
    ...(mod === "async-jobs-registry.ts"
      ? {
          childHandles: new Map(),
          registerChildHandle: () => {},
          setOrchestratorActiveChild: () => {},
          markOrchestrator: () => {},
        }
      : {}),
    ...(mod === "adversarial-ledger.ts" ? { writeAdversarialLedgerEntry: () => undefined } : {}),
    ...(mod === "dispatch-deck.ts"
      ? {
          startEntry: () => {},
          updateEntry: () => {},
          clearEntry: () => {},
          startBatchEntry: () => {},
          updateBatchProgress: () => {},
          clearBatchEntry: () => {},
        }
      : {}),
  }));
}

// Imported AFTER the mocks, so the whole chain binds to the recorder.
const { reviewDeps } = await import("../src/lean/review-deps.ts");

const MINUTE = 60_000;
/** The field's row, straight out of the golden's instants: the step armed 978 s before a
 *  4200 s deadline, an 8 min handoff allowance and the shipped 600 s child grace. */
const EXPECT_BOUND = GOLDEN_DEADLINE_MS - GOLDEN_START_MS - GOLDEN_ALLOWANCE_MS - 30_000;
const EXPECT_GRACE = 30_000;
/** What the leaf falls back to when no grace travelled with the bound. */
const DEFAULT_GRACE = GOLDEN_GRACE_MS;

const env = {
  PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(GOLDEN_ALLOWANCE_MS),
  PI_ENSEMBLE_CHILD_BOUND_GRACE_MS: String(DEFAULT_GRACE),
  PI_ENSEMBLE_DISPATCH_CAPS: "1",
  PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1",
};

/** The step's own arms, armed for real — a fixture's `opts` would pin the fixture. */
function reviewArms() {
  const entries = [{ key: "2660:review:0", state: "review", startedAt: GOLDEN_START_MS }];
  const ctx = {
    repoRoot: "/nowhere",
    issue: 2660,
    run: { schema: 1, issue: 2660, version: "t", models: {}, deadlineMs: GOLDEN_DEADLINE_MS },
    steps: entries,
    stepKey: "2660:review:0",
    now: () => GOLDEN_START_MS,
  } as never;
  const levers = stepDispatchArms(ctx, 45 * MINUTE, "review");
  return armBudget({ minutes: 45, turns: 0, tokens: 0 }, levers.stall, levers.bound);
}

/** A two-commit repo: both gates compute `git diff <base>...<head>` themselves, so the
 *  refs must exist or the seam exits before it dispatches anything. */
async function mkRepo(name: string): Promise<{ dir: string; base: string; head: string }> {
  gitTestEnv();
  const dir = path.join(root, name, "repo");
  mkdirSync(dir, { recursive: true });
  const G = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(r.stderr)}`);
    return (r.stdout ?? "").trim();
  };
  G("init", "-q", "-b", "main");
  G("config", "user.email", "t@t");
  G("config", "user.name", "T");
  writeFileSync(path.join(dir, "meter.ts"), "export const draw = () => 1;\n");
  G("add", "-A");
  G("commit", "-q", "-m", "base");
  G("checkout", "-qb", "lean/issue-2660");
  writeFileSync(path.join(dir, "quota.ts"), "export const quota = (n: number) => n > 0;\n");
  G("add", "-A");
  G("commit", "-q", "-m", "feat: refuse the draw once the quota is spent");
  return { dir, base: G("rev-parse", "HEAD~1"), head: G("rev-parse", "HEAD") };
}

const root = mkdtempSync(path.join(os.tmpdir(), "lean-review-grace-"));
installLensSkills(path.join(root, "skills"));
process.env.PI_ENSEMBLE_SKILLS_DIR = path.join(root, "skills");

const budget = reviewArms();
// Non-vacuity: the step's own arms really do carry the pair, so a leaf that received no
// grace is the seam's omission and not an arm that never had one.
assert(
  budget.opts.childBoundMs === EXPECT_BOUND && budget.opts.childBoundGraceMs === EXPECT_GRACE,
  `(pre) the review step's own arms carry the deadline's pair — bound ${String(EXPECT_BOUND)} + grace ${String(EXPECT_GRACE)} (got bound ${String(budget.opts.childBoundMs)}, grace ${String(budget.opts.childBoundGraceMs)})`,
);

// ── (1) THE ADVERSARIAL GATE's reviewer child ───────────────────────────────
{
  const repo = await mkRepo("gate");
  leaf.length = 0;
  await withEnv(env, async () => {
    await reviewDeps(false).adversarial({
      issue: 2660,
      wave: "full",
      cwd: repo.dir,
      base: repo.base,
      head: repo.head,
      branch: "lean/issue-2660",
      issueBody: "body",
      headless: false,
      blockingFindings: "",
      budget,
    } as never);
  });
  const reviewer = leaf.find((c) => c.role === "adversarial-developer");
  assert(reviewer !== undefined, `(1) precondition: the gate dispatched its reviewer (${String(leaf.length)} spawns)`);
  assert(
    reviewer?.childBoundMs === EXPECT_BOUND,
    `(1) the reviewer's bound is the deadline's (${String(EXPECT_BOUND)}), got ${String(reviewer?.childBoundMs)}`,
  );
  assert(
    reviewer?.childBoundGraceMs === EXPECT_GRACE,
    `(1) AND ITS KILL CARRIES THE DEADLINE'S GRACE (${String(EXPECT_GRACE)}) — with nothing forwarded the leaf arms the default ${String(DEFAULT_GRACE)} and the kill lands ${String((reviewer?.childBoundMs ?? 0) + DEFAULT_GRACE - EXPECT_GRACE)} ms past where the deadline put it (captured ${String(reviewer?.childBoundGraceMs)})`,
  );
  assert(
    (reviewer?.childBoundMs ?? 0) + (reviewer?.childBoundGraceMs ?? DEFAULT_GRACE) <=
      GOLDEN_DEADLINE_MS - GOLDEN_START_MS + GOLDEN_ALLOWANCE_MS,
    `(1) and the kill lands inside deadline + the handoff allowance, got ${String((reviewer?.childBoundMs ?? 0) + (reviewer?.childBoundGraceMs ?? DEFAULT_GRACE))} against the ${String(GOLDEN_DEADLINE_MS - GOLDEN_START_MS + GOLDEN_ALLOWANCE_MS)} the step may spend`,
  );
}

// ── (2) EVERY LENS CHILD ─────────────────────────────────────────────────────
{
  const repo = await mkRepo("lens");
  leaf.length = 0;
  await withEnv(env, async () => {
    await reviewDeps(false).lens({
      base: repo.base,
      head: repo.head,
      branch: "lean/issue-2660",
      cwd: repo.dir,
      wave: "full",
      pr: undefined,
      context: "ctx",
      evidence: undefined,
      extraFindings: [],
      headless: false,
      budget,
    } as never);
  });
  const lenses = leaf.filter((c) => c.role === "code-review-specialist");
  assert(lenses.length > 0, `(2) precondition: the lens arm reached spawnSpecialist (${String(lenses.length)} lens spawns)`);
  assert(
    lenses.every((c) => c.childBoundMs === EXPECT_BOUND),
    `(2) EVERY lens child was bounded by the deadline (captured ${JSON.stringify(lenses.map((c) => c.childBoundMs))})`,
  );
  assert(
    lenses.every((c) => c.childBoundGraceMs === EXPECT_GRACE),
    `(2) AND EVERY LENS CARRIED THE DEADLINE'S GRACE — a lens left on the default ${String(DEFAULT_GRACE)} is a lens whose kill lands ${String(EXPECT_BOUND + DEFAULT_GRACE - EXPECT_GRACE)} ms past where the deadline put it (captured ${JSON.stringify(lenses.map((c) => c.childBoundGraceMs))})`,
  );
  assert(
    lenses.every(
      (c) =>
        (c.childBoundMs ?? 0) + (c.childBoundGraceMs ?? DEFAULT_GRACE) <=
        GOLDEN_DEADLINE_MS - GOLDEN_START_MS + GOLDEN_ALLOWANCE_MS,
    ),
    `(2) and no lens's kill lands later than deadline + the handoff allowance (captured ${JSON.stringify(lenses.map((c) => (c.childBoundMs ?? 0) + (c.childBoundGraceMs ?? DEFAULT_GRACE)))})`,
  );
}

// ── (3) OFF ARM AND NO DEADLINE: nothing is forwarded, and nothing is claimed ─
{
  const entries = [{ key: "2660:review:0", state: "review", startedAt: GOLDEN_START_MS }];
  const ctxFor = (deadlineMs?: number) =>
    ({
      repoRoot: "/nowhere",
      issue: 2660,
      run: {
        schema: 1,
        issue: 2660,
        version: "t",
        models: {},
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
      },
      steps: entries,
      stepKey: "2660:review:0",
      now: () => GOLDEN_START_MS,
    }) as never;
  const rows: { name: string; env: Record<string, string>; deadline?: number }[] = [
    { name: "no deadline", env: { ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1" } },
    {
      name: "switch at 0",
      env: { ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "0" },
      deadline: GOLDEN_DEADLINE_MS,
    },
  ];
  for (const row of rows) {
    // BOTH the arming and the dispatch inside each row's own `withEnv`: the switch and the
    // allowance are read at CALL time, so arming outside the block would arm the row against
    // the previous row's env — which is what made the `=0` row report the ON arm's numbers.
    const repo = await mkRepo(`inert-${row.name.replace(/\W+/g, "-")}`);
    leaf.length = 0;
    let inert!: ReturnType<typeof armBudget>;
    await withEnv(row.env, async () => {
      const levers = stepDispatchArms(ctxFor(row.deadline), 45 * MINUTE, "review");
      inert = armBudget({ minutes: 45, turns: 0, tokens: 0 }, levers.stall, levers.bound);
      await reviewDeps(false).adversarial({
        issue: 2660,
        wave: "full",
        cwd: repo.dir,
        base: repo.base,
        head: repo.head,
        branch: "lean/issue-2660",
        issueBody: "body",
        headless: false,
        blockingFindings: "",
        budget: inert,
      } as never);
    });
    assert(
      inert.opts.childBoundGraceMs === undefined,
      `(3) ${row.name}: the step arms NO grace, so the leaf keeps the default — byte for byte the pre-change arm (captured ${String(inert.opts.childBoundGraceMs)})`,
    );
    const reviewer = leaf.find((c) => c.role === "adversarial-developer");
    assert(
      reviewer?.childBoundGraceMs === undefined,
      `(3) ${row.name}: and the reviewer's spawn carries no grace either — a forwarded grace on an inert arm would be a deadline-derived kill the operator switched off (captured ${String(reviewer?.childBoundGraceMs)})`,
    );
    assert(
      reviewer?.childBoundMs === Math.min(45 * MINUTE, adversarialChildBoundMs()),
      `(3) ${row.name}: and its bound is the row clamped only by the gate's OWN knob, exactly as before this change — no deadline term (captured ${String(reviewer?.childBoundMs)}, expected ${String(Math.min(45 * MINUTE, adversarialChildBoundMs()))})`,
    );
    assert(
      DEFAULT_GRACE === childBoundGraceMs(),
      `(3) ${row.name}: the leaf's fallback is the configured grace the spawn reads, ${String(childBoundGraceMs())}`,
    );
  }
}

for (const dir of [root]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best-effort */
  }
}

// `failures` is a READER (`makeAssert()` returns `failures: () => number`), so the verdict is
// `failures()`. `failures.length` is the function's arity — always 0 — which made this suite exit
// 0 while printing an `✗`, the exact inert gate the #2660 review refused.
process.exit(failures() === 0 ? 0 : 1);
