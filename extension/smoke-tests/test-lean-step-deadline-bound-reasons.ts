#!/usr/bin/env bun
/**
 * lean #2660 — the site whose step the DEADLINE ended says so in its verdict reason.
 *
 * A lean step that stops because its child's bound ran out prints a budget verdict whose reason
 * is composed by ONE function, `verdictReasonClause` (`lean-step-bound.ts`), which rides the
 * deadline's own sentence on top of the ceiling sentence the verdict always printed. Its sibling
 * arms (the `childBoundMs`/`childBoundGraceMs` each site hands its dispatch) are pinned by
 * `test-lean-step-deadline-bound-sites.ts`; `build`'s clause is pinned by
 * `test-lean-deadline-step-bound.ts` (c). This suite is the AC3 half for the three remaining
 * callers — `challenge`, `specify`'s first child, and `specify`'s re-ask:
 *
 *   - `challenge.ts:341` — the adversary's round ended by the bound;
 *   - `specify-attempt.ts:245` — the first child ended by the bound;
 *   - `specify-attempt.ts:297` — the RE-ASK ended by the bound.
 *
 * Why each is a case of its own and not one case three times: the clause reaches a verdict only
 * through the caller's own `stepBoundOf` re-read, so deleting the clause's body has to fail at
 * every caller. Before this suite, deleting it left the whole repo green except build.
 *
 * Each case therefore drives the caller's real entry with a child stamped by `applyChildBound`'s
 * kill cause (`KILLED`), and then reads the DEADLINE out of the reason the step produced, beside
 * the arms assertion that the same row armed the dispatch with the deadline's pair.
 */
import { defaultConfig } from "../src/lean/config.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import { withEnv } from "./lib/env-scope.ts";
import { put, redEdge, runChallenge } from "./lib/lean-challenge-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";
import { writeTest } from "./lib/lean-specify-shared.ts";
import { PANEL_START_MS } from "./lib/lean-step-bound-arms.ts";
import { GOLDEN_ALLOWANCE_MS, GOLDEN_GRACE_MS } from "./lib/lean-step-deadline-bound-off-arm.ts";
import {
  AT,
  DEADLINE,
  EXPECT_BOUND,
  KILLED,
  assertDeadlineArms,
  assertDeadlineReason,
  env,
} from "./lib/lean-step-bound-reason.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

const { assert, failures } = makeAssert();

/** The arms assertion, with this suite's `assert` bound in. */
const arms = (label: string, got: BudgetOpts | undefined, bound: number): void =>
  assertDeadlineArms(assert, label, got, bound);

/** The clause assertion, with this suite's `assert` bound in. */
const reason = (label: string, got: string | undefined, state: string): void =>
  assertDeadlineReason(assert, label, got, state);

/** The challenge child's edge test, named the way test-lean-challenge.ts names it. */
const EDGE = "tests/AC1-edge-second-failure.test.sh";
const TEST_ONE = "tests/AC1-retry.test.sh";

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
const BODY_ONE = specBody(["AC1"]);

// ── challenge killed by the bound: the round's reason names the deadline ─────
{
  // The row is the panel's SHAPE rather than its instants: `challengeSkip` refuses the round
  // whenever the deadline leaves less than the review reserve plus one verify, so the round is
  // never offered at the panel's 978 s of spend. The case states a cell the guard admits — the
  // entry 16 min into a 70 min cell — and reads the deadline out of the budget verdict the
  // bound-ended adversary produced. 2520 s of spend is exactly where `leanStepBound` first
  // shortens a 45-minute row, so this is the tightest row that is also admissible.
  const armed: BudgetOpts[] = [];
  const AT_CH = PANEL_START_MS + 960_000;
  const DEADLINE_CH = AT_CH + 2520_000 + 20 * 60_000;
  const BOUND_CH = DEADLINE_CH - AT_CH - GOLDEN_ALLOWANCE_MS - GOLDEN_GRACE_MS;
  let r!: Awaited<ReturnType<typeof runChallenge>>;
  await withEnv(env, async () => {
    r = await runChallenge({
      issue: 2681,
      challengeMinutes: 45,
      deadlineMs: DEADLINE_CH,
      challengeAt: AT_CH,
      // An adversary with nothing to submit is a `none` the step returns WITHOUT dispatching,
      // so the row can only be scored on a child that was really sent.
      child: (wt) => put(wt, EDGE, redEdge(EDGE)),
      toolUses: () => [submit("AC1", [EDGE])],
      // The child the bound ended, so the step's verdict is the budget stop the clause rides on.
      dispatchResults: () => KILLED,
      // The share the skip guard measures runs from the cell's start, and the fixture's default
      // entries (epoch seconds 2–4) read as 47.6 BILLION seconds spent against a real-epoch
      // deadline — every panel-shaped row must state the cell it lives in.
      cellStartedAt: PANEL_START_MS,
      specifySeconds: 1312,
      buildSeconds: 287,
      armedOpts: armed,
    });
  });
  assert(
    r.threw === undefined,
    `(challenge kill) the step ran on the deadline row: ${r.threw?.message ?? "clean"}`,
  );
  assert(
    r.dispatched === 1,
    `(challenge kill) the adversary was dispatched (${String(r.dispatched)})`,
  );
  arms("(challenge kill)", armed[0], BOUND_CH);
  assert(
    r.outcome?.kind === "budget",
    `(challenge kill) the round the bound ended is the step's budget verdict, not an infra throw (kind ${String(r.outcome?.kind)}, throw ${String(r.threw?.message)})`,
  );
  reason("(challenge kill)", r.outcome?.reason, "challenge");
}

