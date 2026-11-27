#!/usr/bin/env bun
/**
 * lean #2660 — every dispatch site a lean step pays for gets the deadline's bound.
 *
 * `build` has its own suite (`test-lean-deadline-step-bound.ts`). This one drives the
 * OTHER arming sites through their real step, with a fake clock and a deadline on the run
 * record, and asserts on the `childBoundMs`/`childBoundGraceMs` each site actually handed
 * its dispatch — not on what `lean-step-bound.ts` would return if asked directly. A site
 * whose wiring dropped the third `armBudget` argument would still pass a pure derivation
 * test; these fail.
 *
 * The sites and what each reads:
 *
 *   - `challenge` — the adversary's dispatch opts, off the fixture's seam;
 *   - `specify` — the adversary's dispatch opts, same way;
 *   - `specify`'s re-ask — the SECOND dispatch, which must carry the same pair
 *     (`specify-reask.ts` is handed the first child's bound rather than deriving its own);
 *   - `review` — the gate child's bound as the production seam delivered it, where the
 *     step's bound clamps the gate's own knob.
 *
 * Row math (the field's panel cell): a 4200 s deadline, the step armed 978 s before it,
 * an 8 min handoff allowance and the shipped 600 s grace, so the bound the deadline leaves
 * is 978000 − 480000 − 30000 = 468000 with a 30000 grace. The pre-change arm of the same
 * row is in the base-commit golden, and each case refuses that value by name.
 */
import { mock } from "bun:test";
import { stepDispatchArms } from "../src/lean-step-bound.ts";
import { defaultConfig } from "../src/lean/config.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import { withEnv } from "./lib/env-scope.ts";
import { put, redEdge, runChallenge } from "./lib/lean-challenge-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  cleanupRoots,
  makeRepo as reviewRepo,
  setup as reviewSetup,
} from "./lib/lean-review-fixtures.ts";
import {
  greenScript,
  makeRepo,
  redScript,
  runSpecify,
  submit,
  writeTest,
} from "./lib/lean-specify-fixture.ts";
import { PANEL_CELL_MS, PANEL_START_MS } from "./lib/lean-step-bound-arms.ts";
import { GOLDEN_ALLOWANCE_MS, GOLDEN_GRACE_MS } from "./lib/lean-step-deadline-bound-off-arm.ts";
import {
  AT,
  DEADLINE,
  EXPECT_BOUND,
  PRE,
  assertDeadlineArms,
  env,
} from "./lib/lean-step-bound-reason.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

const { assert, failures } = makeAssert();

assert(PRE === 2_700_000, `(pre) the golden holds the 45-minute row's own bound (${String(PRE)})`);

/** The arms assertion, with this suite's `assert` bound in — the row constants and the shared
 *  clause assertions live in `lib/lean-step-bound-reason.ts`, which the reason suite shares. */
const arms = (label: string, got: BudgetOpts | undefined, bound: number): void =>
  assertDeadlineArms(assert, label, got, bound);

/** The challenge child's edge test, named the way test-lean-challenge.ts names it. */
const EDGE = "tests/AC1-edge-second-failure.test.sh";

/** The submitted paths and the bodies the fixture writes for them. */
const TEST_ONE = "tests/AC1-retry.test.sh";
const TEST_TWO = "tests/AC2-retry.test.sh";
/** A body whose prose matches what every specify case uses, so only the ids differ. */
const BODY_ONE = specBody(["AC1"]);
const BODY_TWO = specBody(["AC1", "AC2"]);

