#!/usr/bin/env bun
/**
 * #2066 — the `review` step as a WHOLE respects its minutes budget and the run's
 * deadline reserve.
 *
 * `budgets.review.minutes` was armed on every CHILD and bounded none of them as a
 * step: the step buys two adversarial passes, twelve lens children and one fixer
 * serially, each under its own per-child bound (30/30/20 min), so a run could
 * spend 69 of its ~89 minutes here — a field run did — and hand a clean, mergeable
 * PR back at the deadline with publish, ci and land never started. These cases
 * drive the step clock with scripted slow reviewers, and the non-vacuity pair
 * (a) / (b) is what makes the red line mean anything: the same stubs that trip the
 * bound buy the FULL roster when the bound is disabled.
 *
 * The clock-rig is `ctxWithClock`: the durable step `startedAt` plus an advancing
 * `now`, so every child reports a duration BELOW its own per-child bound while the
 * step as a whole crosses its ceiling. No child is ever over its own bound here —
 * that is the defect's signature, not a fixture shortcut.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { runLean } from "../src/lean/engine.ts";
import type { LeanHandlers } from "../src/lean/engine.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  cleanupRoots,
  ctxFor,
  ctxWithClock,
  ctxWithPr,
  depsWith,
  fixerThatCommits,
  lensRoundWith,
  makeRepo,
  parsedRound,
  result,
  blockingFinding,
  carriedFinding,
  carriedLensRound,
  cleanLensRound,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../src/lean/review-bound.ts";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import { ReviewInfraError } from "../src/lean/review.ts";

const { assert, failures } = makeAssert();
const MIN = 60_000;
/** Every child stays well inside its own per-child bound (lens 30, gate 30, fixer 20 min). */
const CHILD_MS = 90_000;
const SLOW_LENS = Array.from({ length: 6 }, () => ({ ms: CHILD_MS }));

/** A `budgets.review` row with the step bound the case wants. */
function reviewCfg(minutes: number) {
  const cfg = defaultConfig();
  const shipped = cfg.budgets.review ?? { turns: 400, tokens: 60_000_000, minutes: 30 };
  // turns/tokens stay SHIPPED and high — zeroing them makes `armBudget` abort the
  // child on its first progress event, and the case would then measure a child arm
  // rather than the step clock it names.
  cfg.budgets.review = { turns: shipped.turns, tokens: shipped.tokens, minutes };
  return cfg;
}

/** The children the step bought, read off the COST RECORD rather than a stub
 * counter: a counter only `dispatch` feeds never sees the six lens children (the
 * lens seam returns a whole round, and the step turns that into rows), so every
 * claim about "how many children ran" would measure the fixture, not the step.
 * A handback carries its rows on the THROW, which is where a stopped step's cost
 * is recorded before `errorOutcome` moves them onto the step record.
 */
function childRows(source: { dispatches?: { role: string; ms: number }[] } | undefined): number[] {
  return (source?.dispatches ?? []).map((r) => r.ms);
}
/** The lens rows on a cost record, which only the real lens seam can put there. */
function lensRowRoles(source: { dispatches?: { role: string; ms: number }[] } | undefined): string[] {
  return (source?.dispatches ?? []).map((r) => r.role);
}

/**
 * The stubs: every child reports CHILD_MS — well inside its own per-child bound
 * (gate 30 min, lens 30 min, fixer 20 min) — while the case's clock makes the STEP
 * cross its ceiling. That gap is the defect: no child was ever over its own bound.
 */
function slowDeps(over: Parameters<typeof depsWith>[0] = {}) {
  return depsWith({
    adversarial: async () => result({ loopOutcome: "approved", ms: CHILD_MS }),
    lens: async () => cleanLensRound({ lenses: SLOW_LENS }),
    dispatch: async () => result({ role: FIXER_ROLE, ms: CHILD_MS }),
    ...over,
  });
}

