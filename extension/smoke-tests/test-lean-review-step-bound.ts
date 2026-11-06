#!/usr/bin/env bun
/**
 * #2066 — the `review` STEP as a whole respects its minutes budget (AC1, AC4, R9).
 *
 * `budgets.review.minutes` armed every CHILD and bounded none of them as a step: the
 * step buys its passes, six lens children and a fixer serially, each under its own
 * per-child bound, so a field run spent 69 of its ~89 minutes here and handed a clean,
 * mergeable PR back at the deadline with publish, ci and land never started.
 *
 * R9 is what makes the red line mean something rather than a fixture artefact, so (a)
 * and (b) are a pair on ONE clock and ONE set of stubs: past the ceiling the bound
 * stops the step buying anyone, and with the bound off (`budgets.review.minutes: 0`) the
 * same stubs buy the FULL roster. Every child that runs reports a duration below its OWN
 * bound — the defect's signature; the rigs come from `lib/lean-review-bound-fixtures.ts`.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { defaultConfig } from "../src/lean/config.ts";
import { ADVERSARIAL_GATE_ROLE } from "../src/lean/review-gates.ts";
import { FIXER_ROLE } from "../src/lean/step-budget.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  blockingFinding,
  carriedLensRound,
  cleanupRoots,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
  parsedRound,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { CHILD_MS, MIN, cfg, ctxWithPr, slowDeps } from "./lib/lean-review-bound-fixtures.ts";

const { assert, failures } = makeAssert();
const SHIPPED = defaultConfig().budgets.review?.minutes ?? 30;
// (a) AC1: at a clock past its budget the step pays for NO child — red at base, where
// the whole roster was bought at this very clock.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const bounded = slowDeps({});
  const { threw } = await runStep(
    ctxWithPr(repoRoot, baseSha, BRANCH, { startedAt: 0, now: () => SHIPPED * MIN }),
    // `loadConfig` is passed separately: merging it into the deps object AFTER the
    // stubs were built is what silently un-armed them — the step read the shipped
    // budget, but the case read counters off a copy nothing called.
    { ...bounded, loadConfig: async () => cfg(SHIPPED) },
  );
  assert(
    threw instanceof ReviewInfraError &&
      new RegExp(`STEP stopped: minutes budget ${String(SHIPPED)} exceeded`).test(
        String(threw.message),
      ),
    `(a) the step's OWN clock stops it at \`budgets.review.minutes\`, and the cause names the MINUTES lever with the operator's own number, not the deadline's (${threw?.message ?? "no throw"})`,
  );
  assert(
    bounded.lenses === 0 && bounded.gates <= 1,
    `(a) and it paid for NO lens child and no further arm — at base the full six-lens round ran here (${String(bounded.gates)} gate, ${String(bounded.lenses)} lens)`,
  );
  assert(
    CHILD_MS < 20 * MIN,
    `(a) precondition: every child that ran reported ${String(CHILD_MS)} ms, inside the TIGHTEST per-child bound the step arms (the fixer's 20 min), so this is a STEP bound and never a child running long`,
  );
}

// ── (b) R9 non-vacuity: same stubs, same clock past the ceiling, bound disabled.
// Nothing may stop the step and the whole roster must be bought — which is what
// proves (a) was the bound and not a stub always too cheap to exhaust it.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const unbounded = slowDeps({});
  const { outcome, threw } = await runStep(
    ctxWithPr(repoRoot, baseSha, BRANCH, { startedAt: 0, now: () => SHIPPED * MIN }),
    { ...unbounded, loadConfig: async () => cfg(0) },
  );
  assert(
    threw === undefined &&
      outcome?.kind === "done" &&
      unbounded.gates === 1 &&
      unbounded.lenses === 6 &&
      (outcome?.dispatches?.length ?? 0) === 7, // 1 gate row + 6 lens rows
    `(b) with the bound disabled the same slow reviewers run the step to a clean pass and buy it IN FULL — one adversarial pass, six lens children, no re-review for a branch with no fix wave, all seven on the cost record (got kind ${String(outcome?.kind)}, ${String(unbounded.gates)} gate, ${String(unbounded.lenses)} lens, ${String(outcome?.dispatches?.length)} rows; threw ${threw?.message ?? "nothing"})`,
  );
  assert(
    (outcome?.dispatches ?? []).some((r) => r.role === ADVERSARIAL_GATE_ROLE) &&
      unbounded.gates > 0 &&
      unbounded.lenses > 0,
    `(b) canary: a roster the case never bought cannot pass it either — the gate and lens stubs both ran, and both roles are on the record (${JSON.stringify((outcome?.dispatches ?? []).map((r) => r.role))})`,
  );
}

// ── (c) AC4: a step that finishes inside its bound is today's outcome exactly, on
// both routed kinds — including the fixer's row still reaching the record.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const commit = fixerThatCommits("unbound-wave");
  const inside = () => ctxWithPr(repoRoot, baseSha, BRANCH, { startedAt: 0, now: () => 2 * MIN });
  const clean = await runStep(inside(), { ...slowDeps(), dispatch: async (spec) => commit(spec) });
  assert(
    clean.threw === undefined &&
      clean.outcome?.kind === "done" &&
      clean.outcome.reviewBound === undefined,
    `(c) a review inside its bound returns today's outcome exactly — same kind, no \`reviewBound\` key at all (${clean.threw?.message ?? JSON.stringify(clean.outcome?.reviewBound)})`,
  );
  const wave = await runStep(
    inside(),
    depsWith({
      loadConfig: async () => cfg(SHIPPED),
      adversarial: async (a) =>
        result({
          loopOutcome: a.wave === "full" ? "rejected" : "approved",
          text: "1. leak",
          adversarialRounds: parsedRound(a.wave === "full" ? "CRITICAL_ISSUES_FOUND" : "APPROVED"),
          ms: CHILD_MS,
        }),
      // The full round BLOCKS (its CRITICAL verdict is what buys the wave) and the
      // re-review answers the fix: an empty ISSUES_FOUND round, stamped with the
      // range the step named — which is the production layer's own shape.
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "ISSUES_FOUND", [])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: async (spec) => commit(spec),
    }),
  );
  const fixer = (wave.outcome?.dispatches ?? []).filter((r) => r.role === FIXER_ROLE);
  assert(
    wave.threw === undefined &&
      wave.outcome?.kind === "fixed" &&
      fixer.length === 1 &&
      fixer[0]?.runId !== undefined &&
      wave.outcome.reviewBound === undefined,
    `(c) and the fix path is unchanged too: one wave, \`fixed\`, the fixer's row on the record with its tree identity, and still no bound key (${wave.threw?.message ?? `kind ${String(wave.outcome?.kind)}, ${String(fixer.length)} fixer row(s) at runId ${String(fixer[0]?.runId)}`})`,
  );
}

cleanupRoots();
process.exit(failures());