/** A spec with the given test criteria — enough for `specify` to want a submitted row. */
function specBody(criteria: string[]): string {
  return [
    "```pi-spec v1",
    JSON.stringify(
      {
        problem: "The retry helper gives up too early.",
        size: "S",
        criteria: criteria.map((id) => ({ id, text: `the ${id} behaviour`, verify: "test" })),
        scope: { paths: ["src/retry.ts"], out: [] },
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

// ── challenge: the adversary's dispatch carries the deadline's pair ─────────
{
  // **The row is the panel's SHAPE, not its instants.** `challengeSkip` refuses the round
  // whenever the deadline leaves less than the review reserve plus one verify (43 min with
  // the panel's 8 min allowance), so the round is never offered at 978 s of spend — and a
  // child nobody is allowed to dispatch arms nothing. The case states a cell the guard
  // admits — the entry 16 min into a 70 min cell, with the pair's 26.7 min spent — and
  // asserts the same fact the panel row asserts: the child left with the deadline's bound,
  // computed from THIS row's instants, and not the 45-minute row's own number.
  const armed: BudgetOpts[] = [];
  const AT_CH = PANEL_START_MS + 960_000;
  // The deadline leaves 20 minutes outside the row, against the guard's 43-minute floor:
  // `challengeSkip` measures its reserve on the WALL CLOCK still in front of the run,
  // `leanStepBound` on the spend the step log recorded, and a 45-minute row needs both to
  // admit a child whose kill still lands inside deadline + allowance. 2520 s of spend is
  // exactly where `leanStepBound` first shortens a 45-minute row, so the row is the tightest
  // one that is also admissible — the skip's floor is why the panel's 978 s is not.
  const DEADLINE_CH = AT_CH + 2520_000 + 20 * 60_000;
  // The bound the deadline leaves: the whole round minus the allowance and the grace that
  // still fits (`stepBudgetGraceMs` — the shipped 600 s here, floored at 30 s).
  const BOUND_CH = DEADLINE_CH - AT_CH - GOLDEN_ALLOWANCE_MS - GOLDEN_GRACE_MS;
  let r!: Awaited<ReturnType<typeof runChallenge>>;
  await withEnv(env, async () => {
    r = await runChallenge({
      issue: 2680,
      challengeMinutes: 45,
      deadlineMs: DEADLINE_CH,
      challengeAt: AT_CH,
      // An adversary with nothing to submit is a `none` the step returns WITHOUT
      // dispatching — the row's arms can only be scored on a child that was really sent.
      child: (wt) => put(wt, EDGE, redEdge(EDGE)),
      toolUses: () => [submit("AC1", [EDGE])],
      // The share the skip guard measures runs from the cell's start, and the fixture's
      // default entries (epoch seconds 2–4) read as 47.6 BILLION seconds spent against a
      // real-epoch deadline — every panel-shaped row must state the cell it lives in.
      cellStartedAt: PANEL_START_MS,
      specifySeconds: 1312,
      buildSeconds: 287,
      armedOpts: armed,
    });
  });
  assert(
    r.threw === undefined,
    `(challenge) the step ran on the deadline row: ${r.threw?.message ?? "clean"}`,
  );
  assert(r.dispatched === 1, `(challenge) the adversary was dispatched (${String(r.dispatched)})`);
  arms("(challenge)", armed[0], BOUND_CH);
}

// ── specify: the adversary's dispatch carries the deadline's pair ───────────
{
  const armed: BudgetOpts[] = [];
  const repo = makeRepo({ "src/retry.ts": "export const retry = 1;\n" });
  const cfg = defaultConfig();
  cfg.budgets.specify = { turns: 0, tokens: 0, minutes: 45 };
  cfg.verify = { fast: "true", test: "sh {file}" };
  let r!: Awaited<ReturnType<typeof runSpecify>>;
  await withEnv(env, async () => {
    r = await runSpecify({
      issue: 2683,
      repoRoot: repo.repoRoot,
      baseSha: repo.baseSha,
      specBody: BODY_ONE,
      config: cfg,
      writes: (wt, n) => {
        if (n === 1) writeTest(wt, redScript());
      },
      toolUses: () => [submit("AC1", [TEST_ONE])],
      clock: { now: () => AT, deadlineMs: DEADLINE },
      stepStartedAt: AT,
      armedOpts: armed,
    });
  });
  assert(
    r.threw === undefined,
    `(specify) the step ran on the deadline row: ${r.threw?.message ?? "clean"}`,
  );
  assert(r.dispatched >= 1, `(specify) the adversary was dispatched (${String(r.dispatched)})`);
  arms("(specify)", armed[0], EXPECT_BOUND);
}

// ── specify's re-ask: the second child carries the SAME pair ────────────────
{
  // The child submits nothing for AC2, so the step asks it once more on the same session.
  // `specify-reask.ts` is handed the FIRST child's bound rather than deriving its own, so
  // a re-ask that armed itself from the row would be the second child dying on a 45-minute
  // timer the deadline had already shortened — the pair must agree.
  const armed: BudgetOpts[] = [];
  const repo = makeRepo({ "src/retry.ts": "export const retry = 1;\n" });
  const cfg = defaultConfig();
  cfg.budgets.specify = { turns: 0, tokens: 0, minutes: 45 };
  cfg.verify = { fast: "true", test: "sh {file}" };
  let r!: Awaited<ReturnType<typeof runSpecify>>;
  await withEnv(env, async () => {
    r = await runSpecify({
      issue: 2684,
      repoRoot: repo.repoRoot,
      baseSha: repo.baseSha,
      specBody: BODY_TWO,
      config: cfg,
      writes: (wt, n) => {
        if (n === 1) {
          writeTest(wt, redScript());
        }
      },
      toolUses: () => [submit("AC1", [TEST_ONE]), submit("AC2", [TEST_TWO])],
      dispatchResults: (n) =>
        n === 1 ? { toolUses: [submit("AC2", ["tests/AC2.test.sh"])] } : undefined,
      clock: { now: () => AT, deadlineMs: DEADLINE },
      stepStartedAt: AT,
      armedOpts: armed,
    });
  });
  assert(
    r.threw === undefined,
    `(re-ask) the step ran on the deadline row: ${r.threw?.message ?? "clean"}`,
  );
  assert(r.dispatched >= 2, `(re-ask) the child was re-asked (${String(r.dispatched)} dispatches)`);
  arms("(re-ask) first child", armed[0], EXPECT_BOUND);
  arms("(re-ask) re-asked child", armed[1], EXPECT_BOUND);
}

// ── review: the gate child's bound is the deadline's, through the real seam ─
{
  // The production `reviewDeps.adversarial` seam — `Math.min(budget's bound, the gate's
  // own knob)` — is the site #2660 touched. Driven directly, the way
  // `test-lean-review-deps-criteria-pair.ts` drives it: the STEP's wave clock stops 23
  // minutes before the deadline, so a full `runStep` with this row's clock never reaches
  // the seam at all, and an interception of `deps.adversarial` would score the fixture's
  // stub instead of the production clamp. The step's armed bound comes from the SAME
  // derivation the step arms with; the seam's delivered pair is what the mock spawn saw.
  //
  // **The grace is asserted where the pair is constructed, and the bound here.** The seam's
  // comment is production truth: the loop builds its OWN spawn options and receives only the
  // frozen bound and the whole-minutes stall window — a grace, like a `stall` object, is not
  // among the arms it forwards. Asserting a grace at this leaf would pin behaviour production
  // does not have; `test-lean-deadline-step-bound.ts` (b) pins the pair at the arm, and this
  // case pins that the deadline's NUMBER, and not the gate's knob, is what survives the clamp.
  const seen: { childBoundMs?: number; childBoundGraceMs?: number }[] = [];
  const reviewSpawned: { role: string; prompt: string }[] = [];
  // ONE mock, for the leaf the loop really calls: `spawnSpecialist`. The earlier
  // attempt mocked `review-deps.ts` itself, which made the case score a stand-in
  // for the very seam it claims to test — and mocking a module one already
  // imported statically is the same trap in the other direction. The loop's
  // bookkeeping modules are mocked the way `adversarial-reviewer-harness.ts`
  // mocks them, so no ledger, deck, or registry path is reached.
  // A child whose text has no parsable `VERDICT:` line is an infra failure the
  // classifier ends the round on, and an unclassified round never reaches the
  // spawn assertion below — so the stub answers the way a reviewer does.
  mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-deadline-site-review",
    spawnSpecialist: async (spec: Record<string, unknown>, opts: Record<string, unknown>) => {
      reviewSpawned.push({ role: spec.role as string, prompt: "" });
      seen.push({
        childBoundMs: opts.childBoundMs as number | undefined,
        childBoundGraceMs: opts.childBoundGraceMs as number | undefined,
      });
      return {
        role: spec.role as string,
        ok: true,
        text: "VERDICT: APPROVED",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never;
    },
  }));
  {
    const real = await import("../src/dispatch-deck.ts");
    mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
      ...real,
      startEntry: () => {},
      updateEntry: () => {},
      clearEntry: () => {},
      startBatchEntry: () => {},
      updateBatchProgress: () => {},
      clearBatchEntry: () => {},
    }));
    const reg = await import("../src/async-jobs-registry.ts");
    mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
      ...reg,
      childHandles: new Map(),
      registerChildHandle: () => {},
      setOrchestratorActiveChild: () => {},
      markOrchestrator: () => {},
    }));
    const ledger = await import("../src/adversarial-ledger.ts");
    mock.module(new URL("../src/adversarial-ledger.ts", import.meta.url).href, () => ({
      ...ledger,
      writeAdversarialLedgerEntry: () => undefined,
    }));
  }
  // The loop's ref-range diff must be readable: the seam hands `base`/`head` through
  // and computes the diff itself, and a range whose refs are not commits is the loop's
  // "nothing to review" exit — it returns BEFORE any dispatch, which would read as the
  // seam having dropped the bound. The refs are real, from a real review fixture repo.
  const reviewTree = reviewRepo();
  const reviewHead = await reviewSetup({
    repoRoot: reviewTree.repoRoot,
    baseSha: reviewTree.baseSha,
    branch: "lean/issue-7",
    feature: "export const f = 2;\n",
  });
  const { reviewDeps: reviewDepsMocked } = await import("../src/lean/review-deps.ts");
  const deps = reviewDepsMocked(false);
  const leversForReview = stepDispatchArms(
    {
      run: { deadlineMs: DEADLINE },
      steps: [{ state: "review", startedAt: AT, key: "7:review:0" }],
      stepKey: "7:review:0",
    } as never,
    45 * 60_000,
    "review",
  );

  await withEnv(env, async () => {
    await deps.adversarial({
      issue: 7,
      wave: "full",
      cwd: reviewTree.repoRoot,
      base: reviewTree.baseSha,
      head: reviewHead,
      branch: "lean/issue-7",
      issueBody: "body",
      headless: false,
      blockingFindings: "",
      diff: "diff --git a/src/f.ts b/src/f.ts\n+export const f = 2;\n",
      budget: {
        opts: {
          ...(leversForReview.bound === undefined
            ? {}
            : { childBoundMs: leversForReview.bound.boundMs }),
          ...(leversForReview.bound?.clamped !== true
            ? {}
            : { childBoundGraceMs: leversForReview.bound.graceMs }),
        },
        fired: () => undefined,
      },
    } as never);
  });
  const reviewer = seen.find((_, i) => reviewSpawned[i]?.role === "adversarial-developer");
  assert(reviewer !== undefined, `(review) the gate child was dispatched (${String(seen.length)})`);
  assert(
    reviewer?.childBoundMs === EXPECT_BOUND,
    `(review) gate child: the child was bounded by the deadline (${String(EXPECT_BOUND)}), got ${String(reviewer?.childBoundMs)}`,
  );
  assert(
    (reviewer?.childBoundMs ?? 0) !== PRE,
    `(review) gate child: and NOT the row's own bound (${String(PRE)}) — what a site that never read the deadline hands out`,
  );
}

process.exit(failures() === 0 ? 0 : 1);