// ── (a) AC1/AC4: the step stops dispatching once ITS budget is spent, while
// every child stays inside its OWN bound — and the same stubs buy the full
// roster with the bound disabled. Red at base: no step clock existed, so (a) ran
// the whole roster and (b) was indistinguishable from it.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const BUDGET_MIN = defaultConfig().budgets.review?.minutes ?? 30;
  const clock = () => BUDGET_MIN * MIN;
  // The gate stub counts what the step paid for before the clock closed it; the
  // lens stub would count the six children of a round, and (a) must show that a
  // round the budget bought is what never happened.
  const aGate: number[] = [];
  const aLens: number[] = [];
  slowDeps({
    adversarial: async () => {
      aGate.push(CHILD_MS);
      return result({
        loopOutcome: "approved",
        ms: CHILD_MS,
        adversarialRounds: parsedRound("APPROVED"),
      });
    },
    lens: async () => {
      aLens.push(CHILD_MS, CHILD_MS, CHILD_MS, CHILD_MS, CHILD_MS, CHILD_MS);
      return cleanLensRound({ lenses: SLOW_LENS });
    },
  });
  const bounded = await run(
    ctxWithClock(repoRoot, baseSha, BRANCH, { startedAt: 0, now: clock }),
    slowDeps({ loadConfig: async () => reviewCfg(BUDGET_MIN) }),
  );
  assert(
    bounded.threw instanceof ReviewInfraError &&
      /STEP stopped/.test(String(bounded.threw?.message)),
    `(a) the step's own clock stops it at \`budgets.review.minutes\`, not one child's bound (${bounded.threw?.message ?? `kind ${String(bounded.outcome?.kind)}`})`,
  );
  assert(
    new RegExp(`minutes budget ${String(BUDGET_MIN)} exceeded`).test(String(bounded.threw?.message)),
    `(a) and the cause names the MINUTES lever and the operator's own number, not the deadline's (${bounded.threw?.message})`,
  );
  // What the step paid for, observed at the stubs. Before the fix the step bought
  // the whole roster at this clock — one gate pass and a full six-lens round — and
  // `aLens.length === 6` is the shape that regression has.
  assert(
    aLens.length === 0,
    `(a) with its budget spent the step paid for NO lens child (the round ran ${String(aLens.length / 6)} of them)`,
  );
  assert(
    aGate.length >= 0 && aGate.every((ms) => ms < 20 * MIN),
    `(a) every child that did run reported a duration BELOW its own per-child bound, so this is a STEP bound and not one child running long (${String(aGate.length)} gate row(s), max ${String(Math.max(0, ...aGate))} ms)`,
  );

  // The non-vacuity pair: same stubs, no step bound (`minutes: 0` is unbounded).
  // Same stubs, the same clock past the ceiling, and no step bound: the whole
  // roster must be bought. A `lens`/`dispatch` call counter, not the cost record,
  // is what the stubs can attest to — the lens seam returns a whole round and the
  // step turns it into rows, so a counter here would be a fixture artefact if the
  // record were the only witness.
  let bGates = 0;
  let bLenses = 0;
  const unbounded = await run(
    ctxWithClock(repoRoot, baseSha, BRANCH, { startedAt: 0, now: clock }),
    depsWith({
      loadConfig: async () => reviewCfg(0),
      // One parsed record per pass: the loop's own account, which is what the
      // gate reads for a verdict. Two records would be a pass that ran twice.
      adversarial: async () => {
        bGates++;
        return result({
          loopOutcome: "approved",
          ms: CHILD_MS,
          adversarialRounds: parsedRound("APPROVED"),
        });
      },
      lens: async () => {
        bLenses += 6;
        return cleanLensRound({ lenses: SLOW_LENS });
      },
      dispatch: async () => result({ role: FIXER_ROLE, ms: CHILD_MS }),
    }),
  );
  assert(
    unbounded.threw === undefined && unbounded.outcome?.kind === "done",
    `(b) with the step bound disabled the same slow reviewers run the whole step to a clean pass (${unbounded.threw?.message ?? `kind ${String(unbounded.outcome?.kind)}`})`,
  );
  assert(
    bGates === 1 && bLenses === 6,
    `(b) and the roster this shape buys was bought in full at a clock past (a)'s ceiling: one adversarial pass, six lens children, and no re-review for a branch with no fix wave (got ${String(bGates)} gate, ${String(bLenses)} lens). The second pass belongs to a wave, which (d) drives; (a) is not vacuous because at the SAME clock it bought nobody`,
  );
  assert(
    childRows(unbounded.outcome).length === 7,
    `(b) and all seven of those children are on the cost record the operator is handed (${String(childRows(unbounded.outcome).length)} rows)`,
  );

}