// ── specify's first child killed: the verdict reason names the deadline ──────
{
  // `specify-attempt.ts:245` composes the clause for the first dispatch; nothing else in the
  // repo reads that line's output, so this is the only thing standing between a deleted clause
  // body and a green suite.
  const armed: BudgetOpts[] = [];
  const repo = makeRepo({ "src/retry.ts": "export const retry = 1;\n" });
  const cfg = defaultConfig();
  cfg.budgets.specify = { turns: 0, tokens: 0, minutes: 45 };
  cfg.verify = { fast: "true", test: "sh {file}" };
  let r!: Awaited<ReturnType<typeof runSpecify>>;
  await withEnv(env, async () => {
    r = await runSpecify({
      issue: 2685,
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
      dispatchResults: () => KILLED,
      armedOpts: armed,
    });
  });
  assert(
    r.dispatched === 1,
    `(specify kill) the adversary was dispatched (${String(r.dispatched)})`,
  );
  arms("(specify kill)", armed[0], EXPECT_BOUND);
  assert(
    r.outcome?.kind === "budget",
    `(specify kill) the child the bound ended is the step's budget verdict, not an infra throw (kind ${String(r.outcome?.kind)}, throw ${String(r.threw?.message)})`,
  );
  reason("(specify kill)", r.outcome?.reason, "specify");
}

// ── specify's re-ask killed: the re-ask's own stop names the deadline ───────
{
  // `specify-attempt.ts:297` is the re-ask's clause site, reached through the real step: the first
  // child submits AC1 only, so the attempt asks once more for AC2, and THAT child is the one the
  // bound ends. The reason the step finally records is what production composed — the same site as
  // the first-child case, a different branch of the same function, and a different `args.bound` read.
  // The kill cause and the child's usage are what keep it on the budget-stop path rather than the
  // provider-fault path: `didNoWork` calls a dead child idle only at `turns <= 1` AND no tool calls,
  // and this child had streamed before the bound fired.
  const armed: BudgetOpts[] = [];
  const repo = makeRepo({ "src/retry.ts": "export const retry = 1;\n" });
  const cfg = defaultConfig();
  cfg.budgets.specify = { turns: 0, tokens: 0, minutes: 45 };
  cfg.verify = { fast: "true", test: "sh {file}" };
  const TEST_TWO = "tests/AC2-retry.test.sh";
  let r!: Awaited<ReturnType<typeof runSpecify>>;
  await withEnv(env, async () => {
    r = await runSpecify({
      issue: 2687,
      repoRoot: repo.repoRoot,
      baseSha: repo.baseSha,
      specBody: specBody(["AC1", "AC2"]),
      config: cfg,
      writes: (wt, n) => {
        if (n === 1) writeTest(wt, redScript());
      },
      // The first child declares AC1 only, which is what makes the attempt re-ask; the re-ask
      // declares AC2, and its declared row is what the stop's cost row is read from.
      toolUses: (n) =>
        n === 1 ? [submit("AC1", [TEST_ONE])] : [submit("AC2", [TEST_TWO])],
      // The second child — the re-ask — is the one the deadline's bound ended.
      dispatchResults: (n) => (n === 2 ? KILLED : undefined),
      clock: { now: () => AT, deadlineMs: DEADLINE },
      stepStartedAt: AT,
      armedOpts: armed,
    });
  });
  assert(
    r.threw === undefined,
    `(re-ask kill) the step ran on the deadline row: ${r.threw?.message ?? "clean"}`,
  );
  // THREE, not two: the re-ask the bound ended is dispatch 2, and its stop ends the ATTEMPT, which
  // the step then pays for a retry of (dispatch 3). The assertion below reads dispatch index 1 — the
  // re-ask — so the pair it scores is the one the re-ask branch armed, not the first child's.
  assert(
    r.dispatched === 3,
    `(re-ask kill) the child was re-asked, that child was bounded, and the step paid its retry (${String(r.dispatched)} dispatches)`,
  );
  arms("(re-ask kill) first child", armed[0], EXPECT_BOUND);
  arms("(re-ask kill) re-asked child", armed[1], EXPECT_BOUND);
  assert(
    r.outcome?.kind === "budget",
    `(re-ask kill) the re-ask the bound ended is the step's budget verdict, not an infra throw (kind ${String(r.outcome?.kind)}, throw ${String(r.threw?.message)})`,
  );
  assert(
    (r.outcome?.dispatches ?? []).length >= 2,
    `(re-ask kill) and the dispatches it paid for are billed to the step (${String((r.outcome?.dispatches ?? []).length)})`,
  );
  reason("(re-ask kill)", r.outcome?.reason, "specify");
}

process.exit(failures() === 0 ? 0 : 1);