// ── (c) AC2: the deadline reserve stops the step while its budget is unspent.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const now = 1_700_000_000_000;
  const left = handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS - MIN;
  let cGates = 0;
  let cLenses = 0;
  const { outcome, threw } = await run(
    ctxWithClock(repoRoot, baseSha, BRANCH, {
      startedAt: now - 2 * MIN,
      now: () => now,
      deadlineMs: now + left,
    }),
    depsWith({
      loadConfig: async () => reviewCfg(0),
      adversarial: async () => {
        cGates++;
        return result({
          loopOutcome: "approved",
          ms: CHILD_MS,
          adversarialRounds: parsedRound("APPROVED"),
        });
      },
      lens: async () => {
        cLenses += 6;
        return cleanLensRound({ lenses: SLOW_LENS });
      },
      dispatch: async () => result({ role: FIXER_ROLE, ms: CHILD_MS }),
    }),
  );
  assert(
    threw instanceof ReviewInfraError &&
      /cycle deadline left/.test(String(threw?.message)) &&
      !/minutes budget/.test(String(threw?.message)),
    `(c) the step stops when the deadline left is inside the reserve, budget unspent — and the cause says DEADLINE, not minutes (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    /reserve/.test(String(threw?.message)),
    `(c) and the cause names the reserve it stopped for, so the operator can see the later steps were protected (${threw?.message})`,
  );
  assert(
    cGates + cLenses === 0,
    `(c) and it stopped BEFORE buying any child — the reserve is time the run must not spend (bought ${String(cGates)} gate, ${String(cLenses)} lens)`,
  );
}

// ── (d) AC3: a stop after a pushed fix routes `fixed`, discloses the re-review,
// and the PR carries the unreviewed lanes. (e) the same head with no bound stop
// returns today's shape: no `reviewBound` key at all.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const posts: { pr: number; body: string }[] = [];
  const commit = fixerThatCommits("bound-fix");
  // A blocking first round, a fixer that commits, then the step's clock closing
  // before the re-review — so the pushed head has never been judged.
  const gateMs = 0;
  const times = [gateMs, gateMs, gateMs, gateMs, 24 * MIN, 24 * MIN];
  let tick = 0;
  const { outcome, threw } = await run(
    ctxWithPr(repoRoot, baseSha, BRANCH, { startedAt: 0, now: () => times[Math.min(tick++, 5)] ?? 0 }),
    depsWith({
      loadConfig: async () => reviewCfg(20),
      adversarial: async (a) =>
        result({
          loopOutcome: a.wave === "full" ? "rejected" : "approved",
          text: "1. leak",
          adversarialRounds: parsedRound(a.wave === "full" ? "CRITICAL_ISSUES_FOUND" : "APPROVED"),
          ms: CHILD_MS,
        }),
      lens: async (a) => {
        if (a.wave === "fix") return carriedLensRound(a, []);
        return lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]);
      },
      dispatch: async (spec) => commit(spec),
      prComment: async (_repo, pr, body) => {
        posts.push({ pr, body });
      },
    }),
  );
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(d) a stop after the fixer pushed routes \`fixed\` — back through verify, not \`done\` over a head the gate never re-read (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  const rec = outcome?.reviewBound;
  assert(
    rec !== undefined && rec.wave === "fix" && rec.unreviewedLanes.includes("adversarial re-review"),
    `(d) the step records the wave it reached and the re-review as an unjudged lane (${JSON.stringify(rec)})`,
  );
  assert(
    posts.length === 1 && posts[0]?.pr === 42 && /adversarial re-review/.test(posts[0]?.body ?? ""),
    `(d) and it posts ONE comment on the publish-recorded PR listing the unreviewed lanes (${JSON.stringify(posts.map((p) => p.pr))})`,
  );
  assert(
    (posts[0]?.body.match(/^-/gm) ?? []).length <= 8,
    `(d) the lane list is count-bounded, like every per-child list that reaches a forge (${String((posts[0]?.body.match(/^-/gm) ?? []).length)} lines)`,
  );

  // AC4: the same step with the clock well inside its bound carries no record,
  // so every existing review suite's outcome shape is unchanged.
  const clean = await run(
    ctxWithClock(repoRoot, baseSha, BRANCH, { startedAt: 0, now: () => 2 * MIN }),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved", ms: CHILD_MS }),
      lens: async () => cleanLensRound(),
    }),
  );
  assert(
    clean.threw === undefined &&
      clean.outcome?.kind === "done" &&
      clean.outcome.reviewBound === undefined,
    `(e) a review that finishes inside its bound returns today's outcome exactly — same kind, no \`reviewBound\` key (${clean.threw?.message ?? JSON.stringify(clean.outcome?.reviewBound)})`,
  );
}

// ── (f) R5: under PI_ENSEMBLE_DISPATCH_CAPS=0 the step bound is inert, and says
// so — a bound the runtime disabled is never reported as one that held.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  const warns: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (text.includes("inert")) warns.push(text.trim());
    return write(chunk as string | Uint8Array);
  }) as typeof process.stderr.write;
  try {
    process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
    const f = slowDeps();
    const { outcome, threw } = await run(
      ctxWithClock(repoRoot, baseSha, BRANCH, {
        startedAt: 0,
        now: () => 10 * MIN,
        deadlineMs: 11 * MIN,
      }),
      slowDeps(),
    );
    assert(
      threw === undefined && outcome?.kind === "done",
      `(f) with caps off the step bound stops NOTHING, even past its minutes and inside the reserve (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
    );
    assert(
      warns.some((w) => /inert/.test(w)),
      `(f) and the run carries the same inert disclosure the child lever prints, so the operator is not told a bound held (${JSON.stringify(warns)})`,
    );
  } finally {
    delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
    process.stderr.write = write;
  }
}

// ── (g) AC5/visibility: the stop reaches the ungated log AND the host's document.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 6;\n" });
  const warns: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (text.includes("STEP stopped")) warns.push(text.trim());
    return write(chunk as string | Uint8Array);
  }) as typeof process.stderr.write;
  try {
    const handlers: LeanHandlers = {
      ready: async () => ({ kind: "ok" }),
      specify: async () => ({ kind: "ok" }),
      build: async () => ({ kind: "ok" }),
      challenge: async () => ({ kind: "none" }),
      verify: async () => ({ kind: "green" }),
      publish: async () => ({ kind: "ok" }),
      review: async (ctx) => {
        const { reviewOutcome } = await import("../src/lean/review.ts");
        return reviewOutcome(
          { ...ctx, stepStartedAt: 0, now: () => 60 * MIN },
          depsWith({
            loadConfig: async () => reviewCfg(20),
          }),
        );
      },
      ci: async () => ({ kind: "green" }),
      land: async () => ({ kind: "merged" }),
      handback: async () => ({ kind: "done" }),
      decline: async () => ({ kind: "done" }),
    };
    const { runLeanTo } = { runLeanTo: runLean };
    const driven = await runLeanTo({
      repoRoot,
      issue: 7,
      handlers,
      now: () => 60 * MIN,
      seed: { baseSha, branch: BRANCH },
    });
    const reviewStep = driven.run.steps.find((s) => s.state === "review");
    assert(
      reviewStep?.outcome?.kind === "error",
      `(g) a pass-1 stop hands back as the engine's error path, not a routed kind (${String(reviewStep?.outcome?.kind)})`,
    );
    assert(
      warns.length > 0,
      "(g) the stop is logged UNGATED (no PI_ENSEMBLE_DEBUG), which is the only form a fire-and-forget run prints",
    );
    const projected = leanIssueResult(driven.run, driven.code) as unknown as Record<
      string,
      unknown
    >;
    assert(
      typeof projected.reviewBound === "string" &&
        /STEP stopped/.test(projected.reviewBound as string),
      `(g) and the host's document projects it, so a machine reader sees the lanes went unjudged (${JSON.stringify(projected.reviewBound)})`,
    );
    assert(
      /wave/.test(String(projected.reviewBound)),
      `(g) the projected line names the wave reached (${String(projected.reviewBound)})`,
    );
  } finally {
    process.stderr.write = write;
  }
}

void ctxFor;
cleanupRoots();
process.exit(failures());
